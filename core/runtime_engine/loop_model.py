"""Provider windows, context continuation, native protocols and final synthesis."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from agent.llm.schemas import LLMMessage, LLMResponse, LLMToolCall

from .context_budget import estimate_json_tokens, estimate_text_tokens
from .context_compaction import estimate_message_tokens as _estimate_message_tokens
from .context_continuation import ContextContinuationError
from .evidence import evidence_manifest, mark_evidence_delivered, pending_llm_evidence
from .loop_errors import _normalize_llm_error
from .loop_messages import (
    FINAL_SYNTHESIS_CHECKPOINT_MARKER,
    SYNTHESIS_CHECKPOINT_MARKER,
    StreamingToolResult,
    _redact_tool_error,
)
from .models import StatelessContext
from .prompt_contract import build_runtime_system_prompt, build_turn_message
from .tracking import extract_tracking_payload, normalize_tracking_payload

_LOG = logging.getLogger(__name__)


class LoopModelGateway:
    """Provider windows, context continuation, native protocols and final synthesis. Shared context belongs to the QueryLoop driver."""

    def _build_initial(
        self, ctx: StatelessContext, *, include_history: bool = True
    ) -> list[LLMMessage]:
        """Build initial messages with cacheable prefix."""
        from .prompt_contract import (
            TrustedPromptItem,
            resolve_capability_playbooks,
            runtime_clock_prompt_item,
            trusted_prompt_item,
        )

        conversation_block = (
            (ctx.extras.get("conversation_history_block") or "")
            if include_history
            else ""
        )
        retrieved_block = (
            (ctx.extras.get("retrieved_context_block") or "") if include_history else ""
        )
        operational_hint = ctx.extras.get("operational_clarification") or {}
        trusted_items = [runtime_clock_prompt_item()]
        trusted_items.extend(
            [
                item
                for item in (ctx.extras.get("trusted_prompt_items") or [])
                if isinstance(item, TrustedPromptItem)
            ]
        )
        if isinstance(operational_hint, dict):
            guidance = str(operational_hint.get("guidance") or "").strip()
            if guidance:
                trusted_items.append(trusted_prompt_item("operational_guard", guidance))
        trusted_items.extend(
            resolve_capability_playbooks(
                ctx.user_input,
                attachments=ctx.extras.get("attachments") or (),
            )
        )
        ctx.extras["active_capability_playbooks"] = [
            item.label
            for item in trusted_items
            if item.source_kind == "capability_playbook"
        ]

        return [
            LLMMessage(
                role="system",
                content=build_runtime_system_prompt(ctx.extras),
            ),
            LLMMessage(
                role="user",
                content=build_turn_message(
                    workspace_id=ctx.workspace_id,
                    session_id=ctx.session_id,
                    user_input=ctx.user_input,
                    conversation_history=str(conversation_block),
                    governed_context=str(retrieved_block),
                    trusted_context_items=trusted_items,
                ),
            ),
        ]

    @staticmethod
    def _refresh_cognitive_prompt_state(
        messages: list[LLMMessage],
        ctx: StatelessContext,
    ) -> None:
        """Append changed server-owned CognitiveState projections in causal order.

        The conversation is append-only: rewriting a prior user turn with
        current tool evidence both reverses causality and invalidates the
        mutable portion of provider prompt caches.
        """
        from .prompt_contract import (
            cognitive_state_prompt_item,
            render_trusted_prompt_item,
        )

        item = cognitive_state_prompt_item(ctx.extras.get("cognitive_state"))
        if item is None:
            return
        rendered = render_trusted_prompt_item(item)
        if str(ctx.extras.get("_cognitive_prompt_projection") or "") == rendered:
            return
        messages.append(LLMMessage(role="user", content=rendered))
        ctx.extras["_cognitive_prompt_projection"] = rendered

    @staticmethod
    def _unique_call_ids(
        tool_calls: list[LLMToolCall],
        iteration: int,
        used: set[str],
    ) -> list[LLMToolCall]:
        """Keep provider call ids unique across iterative LLM rounds."""
        result: list[LLMToolCall] = []
        for index, tc in enumerate(tool_calls):
            base = str(tc.id or f"call_{index}")
            candidate = base
            suffix = 0
            while candidate in used:
                suffix += 1
                candidate = f"{base}_i{iteration}_{suffix}"
            used.add(candidate)
            result.append(
                LLMToolCall(
                    id=candidate,
                    name=tc.name,
                    arguments=dict(tc.arguments or {}),
                    step_id=(candidate if tc.step_id == base else tc.step_id),
                    depends_on=list(tc.depends_on),
                    result_bindings=dict(tc.result_bindings),
                    failure_policy=tc.failure_policy,
                    goal_ids=list(tc.goal_ids),
                )
            )
        return result

    async def _call_llm(
        self,
        messages: list[LLMMessage],
        ctx: StatelessContext,
        *,
        tools_override: list[dict[str, Any]] | None = None,
    ) -> LLMResponse | None:
        """Call LLM with tools and streaming support.

        Wraps the synchronous LLM call with asyncio.wait_for + asyncio.to_thread
        to guarantee a hard timeout and prevent event-loop blocking.
        """
        try:
            provider_timeout_seconds = max(
                1.0, self._config.llm_call_timeout_ms / 1000.0
            )
            provider_guard_seconds = max(0.0, self._config.llm_call_guard_ms / 1000.0)
            system_prompt, stream_scope, stream_to_user = self._llm_call_mode(
                messages, ctx
            )
            self._refresh_cognitive_prompt_state(messages, ctx)
            # Response nudges are an instruction to synthesize now, not a
            # second fast-path or capability downgrade. Every LLM turn keeps
            # the same visible tool surface; the model may still choose a
            # necessary safe verification action.
            tools_for_call = (
                self._cached_tools if tools_override is None else tools_override
            )
            # Provider windows and durable task history are separate. Reserve
            # system/schema/output capacity before choosing a complete epoch.
            # A failed archive never permits evidence deletion or tool replay.
            available_tokens = (
                self._context_budget.context_window_tokens
                - self._context_budget.reserved_output_tokens
                - self._context_budget.safety_tokens
                - estimate_json_tokens(tools_for_call)
                - estimate_text_tokens(system_prompt)
            )
            if self._context_continuation is not None:
                try:
                    # The configured message window is a preferred checkpoint
                    # boundary. Exact governing anchors retain the full actual
                    # provider allowance; no valid user input is truncated or
                    # rejected merely to meet this operational window target.
                    preferred = min(
                        available_tokens, self._context_budget.message_tokens
                    )
                    try:
                        self._context_continuation.prepare(
                            messages, ctx, max(0, int(preferred * 0.85))
                        )
                    except ContextContinuationError as exc:
                        if str(exc) != "context_continuation_anchors_exceed_capacity":
                            raise
                        self._context_continuation.prepare(
                            messages, ctx, max(0, int(available_tokens))
                        )
                except ContextContinuationError as exc:
                    ctx.extras["context_continuation_error"] = str(exc)
                    if str(exc) == "context_epoch_has_unsettled_tools":
                        return LLMResponse(error="context_checkpoint_failed")
                except (OSError, ValueError) as exc:
                    ctx.extras["context_continuation_error"] = type(exc).__name__
                    return LLMResponse(error="context_checkpoint_failed")
            estimated_tokens = _estimate_message_tokens(messages)
            if estimated_tokens > available_tokens:
                ctx.extras["context_capacity"] = {
                    "estimated_input_tokens": estimated_tokens,
                    "available_input_tokens": available_tokens,
                    "messages_preserved": True,
                }
                return LLMResponse(error="context_capacity_exceeded")
            evidence_for_call = pending_llm_evidence(ctx.extras)
            if self._llm_invoke is not None:
                raw = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._llm_invoke,
                        system=system_prompt,
                        user=self._messages_to_user_text(messages),
                        messages=list(messages),
                        timeout=provider_timeout_seconds,
                        tools=tools_for_call,
                        workspace_id=ctx.workspace_id,
                        session_id=ctx.session_id,
                        extra={
                            "runtime_engine": "ssot_runtime",
                            "stream_scope": stream_scope,
                            "stream_to_user": stream_to_user,
                            "workspace_id": ctx.workspace_id,
                            "session_id": ctx.session_id,
                            # Server-owned execution control is deliberately
                            # kept outside prompt/request metadata. The LLM
                            # runtime transfers it to LLMRequest only when it is
                            # callable, and providers observe it while streaming.
                            "__runtime_cancel_check": (
                                ctx.extras.get("cancel_check")
                                if callable(ctx.extras.get("cancel_check"))
                                else None
                            ),
                            # Typed references only, never image bytes. The
                            # adapter resolves pending image evidence for this
                            # call; QueryLoop acknowledges it after success.
                            "evidence_parts": evidence_for_call,
                        },
                    ),
                    timeout=(provider_timeout_seconds + provider_guard_seconds),
                )
                response = self._coerce_llm_response(raw)
                if stream_to_user and response.content:
                    from core.tools.redaction import redact_string

                    outputs = ctx.extras.setdefault("stage_outputs", [])
                    outputs.append(
                        {
                            "id": f"model-{len(outputs) + 1}",
                            "label": f"模型输出 {len(outputs) + 1}",
                            "text": redact_string(response.content),
                        }
                    )
                if isinstance(response.usage, dict):
                    ctx.extras.setdefault("llm_usage_events", []).append(
                        dict(response.usage)
                    )
                provider_metadata = response.metadata or {}
                prompt_profile = provider_metadata.get("prompt_assembly")
                if isinstance(prompt_profile, dict):
                    ctx.extras.setdefault("prompt_assembly_events", []).append(
                        prompt_profile
                    )
                if provider_metadata.get("prompt_cache_requested"):
                    ctx.extras.setdefault("prompt_cache_events", []).append(
                        {
                            "requested": True,
                            "fallback": bool(
                                provider_metadata.get("prompt_cache_fallback")
                            ),
                        }
                    )
                policy = (response.metadata or {}).get("prompt_policy")
                if isinstance(policy, dict):
                    ctx.extras.setdefault("prompt_policy_events", []).append(
                        {
                            "stream_scope": stream_scope,
                            "prompt_injection_detected": bool(
                                policy.get("prompt_injection_detected")
                            ),
                            "request_policy_ok": bool(
                                policy.get("request_policy_ok", True)
                            ),
                            "output_policy_ok": bool(
                                policy.get("output_policy_ok", True)
                            ),
                            "response_policy_ok": bool(
                                policy.get("response_policy_ok", True)
                            ),
                            "sensitive_output_redacted": bool(
                                policy.get("sensitive_output_redacted")
                            ),
                        }
                    )
                if response.error:
                    response.metadata = dict(response.metadata or {})
                    response.metadata["provider_failure_diagnostic"] = {
                        "detail": _redact_tool_error(response.error)[:600],
                        "http_status": (response.metadata or {}).get("http_status"),
                        "error_type": str(
                            (response.metadata or {}).get("error_type") or ""
                        )[:100],
                        "request_structure": (response.metadata or {}).get("request_structure", {}),
                    }
                    response.error = _normalize_llm_error(response.error)
                else:
                    mark_evidence_delivered(
                        ctx.extras,
                        list(
                            (response.metadata or {}).get("delivered_evidence_ids")
                            or []
                        ),
                    )
                return response
        except asyncio.TimeoutError:
            self._llm_call_count += 1
            return LLMResponse(error="llm_call_timeout")
        except Exception as e:
            self._llm_call_count += 1  # P1-7: count against budget even on error
            # The SSOT adapter intentionally raises when a provider returns an
            # error without usable content.  Preserve its redacted detail in
            # diagnostics: logging only ``RuntimeError`` turns a recoverable
            # provider/schema problem into an opaque retry loop.
            _LOG.warning(
                "LLM invocation raised %s: %s",
                type(e).__name__,
                _redact_tool_error(e),
            )
            return LLMResponse(
                error=_normalize_llm_error(str(e)),
                metadata={
                    "provider_failure_diagnostic": {
                        "detail": _redact_tool_error(e)[:600],
                        "http_status": None,
                        "error_type": type(e).__name__,
                    },
                },
            )

    async def _recover_final_synthesis(
        self,
        ctx: StatelessContext,
        budget,
    ) -> str:
        """Run one bounded, tool-free synthesis recovery from typed evidence.

        The recovery request is intentionally rebuilt from the original user
        request and the evidence manifest.  It never replays the bloated tool
        transcript and cannot issue duplicate external operations.
        """
        recovery = {
            "attempted": True,
            "tool_access": False,
            "evidence_items": 0,
            "ok": False,
            "error": "",
            "attempts": 0,
            "attempt_errors": [],
        }
        ctx.extras["synthesis_recovery"] = recovery
        if self._is_cancelled(ctx):
            recovery["error"] = "cancelled_by_user"
            return ""
        manifest = evidence_manifest(ctx.extras) if ctx is not None else []
        recovery["evidence_items"] = len(manifest)
        projected, truncated = self._project_synthesis_manifest(manifest)
        recovery["manifest_truncated"] = truncated
        payload = json.dumps(
            projected, ensure_ascii=False, separators=(",", ":"), default=str
        )
        messages = [
            LLMMessage(
                role="system",
                content=(
                    build_runtime_system_prompt(ctx.extras)
                    + "\n\nYou are in the final synthesis phase. Tool use is disabled. "
                    "Use only the supplied typed evidence. Answer the original request completely; "
                    "separate verified conclusions, failed or incomplete observations, and unknowns. "
                    "Cite evidence_id values for important technical claims."
                ),
            ),
            LLMMessage(
                role="user",
                content=(
                    f"{SYNTHESIS_CHECKPOINT_MARKER}\n"
                    f"Original request:\n{ctx.user_input}\n\n"
                    '<evidence_manifest data_only="true" trust="untrusted_data">\n'
                    + payload
                    + "\n</evidence_manifest>"
                ),
            ),
        ]
        # A provider can transiently return an empty or interrupted final
        # response after the expensive work has completed.  Give the LLM one
        # additional tool-free chance to synthesize from the exact same typed
        # evidence.  This is not a deterministic replacement and cannot cause
        # a duplicate device operation.
        for _attempt in range(2):
            status = budget.check_llm_call()
            if not status.ok:
                recovery["error"] = status.exceeded or "llm_budget_exhausted"
                return ""
            recovery["attempts"] += 1
            response = await self._call_llm(messages, ctx, tools_override=[])
            if self._is_cancelled(ctx):
                recovery["error"] = "cancelled_by_user"
                return ""
            if response is None:
                error = "no_response"
            elif response.error:
                error = str(response.error)
            else:
                text = str(response.content or "").strip()
                if text:
                    recovery["ok"] = True
                    recovery["finish_reason"] = str(response.finish_reason or "")
                    return text
                error = "empty_synthesis_response"
            recovery["attempt_errors"].append(error)
            recovery["error"] = error
        return ""

    def _project_synthesis_manifest(
        self,
        manifest: list[dict[str, Any]],
    ) -> tuple[Any, bool]:
        """Return every evidence item exactly as collected for synthesis."""
        return list(manifest), False

    @staticmethod
    def _llm_call_mode(
        messages: list[LLMMessage],
        ctx: StatelessContext,
    ) -> tuple[str, str, bool]:
        synthesis_checkpoint = any(
            message.role == "user"
            and (
                SYNTHESIS_CHECKPOINT_MARKER in str(message.content or "")
                or FINAL_SYNTHESIS_CHECKPOINT_MARKER in str(message.content or "")
            )
            for message in messages[-2:]
        )
        if synthesis_checkpoint:
            return build_runtime_system_prompt(ctx.extras), "response", True

        has_tool_context = any(
            m.role == "tool"
            or (
                m.role == "user"
                and '<auto_tracking_results data_only="true" trust="untrusted_data">'
                in str(m.content or "")
            )
            for m in messages
        )
        if has_tool_context:
            # A tool result is evidence for the next reasoning step, not proof
            # that the workflow is complete. Keep the full execution contract so
            # the model can issue dependent calls, recover from validation
            # errors, or finish naturally.
            return build_runtime_system_prompt(ctx.extras), "continuation", True
        # The first planner call may itself be the final natural-language answer.
        # Keep planner scope for cognition and tool planning, but stream its user-
        # visible content; provider reasoning channels are never mapped to content
        # tokens and the UI additionally filters tagged reasoning.
        return build_runtime_system_prompt(ctx.extras), "planner", True

    @staticmethod
    def _has_final_synthesis_checkpoint(messages: list[LLMMessage]) -> bool:
        return any(
            message.role == "user"
            and FINAL_SYNTHESIS_CHECKPOINT_MARKER in str(message.content or "")
            for message in messages[-2:]
        )

    @staticmethod
    def _producer_requests_final_synthesis(results: list[StreamingToolResult]) -> bool:
        for result in results:
            tracking = extract_tracking_payload(result.output)
            if not tracking:
                continue
            normalized = normalize_tracking_payload(tracking)
            if (
                normalized.get("done")
                and str(normalized.get("suggested_next_action") or "").lower()
                == "synthesize_results"
            ):
                return True
        return False

    def _has_complete_analysis_artifact(
        self,
        results: list[StreamingToolResult],
    ) -> bool:
        """True when a producer supplied complete artifact content."""
        return any(
            result.ok
            and result.output.get("content_complete") is True
            and result.output.get("artifact_type")
            in {
                "input_data",
                "output_data",
                "report",
            }
            and (
                result.tool_name.replace("__", ".") == "workspace.artifact"
                or (
                    result.tool_name.replace("__", ".") == "agent.manage"
                    and result.output.get("subagent_result_complete") is True
                )
            )
            for result in results
        )

    def _messages_to_user_text(self, messages: list[LLMMessage]) -> str:
        """Serialize loop messages for injected LLM adapters.

        The production adapter accepts ``system`` + ``user`` strings, while
        QueryLoop internally keeps OpenAI-style tool messages. This projection
        preserves the relevant context without bypassing the injected adapter.
        """
        parts: list[str] = []
        for m in messages:
            if m.role == "system":
                continue
            label = m.role.upper()
            content = m.content
            if m.tool_calls:
                parts.append(
                    f"{label} TOOL_CALLS: "
                    f"{json.dumps(m.tool_calls, ensure_ascii=False, default=str)}"
                )
            if content:
                parts.append(f"{label}: {content}")
            if m.tool_call_id:
                if parts:
                    parts[-1] = (
                        f"{parts[-1]} (tool_call_id={m.tool_call_id})"  # P2-3: simpler than slice assignment
                    )
        return "\n\n".join(parts)

    def _coerce_llm_response(self, raw: Any) -> LLMResponse:
        """Coerce injected adapter output into QueryLoop's LLMResponse shape.

        Provider finish metadata is retained verbatim so an incomplete stream
        can be continued by the QueryLoop rather than emitted as a final reply.
        """
        if isinstance(raw, LLMResponse):
            if "<think>" in str(raw.content or "") and not raw.protocol:
                raw.protocol = {"openai": {"content": raw.content}}
            raw.content = self._strip_think_tags(str(raw.content or ""))
            return raw
        if raw is None:
            return LLMResponse(error="empty_llm_response")
        tool_calls = getattr(raw, "tool_calls", None)
        if tool_calls is not None:
            return LLMResponse(
                content=self._strip_think_tags(str(getattr(raw, "content", "") or "")),
                error=getattr(raw, "error", None),
                tool_calls=list(tool_calls or []),
            )
        text = self._strip_think_tags(str(raw))
        return LLMResponse(content=text)

    @staticmethod
    def _aggregate_llm_usage(extras: dict[str, Any]) -> dict[str, Any]:
        """Aggregate provider-native usage without hiding cache semantics."""
        input_tokens = 0
        output_tokens = 0
        cache_creation = 0
        cache_read = 0
        for usage in extras.get("llm_usage_events") or []:
            if not isinstance(usage, dict):
                continue
            input_tokens += int(
                usage.get(
                    "logical_input_tokens",
                    usage.get("prompt_tokens", usage.get("input_tokens", 0)),
                )
                or 0
            )
            output_tokens += int(
                usage.get(
                    "normalized_output_tokens",
                    usage.get("completion_tokens", usage.get("output_tokens", 0)),
                )
                or 0
            )
            cache_creation += int(usage.get("cache_creation_input_tokens", 0) or 0)
            cache_read += int(usage.get("cache_read_input_tokens", 0) or 0)
        logical_input = input_tokens
        cache_events = [
            event
            for event in (extras.get("prompt_cache_events") or [])
            if isinstance(event, dict)
        ]
        prompt_profiles = [
            profile
            for profile in (extras.get("prompt_assembly_events") or [])
            if isinstance(profile, dict)
        ]
        latest_profile = prompt_profiles[-1] if prompt_profiles else {}
        prefix_fingerprints = {
            str(profile.get("stable_prefix_fingerprint") or "")
            for profile in prompt_profiles
            if profile.get("stable_prefix_fingerprint")
        }
        return {
            "input_tokens": logical_input,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": cache_creation,
            "cache_read_input_tokens": cache_read,
            "cache_hit_ratio": round(cache_read / max(logical_input, 1), 4),
            "prompt_cache_requested_calls": sum(
                bool(event.get("requested")) for event in cache_events
            ),
            "prompt_cache_fallback_calls": sum(
                bool(event.get("fallback")) for event in cache_events
            ),
            "prompt_cache_strategy": str(latest_profile.get("strategy") or ""),
            "prompt_prefix_fingerprint": str(
                latest_profile.get("stable_prefix_fingerprint") or ""
            ),
            "prompt_prefix_variants": len(prefix_fingerprints),
            "prompt_layers": dict(latest_profile.get("layers") or {}),
        }

    @staticmethod
    def _strip_think_tags(text: str) -> str:
        """Remove ``<think>...</think>`` blocks from LLM output.

        Some models (MiniMax-M3) emit chain-of-thought reasoning inside XML
        tags. We strip the tags and their content before passing the text on.
        """
        return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()

    def _parse_tool_calls(self, raw: list[LLMToolCall]) -> list[LLMToolCall]:
        """Normalise raw tool calls from LLM response (may be dict or LLMToolCall)."""
        result = []
        for tc in raw:
            if isinstance(tc, dict):
                # Raw dict from provider
                args = tc.get("arguments", {})
                tid = tc.get("id", "")
                tname = tc.get("name", "")
            else:
                # LLMToolCall dataclass
                args = getattr(tc, "arguments", {})
                tid = getattr(tc, "id", "")
                tname = getattr(tc, "name", "")

            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError as exc:
                    # Keep malformed provider arguments visible to the
                    # semantic validation/recovery path instead of executing
                    # the call as an ambiguous empty object.
                    args = {"__invalid_tool_arguments_json__": str(exc)[:240]}
                else:
                    if not isinstance(args, dict):
                        args = {
                            "__invalid_tool_arguments_json__": (
                                "tool arguments must decode to a JSON object"
                            ),
                        }

            # Normalise double-underscore to dots
            tname = tname.replace("__", ".")
            if not tid:
                tid = f"call_{len(result)}"
            from .orchestration import extract_orchestration

            args, step_id, depends_on, bindings, failure_policy, goal_ids = (
                extract_orchestration(
                    args,
                    str(tid),
                )
            )
            if not isinstance(tc, dict):
                step_id = str(getattr(tc, "step_id", "") or step_id)
                depends_on = list(getattr(tc, "depends_on", None) or depends_on)
                bindings = dict(getattr(tc, "result_bindings", None) or bindings)
                failure_policy = str(
                    getattr(tc, "failure_policy", "") or failure_policy
                )
                goal_ids = list(getattr(tc, "goal_ids", None) or goal_ids)

            result.append(
                LLMToolCall(
                    id=str(tid),
                    name=tname,
                    arguments=args,
                    step_id=step_id,
                    depends_on=depends_on,
                    result_bindings=bindings,
                    failure_policy=failure_policy,
                    goal_ids=goal_ids,
                )
            )
        return result
