"""SSOT provider boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agent.llm.schemas import LLMMessage

_LOG = logging.getLogger(__name__)


def _invoke_llm_for_ssot_runtime(**kwargs):
    from agent.llm.runtime import invoke_llm, resolve_invocation_candidates
    from agent.runtime.token_tracker import record_llm_call

    system = str(kwargs.get("system") or "")
    user = str(kwargs.get("user") or "")
    runtime_messages = kwargs.get("messages")
    caller_extra = kwargs.get("extra") or {}
    stream_scope = str(caller_extra.get("stream_scope") or "internal").lower()
    is_planner = stream_scope == "planner"
    # Preserve the exact tool list supplied by QueryLoop. QueryLoop keeps tools
    # visible on response/synthesis turns; an empty list should only appear if a
    # caller intentionally supplied one.
    tools = kwargs.get("tools")
    session_id = str(
        kwargs.get("session_id") or caller_extra.get("session_id") or ""
    ).strip()
    workspace_id = str(
        kwargs.get("workspace_id") or caller_extra.get("workspace_id") or ""
    ).strip()

    extra = {
        "runtime_engine": "ssot_runtime",
        "planner": is_planner,
        "stream_to_user": not is_planner,
        "stream_scope": stream_scope,
    }
    if caller_extra:
        extra.update(caller_extra)

    config_override = {}
    timeout = kwargs.get("timeout")
    if timeout is not None:
        config_override["timeout"] = int(timeout)
    temperature = kwargs.get("temperature")
    if temperature is not None:
        config_override["temperature"] = float(temperature)
    max_tokens = kwargs.get("max_tokens")
    if max_tokens is not None:
        config_override["max_tokens"] = int(max_tokens)

    messages = (
        [
            LLMMessage(
                role=str(message.role),
                content=message.content,
                tool_call_id=message.tool_call_id,
                tool_calls=(list(message.tool_calls) if message.tool_calls is not None else None),
                protocol=message.protocol,
            )
            for message in runtime_messages
        ]
        if isinstance(runtime_messages, list)
        and all(isinstance(message, LLMMessage) for message in runtime_messages)
        else [
            LLMMessage(role="system", content=system),
            LLMMessage(role="user", content=user),
        ]
    )

    # QueryLoop supplies only pending typed evidence. Original user images are
    # delivered once on the planner call; images produced by tools are delivered
    # once on the next continuation/synthesis call. Encoded bytes stay ephemeral
    # inside this provider request and never enter metadata, history, or traces.
    if caller_extra.get("evidence_parts"):
        try:
            from agent.llm.capabilities import supports_vision

            effective_config = resolve_invocation_candidates(
                "assistant_chat",
                config_override,
            )[0]
            if supports_vision(effective_config):
                from agent.runtime.vision_inputs import build_vision_content
                from core.runtime_engine.evidence import evidence_to_vision_references

                image_parts: list[dict[str, Any]] = []
                vision_warnings: list[str] = []
                delivered_evidence_ids: list[str] = []
                for evidence_part in caller_extra.get("evidence_parts") or []:
                    references = evidence_to_vision_references([evidence_part])
                    if not references:
                        continue
                    resolved_parts, resolved_warnings = build_vision_content(
                        references, workspace_id
                    )
                    image_parts.extend(resolved_parts)
                    vision_warnings.extend(resolved_warnings)
                    if resolved_parts:
                        delivered_evidence_ids.append(
                            str(evidence_part.get("evidence_id") or "")
                        )
                if image_parts:
                    for index in range(len(messages) - 1, -1, -1):
                        if messages[index].role != "user":
                            continue
                        text_content = messages[index].content
                        if not isinstance(text_content, str):
                            text_content = user
                        messages[index] = LLMMessage(
                            role="user",
                            content=[
                                {"type": "text", "text": text_content},
                                *image_parts,
                            ],
                            tool_call_id=messages[index].tool_call_id,
                            tool_calls=messages[index].tool_calls,
                        )
                        break
                    extra["delivered_evidence_ids"] = delivered_evidence_ids
                if vision_warnings:
                    extra["vision_warnings"] = vision_warnings
            else:
                extra["vision_warnings"] = [
                    "当前模型不支持图片识别，图片未发送给模型。"
                ]
        except Exception:
            _LOG.warning("vision attachment preparation failed", exc_info=True)

    resp = invoke_llm(
        task="assistant_chat",
        messages=messages,
        tools=tools,
        user_input=user,
        extra=extra,
        config_override=config_override,
    )
    if extra.get("delivered_evidence_ids"):
        resp.metadata = {
            **(resp.metadata or {}),
            "delivered_evidence_ids": list(extra["delivered_evidence_ids"]),
        }

    # Track token usage
    if workspace_id:
        try:
            usage = resp.usage or {}
            logical_input = int(
                usage.get(
                    "logical_input_tokens",
                    usage.get("prompt_tokens", usage.get("input_tokens", 0)),
                )
                or 0
            )
            cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
            cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
            prompt_profile = (resp.metadata or {}).get("prompt_assembly")
            record_llm_call(
                input_tokens=logical_input,
                output_tokens=int(
                    usage.get(
                        "normalized_output_tokens",
                        usage.get("completion_tokens", usage.get("output_tokens", 0)),
                    )
                    or 0
                ),
                cache_creation_input_tokens=cache_creation,
                cache_read_input_tokens=cache_read,
                session_id=session_id,
                workspace_id=workspace_id,
                model=resp.model or "",
                provider=resp.provider or "",
                prompt_cache_strategy=str(
                    (resp.metadata or {}).get("prompt_cache_strategy") or ""
                ),
                prompt_profile=prompt_profile
                if isinstance(prompt_profile, dict)
                else None,
            )
        except Exception:
            _LOG.debug("record_llm_call failed", exc_info=True)

    if resp.error:
        # Preserve the provider's typed error for QueryLoop.  Raising here
        # discarded distinctions such as disabled/misconfigured credentials
        # and made the loop treat them as a recoverable generic outage.
        # Partial stream content is already retained on this same response.
        return resp
    # Preserve finish_reason, usage, and truncation metadata. QueryLoop accepts
    # only provider-native tool calls; plain JSON remains ordinary assistant text.
    return resp


def _run_async(awaitable):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(awaitable)

    box: dict[str, Any] = {}

    def _target():
        try:
            box["result"] = asyncio.run(awaitable)
        except Exception as exc:  # pragma: no cover - defensive branch
            box["error"] = exc

    import threading

    from storage.principal import bind_storage_principal

    thread = threading.Thread(target=bind_storage_principal(_target), daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _build_runtime_context_budget(registry: dict[str, dict[str, Any]]):
    from agent.llm.config import resolve_provider_config
    from agent.llm.tool_adapter import tool_spec_to_openai_function
    from core.runtime_engine.context_budget import RuntimeContextBudget

    config = dict(resolve_provider_config() or {})
    tool_definitions = [
        tool_spec_to_openai_function(
            {
                "tool_id": tool_id,
                "description": meta.get("description", ""),
                "input_schema": meta.get("args_schema", {}),
                "risk_level": meta.get("risk_level", "low"),
                "action_profiles": meta.get("action_profiles", []),
                "metadata": meta.get("metadata", {}),
            }
        )
        for tool_id, meta in sorted(registry.items())
    ]
    return RuntimeContextBudget.build(
        model=str(config.get("model") or ""),
        tools=tool_definitions,
        context_window_tokens=int(config.get("context_window_tokens") or 0),
        max_input_tokens=int(config.get("max_input_tokens") or 48_000),
        reserved_output_tokens=int(config.get("max_tokens") or 4096),
    )


def _current_provider_name() -> str:
    try:
        from agent.llm.config import resolve_provider_config

        return str(resolve_provider_config().get("provider") or "")
    except Exception:
        return ""


def _current_model_name() -> str:
    try:
        from agent.llm.config import resolve_provider_config

        return str(resolve_provider_config().get("model") or "")
    except Exception:
        return ""
