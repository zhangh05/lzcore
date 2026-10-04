"""Public QueryLoop driver and compatibility facade. Mechanisms live in purpose-specific components."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from agent.llm.schemas import LLMMessage, LLMToolCall

from .cognitive_state import initialize_cognitive_state
from .context_budget import RuntimeContextBudget
from .context_compaction import estimate_chars as _estimate_chars
from .context_compaction import estimate_message_tokens as _estimate_message_tokens
from .context_continuation import ContextContinuation
from .evidence import (
    evidence_summary,
    initialize_evidence_ledger,
    pending_llm_evidence,
    register_tool_evidence,
)
from .loop_errors import _llm_failure_message
from .loop_messages import (
    FINAL_SYNTHESIS_CHECKPOINT_MARKER,
    SYNTHESIS_CHECKPOINT_MARKER,
    QueryLoopResult,
    StreamingToolResult,
    deserialize_loop_message,
    deserialize_streaming_tool_result,
    serialize_loop_message,
    serialize_streaming_tool_result,
)
from .loop_tool_catalog import _build_cached_tool_definitions
from .loop_tools import StreamingToolExecutor
from .models import SSOTRuntimeConfig, StatelessContext
from .stage_events import (
    EXECUTION_COMPLETED,
    EXECUTION_STARTED,
    MODEL_COMPLETED,
    MODEL_STARTED,
    PLANNER_COMPLETED,
    PROVIDER_RETRYING,
    RESPONSE_COMPLETED,
    RESPONSE_STARTED,
)

_LOG = logging.getLogger(__name__)
from .loop_approval import LoopApprovalContinuation
from .loop_errors import _normalize_llm_error
from .loop_messages import (
    QUERY_LOOP_SYSTEM_PROMPT,
    _json_compact,
    _model_tool_payload,
    _redact_tool_error,
)
from .loop_model import LoopModelGateway
from .loop_preparation import LoopToolPreparation
from .loop_recovery import LoopFailureRecovery
from .loop_response import LoopResponseProjection
from .loop_tool_catalog import (
    _TOOL_DEFINITION_CACHE,
    _tool_meta_get,
    _tool_registry_signature,
)
from .loop_tracking import LoopTracking
from .loop_turn_projection import LoopTurnProjection


class QueryLoop(
    LoopApprovalContinuation,
    LoopTurnProjection,
    LoopModelGateway,
    LoopFailureRecovery,
    LoopToolPreparation,
    LoopTracking,
    LoopResponseProjection,
):
    """Owns one turn and its state machine; components own distinct mechanisms."""

    def __init__(
        self,
        config: SSOTRuntimeConfig,
        tool_registry: dict[str, dict[str, Any]],
        tool_runtime,
        llm_invoke: Callable[..., Any] | None = None,
        emitter=None,
    ):
        self._config = config
        self._tool_registry = tool_registry
        self._tool_runtime = tool_runtime
        self._llm_invoke = llm_invoke
        self._emitter = emitter
        self._executor = StreamingToolExecutor(
            tool_runtime,
            config,
            emitter,
            tool_registry=tool_registry,
        )
        self._cached_tools = _build_cached_tool_definitions(tool_registry)
        self._context_budget = RuntimeContextBudget.build(
            tools=self._cached_tools,
            context_window_tokens=config.context_window_tokens,
            max_input_tokens=config.max_input_tokens,
            reserved_output_tokens=config.max_output_tokens,
            safety_tokens=config.context_safety_tokens,
        )
        self._llm_call_count = 0
        self._context_continuation = None

    def _emit_stage(
        self,
        stage: str,
        t_turn_started: float,
        *,
        stage_started_at: float | None = None,
        **extra: Any,
    ) -> None:
        """Emit a semantic QueryLoop boundary with monotonic timing fields."""
        if self._emitter is None:
            return
        try:
            now = time.monotonic()
            turn_elapsed_ms = int((now - t_turn_started) * 1000)
            stage_elapsed_ms = int((now - (stage_started_at or t_turn_started)) * 1000)
            self._emitter.emit(
                stage,
                {
                    "stage": stage,
                    "elapsed_ms": turn_elapsed_ms,
                    "turn_elapsed_ms": turn_elapsed_ms,
                    "stage_elapsed_ms": stage_elapsed_ms,
                    **extra,
                },
            )
        except Exception:
            _LOG.debug("stream stage emit failed: %s", stage, exc_info=True)

    async def run(
        self,
        ctx: StatelessContext,
        budget,
        metrics,
    ) -> QueryLoopResult:
        """Run the full query loop."""
        t_start = time.monotonic()
        all_results: list[StreamingToolResult] = []
        iterations = 0
        llm_calls = 0
        validation_correction_attempts = 0
        # In-memory loop deduplication retains the readable canonical key.
        trusted_task_state = ctx.extras.get("__trusted_task_state_contract")
        if isinstance(trusted_task_state, dict):
            from .goal_loop import hydrate_goal_loop

            hydrate_goal_loop(ctx, trusted_task_state)
        used_call_ids: set[str] = set()
        execution_duration_ms = 0.0
        provider_failure_count = 0
        planner_completed_emitted = False
        cognitive_state = initialize_cognitive_state(
            turn_id=ctx.request_id,
            trace_id=str(ctx.extras.get("trace_id") or ctx.request_id),
            user_input=ctx.user_input,
            constraints=("SSOT QueryLoop is the only tool execution path",),
        )
        ctx.extras["cognitive_state"] = cognitive_state
        if self._emitter is not None:
            for event in cognitive_state.events:
                self._emitter.emit(event["type"], event)
        cognitive_events_emitted = len(cognitive_state.events)
        cognitive_registered_results = 0

        initialize_evidence_ledger(ctx.extras)

        # Build initial messages (cacheable prefix)
        messages = self._build_initial(ctx)
        self._context_continuation = ContextContinuation(
            self._build_initial(ctx, include_history=False)
        )
        resume = ctx.extras.get("approval_continuation_resume")
        if isinstance(resume, dict):
            messages, cognitive_registered_results = self._resume_approval(
                ctx,
                resume,
                messages,
                all_results,
                cognitive_state,
            )

        def finish(**values) -> QueryLoopResult:
            return self._finish_turn(
                ctx=ctx,
                t_start=t_start,
                all_results=all_results,
                iterations=iterations,
                llm_calls=llm_calls,
                messages=messages,
                metrics=metrics,
                execution_duration_ms=execution_duration_ms,
                validation_correction_attempts=validation_correction_attempts,
                cognitive_state=cognitive_state,
                cognitive_registered_results=cognitive_registered_results,
                cognitive_events_emitted=cognitive_events_emitted,
                values=values,
            )

        # Trusted UI workflows may hand off explicit artifact ids after a
        # background task completes. Read those workspace-scoped artifacts
        # through the canonical runtime before planning, then let the LLM decide
        # whether the prefetched evidence is enough or more tools are needed.
        if self._is_cancelled(ctx):
            return finish(final_response="任务已取消。", error="cancelled_by_user")
        prefetch_ids = list(
            dict.fromkeys(
                str(value).strip()
                for value in (ctx.extras.get("prefetch_artifact_ids") or [])
                if str(value).strip()
            )
        )[:8]
        if prefetch_ids and self._tool_runtime.has_tool("workspace.artifact"):
            prefetch_calls = [
                LLMToolCall(
                    id=f"prefetch_artifact_{index}",
                    name="workspace.artifact",
                    arguments={"action": "read", "artifact_id": artifact_id},
                )
                for index, artifact_id in enumerate(prefetch_ids)
            ]
            used_call_ids.update(call.id for call in prefetch_calls)
            execution_started = time.monotonic()
            budget.begin_execution()
            try:
                prefetch_results = await self._executor.execute(
                    prefetch_calls,
                    ctx=ctx,
                    budget=budget,
                )
            finally:
                budget.end_execution()
                execution_duration_ms += (time.monotonic() - execution_started) * 1000
            all_results.extend(prefetch_results)
            register_tool_evidence(
                ctx.extras, prefetch_results, tool_registry=self._tool_registry
            )
            messages = self._append_tool_round(
                messages,
                prefetch_calls,
                prefetch_results,
            )
            if self._has_complete_analysis_artifact(prefetch_results):
                messages = self._append_turn_nudge(
                    messages,
                    SYNTHESIS_CHECKPOINT_MARKER
                    + " Complete artifacts were prefetched above. Analyze them and "
                    "answer the original request if the evidence is sufficient. "
                    "Tools remain available if more verification is needed.",
                )

        consecutive_tool_failures: dict[str, int] = {}
        consecutive_no_changes = 0
        while True:
            if self._is_cancelled(ctx):
                # If tools already produced results, surface them as a
                # fallback instead of discarding everything.  This avoids
                # losing completed work when the WebSocket closes before
                # the final LLM summarisation call finishes.
                if all_results:
                    return finish(
                        final_response=self._build_tool_result_fallback(
                            ctx, all_results
                        ),
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=budget.llm_calls,
                        error="cancelled_by_user",
                    )
                return finish(
                    final_response="任务已取消。",
                    error="cancelled_by_user",
                )
            iterations += 1

            # The counter is telemetry only.  A model-directed task has no
            # runtime turn cap; it ends only on explicit completion,
            # cancellation, or an external suspension such as approval.
            budget.check_llm_call()

            if metrics is not None:
                metrics.capture_context_usage(
                    _estimate_chars(messages),
                    estimated_tokens=_estimate_message_tokens(messages),
                    budget_tokens=self._context_budget.message_tokens,
                )

            # Call LLM (with streaming for tool exec)
            # Emit at the actual provider boundary. A planner result is complete
            # when its first model call returns, not when the whole loop exits.
            _, stream_scope, _ = self._llm_call_mode(messages, ctx)
            model_started_at = time.monotonic()
            response_stage_started_at = None
            self._emit_stage(
                MODEL_STARTED,
                t_start,
                stage_started_at=model_started_at,
                iteration=iterations,
                stream_scope=stream_scope,
            )
            if stream_scope == "response":
                response_stage_started_at = model_started_at
                self._emit_stage(
                    RESPONSE_STARTED,
                    t_start,
                    stage_started_at=response_stage_started_at,
                    iteration=iterations,
                )
            response = await self._call_llm(
                messages,
                ctx,
            )
            self._emit_stage(
                MODEL_COMPLETED,
                t_start,
                stage_started_at=model_started_at,
                iteration=iterations,
                stream_scope=stream_scope,
                ok=bool(response is not None and not response.error),
                finish_reason=str(response.finish_reason or "") if response else "",
                output_truncated=bool((response.metadata or {}).get("output_truncated"))
                if response
                else False,
            )
            if not planner_completed_emitted:
                self._emit_stage(
                    PLANNER_COMPLETED,
                    t_start,
                    stage_started_at=t_start,
                    iteration=iterations,
                )
                planner_completed_emitted = True
            # A cancellation may arrive while the provider is generating.
            # Re-check before interpreting either tool calls or final prose so
            # the user-authoritative cancellation cannot be overwritten by a
            # late model response.
            if self._is_cancelled(ctx):
                return finish(
                    final_response=(
                        self._build_tool_result_fallback(ctx, all_results)
                        if all_results
                        else "任务已取消。"
                    ),
                    tool_results=all_results,
                    iterations=iterations,
                    total_tool_calls=len(all_results),
                    llm_calls=budget.llm_calls,
                    error="cancelled_by_user",
                )

            if response is not None and (response.metadata or {}).get(
                "output_truncated"
            ):
                # A partial provider response is evidence, not a terminal
                # answer. Preserve every received token in the conversation
                # and ask the same model to continue before any final result
                # is emitted to the user.
                if response.content or response.protocol:
                    messages.append(response.assistant_message([]))
                if response.tool_calls:
                    continuation = (
                        "The preceding response ended while producing tool calls. None of those partial calls "
                        "was executed. Issue new complete native tool calls with the published function name "
                        "and a complete JSON object; do not continue a partial JSON argument across messages. "
                        "Use smaller independently valid calls where the tool contract permits, preserving "
                        "existing objects and earlier evidence. Do not replay any earlier write with an unknown outcome."
                    )
                else:
                    continuation = (
                        "The preceding model response ended before completion. Continue from its exact final "
                        "content without repeating prior text; complete the original task and keep the full "
                        "answer in this conversation."
                    )
                messages = self._append_turn_nudge(messages, continuation)
                continue

            if response is None or response.error:
                # A provider outage is not a completed answer and must never
                # discard accumulated tool evidence.  Keep the same full
                # conversation in the loop and wait for the provider to
                # recover; user cancellation remains the escape hatch.
                provider_error = str(response.error if response else "no_response")
                provider_failure_count += 1
                ctx.extras.setdefault("provider_recovery_events", []).append(
                    {
                        "attempt": provider_failure_count,
                        "error": provider_error,
                        "diagnostic": dict(
                            (response.metadata or {}).get("provider_failure_diagnostic")
                            or {}
                        )
                        if response
                        else {},
                        "tool_results_preserved": len(all_results),
                    }
                )
                # A provider can recover from transport errors without losing
                # the agent's loop.  Explicit disablement, missing credentials,
                # and invalid model configuration cannot: retrying the exact
                # same request only creates a busy loop.  Return the complete
                # already-collected evidence and a typed operator-facing state.
                if provider_error in {
                    "llm_auth_failed",
                    "llm_configuration_error",
                    "llm_request_rejected",
                    "context_capacity_exceeded",
                    "context_checkpoint_failed",
                }:
                    final_response = (
                        self._build_tool_result_fallback(ctx, all_results)
                        if all_results
                        else _llm_failure_message(provider_error)
                    )
                    if all_results and provider_error == "context_capacity_exceeded":
                        final_response = (
                            _llm_failure_message(provider_error)
                            + "\n\n"
                            + final_response
                        )
                    ctx.extras["response_outcome"] = (
                        "context_capacity_exceeded"
                        if provider_error == "context_capacity_exceeded"
                        else "llm_configuration_unavailable"
                    )
                    return finish(
                        final_response=final_response,
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=budget.llm_calls,
                        error=provider_error,
                    )
                # A positive loop setting is an explicit compatibility
                # profile (principally deterministic/offline callers).  The
                # production runtime sets it to zero and therefore retries
                # indefinitely.  Keep the old finite fallback only for that
                # caller-selected compatibility mode.
                if int(self._config.max_query_loop_iterations or 0) > 0:
                    recovered = (
                        await self._recover_final_synthesis(ctx, budget)
                        if all_results
                        else ""
                    )
                    final_response = recovered or (
                        self._build_tool_result_fallback(ctx, all_results)
                        if all_results
                        else _llm_failure_message(provider_error)
                    )
                    ctx.extras["response_outcome"] = (
                        "recovered" if recovered else "deterministic_fallback"
                    )
                    return finish(
                        final_response=final_response,
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=budget.llm_calls,
                        error=provider_error if not all_results else None,
                    )
                self._emit_stage(
                    PROVIDER_RETRYING,
                    t_start,
                    attempt=provider_failure_count,
                    error=provider_error,
                )
                await self._wait_for_provider_recovery(ctx, provider_failure_count)
                continue

            llm_calls = budget.llm_calls

            # Check for tool calls
            raw_tool_calls = response.tool_calls
            if not raw_tool_calls and response.content:
                fallback_calls, cleaned_content = self._extract_fallback_tool_calls(
                    response.content, self._tool_registry
                )
                if fallback_calls:
                    raw_tool_calls = fallback_calls
                    response.tool_calls = fallback_calls
                    response.content = cleaned_content
            if raw_tool_calls:
                # Convert to LLMToolCall objects
                tool_calls = self._parse_tool_calls(raw_tool_calls)
                tool_calls = self._unique_call_ids(
                    tool_calls, iterations, used_call_ids
                )
                from .batch_compiler import (
                    compile_batchable_calls,
                    contains_disallowed_batch_action,
                    user_requires_individual_tool_calls,
                )

                explicit_individual_calls = user_requires_individual_tool_calls(
                    ctx.user_input
                )
                if explicit_individual_calls and contains_disallowed_batch_action(
                    tool_calls,
                    self._tool_registry,
                ):
                    messages = self._append_turn_nudge(
                        messages,
                        "系统约束：用户明确要求每个目标使用独立工具调用。当前计划包含已声明的"
                        "批量 action，不能替代该要求。请改为保留原始 scalar action，并按单轮"
                        "逐个保留 scalar action；不得使用 batch action。",
                    )
                    ctx.extras.setdefault("explicit_individual_call_replans", 0)
                    ctx.extras["explicit_individual_call_replans"] += 1
                    continue
                tool_calls, batch_compile_events = compile_batchable_calls(
                    tool_calls,
                    self._tool_registry,
                    allow_batching=not explicit_individual_calls,
                )
                if batch_compile_events:
                    ctx.extras.setdefault("batch_compile_events", []).extend(
                        batch_compile_events
                    )

                tool_calls, duplicate_note = self._suppress_repeated_tool_calls(
                    ctx, tool_calls
                )
                if duplicate_note:
                    # Keep the model's proposal in transcript as a proposal,
                    # then make the no-progress diagnosis explicit.  It was
                    # never executed, so no synthetic tool result is created.
                    if not tool_calls:
                        messages = [*messages, response.assistant_message([])]
                    messages = self._append_turn_nudge(messages, duplicate_note)
                if not tool_calls:
                    signature = str(
                        ctx.extras.get("last_suppressed_tool_signature") or ""
                    )
                    current_signature = str(
                        ctx.extras.get("suppressed_tool_signature") or ""
                    )
                    if current_signature and current_signature == signature:
                        has_successful_patch = any(
                            str(item.tool_name or "").replace("__", ".")
                            == "network.operations.topology"
                            and isinstance(item.output, dict)
                            and item.output.get("action") == "patch"
                            and item.ok
                            for item in all_results
                        )
                        workbench = (
                            ctx.extras.get("workbench_context")
                            if isinstance(ctx.extras, dict)
                            else None
                        )
                        is_drawing = (
                            isinstance(workbench, dict)
                            and workbench.get("extension_id") == "network.operations"
                            and str(workbench.get("skill_id") or "").startswith(
                                "drawing:"
                            )
                            and bool(workbench.get("allow_edit", True))
                        )
                        if (is_drawing or has_successful_patch) and (
                            response.content or ""
                        ).strip():
                            return finish(
                                final_response=response.content,
                                tool_results=all_results,
                                iterations=iterations,
                                total_tool_calls=len(all_results),
                                llm_calls=budget.llm_calls,
                            )
                        ctx.extras["response_outcome"] = "blocked_no_progress"
                        ctx.extras.setdefault("no_progress_events", []).append(
                            {
                                "kind": "repeated_terminal_tool_proposal",
                                "signature": current_signature,
                                "iteration": iterations,
                            }
                        )
                        return finish(
                            final_response=(
                                "任务受阻：模型连续提出同一组已有终态证据或确定性失败的工具调用；"
                                "这些调用没有再次执行，已保留全部既有证据。请基于不同的可执行路径继续，"
                                "或明确说明当前目标缺少的外部条件。"
                            ),
                            tool_results=all_results,
                            iterations=iterations,
                            total_tool_calls=len(all_results),
                            llm_calls=budget.llm_calls,
                            error="no_progress_repeated_tool_calls",
                        )
                    if current_signature:
                        ctx.extras["last_suppressed_tool_signature"] = current_signature
                    continue

                gate = self._prepare_tool_calls(ctx, tool_calls)
                if not gate["ok"]:
                    # Every validation outcome is evidence for the model, not
                    # an engine-owned decision to end the task.
                    validation_correction_attempts += 1
                    if self._emitter:
                        self._emitter.emit(
                            "tool_validation_failed",
                            {
                                "errors": gate.get("errors", []),
                                "message": gate["message"],
                                "attempt": validation_correction_attempts,
                            },
                        )
                    structured_errors = list(gate.get("validation_errors") or [])
                    ctx.extras.setdefault("validation_correction_events", []).append(
                        {
                            "attempt": validation_correction_attempts,
                            "errors": structured_errors,
                        }
                    )
                    fake_results = [
                        StreamingToolResult(
                            tool_name=tc.name,
                            call_id=tc.id,
                            output={
                                "ok": False,
                                "executed": False,
                                "retryable": True,
                                "error_code": "TOOL_ARGUMENT_VALIDATION_FAILED",
                                "error": gate["message"],
                                "validation_errors": structured_errors,
                                "correction_attempt": validation_correction_attempts,
                                "instruction": (
                                    "Correct the reported tool arguments and issue a new call. "
                                    "Do not repeat unchanged invalid arguments."
                                ),
                            },
                            ok=False,
                            error=gate["message"],
                        )
                        for tc in tool_calls
                    ]
                    all_results.extend(fake_results)
                    messages = self._append_tool_round(
                        messages, tool_calls, fake_results, response=response
                    )
                    # Don't count these as successful tool calls
                    continue
                tool_calls = gate["tool_calls"]
                # Semantic repair and canonical argument normalization may have
                # changed an otherwise scalar proposal. Recheck the final
                # executable calls so an explicit user no-batch constraint is
                # never bypassed by a later normalization stage.
                if explicit_individual_calls and contains_disallowed_batch_action(
                    tool_calls,
                    self._tool_registry,
                ):
                    messages = self._append_turn_nudge(
                        messages,
                        "系统约束：规范化后的计划仍包含批量 action，但用户明确禁止批量并"
                        "要求每个目标独立调用。请改为逐个 scalar action；"
                        "不得执行该批量 action。",
                    )
                    ctx.extras.setdefault("explicit_individual_call_replans", 0)
                    ctx.extras["explicit_individual_call_replans"] += 1
                    continue

                # Deduplicate only after deterministic alias/argument repair.
                cognitive_state.select_plan(
                    [
                        {"action": tc.name, "purpose": "补充当前任务所需观察"}
                        for tc in tool_calls
                    ],
                    reason="已通过规范化、语义和授权校验的执行计划",
                )
                cognitive_state.set_decision(
                    "execute_tool",
                    reason_codes=("validated_execution_plan",),
                    selected_action=",".join(tc.name for tc in tool_calls),
                    visible_summary="正在执行经过校验的计划步骤",
                )
                if self._emitter is not None:
                    for event in cognitive_state.events[cognitive_events_emitted:]:
                        self._emitter.emit(event["type"], event)
                cognitive_events_emitted = len(cognitive_state.events)
                # Persist server-derived call intent before a side effect can
                # begin. Task-projection degradation is recorded explicitly;
                # the canonical tool ledger remains the execution authority.
                checkpoint = ctx.extras.get("__task_state_execution_checkpoint")
                if callable(checkpoint):
                    prepared_manifest = [
                        {
                            "tool_id": str(call.name or "")[:160],
                            "call_key": self._durable_call_key(call),
                            "side_effecting": not self._executor._is_read_only_call(
                                call
                            ),
                        }
                        for call in tool_calls
                    ]
                    try:
                        checkpoint("prepared", prepared_manifest)
                    except Exception as exc:  # noqa: BLE001 -- persistence must not own the agent loop
                        self._record_checkpoint_degradation(ctx, "prepared", exc)
                # Execute tools (parallel read-only, serial writes). Aggregate
                # budgets are telemetry and never discard a model-proposed call.
                execution_started = time.monotonic()
                # Keep the model-requested graph distinct from server-owned
                # read recovery. The latter is rendered as auto-tracking
                # evidence, never forged as a provider function call.
                model_tool_calls = list(tool_calls)
                self._emit_stage(
                    EXECUTION_STARTED,
                    t_start,
                    stage_started_at=execution_started,
                    iteration=iterations,
                    tool_calls=len(tool_calls),
                )
                budget.begin_execution()
                try:
                    results = await self._executor.execute(
                        tool_calls, ctx=ctx, budget=budget
                    )
                    all_results.extend(results)
                    self._record_task_state_execution_manifest(ctx, tool_calls, results)
                    if callable(checkpoint):
                        settled_manifest = list(
                            ctx.extras.get("task_state_execution_manifest") or []
                        )[-len(results) :]
                        try:
                            checkpoint("settled", settled_manifest)
                        except Exception as exc:  # noqa: BLE001 -- retain delivered evidence and let the model continue
                            self._record_checkpoint_degradation(ctx, "settled", exc)
                    (
                        recovery_calls,
                        recovery_results,
                    ) = await self._execute_safe_read_recovery(
                        ctx,
                        tool_calls,
                        results,
                        budget=budget,
                        checkpoint=checkpoint,
                    )
                    if recovery_results:
                        tool_calls = [*tool_calls, *recovery_calls]
                        results = [*results, *recovery_results]
                        all_results.extend(recovery_results)
                    from .goal_loop import observe_tool_round

                    observe_tool_round(
                        ctx,
                        tool_calls,
                        results,
                        is_read_only_call=self._executor._is_read_only_call,
                    )
                    for tc, result in zip(tool_calls, results):
                        ctx.extras.setdefault("tool_call_history", []).append(
                            {
                                "tool": tc.name.replace("__", "."),
                                "arguments": dict(tc.arguments or {}),
                                "ok": bool(result.ok),
                                "output": dict(result.output or {})
                                if isinstance(result.output, dict)
                                else {},
                            }
                        )
                    # ── Tracking: auto-poll producer-declared long tasks ──
                    polled_results = await self._settle_tracking(
                        ctx, results, budget=budget
                    )
                finally:
                    budget.end_execution()
                    execution_duration_ms += (
                        time.monotonic() - execution_started
                    ) * 1000
                if polled_results:
                    all_results.extend(polled_results)
                    results = results + polled_results
                    source_calls = {call.id: call for call in tool_calls}
                    tracking_calls: list[LLMToolCall] = []
                    tracking_results: list[StreamingToolResult] = []
                    for polled in polled_results:
                        source_id = str(
                            (polled.output or {}).get("tracking_source_call_id") or ""
                        )
                        source_call = source_calls.get(source_id)
                        if source_call is None:
                            continue
                        tracking_calls.append(
                            LLMToolCall(
                                id=polled.call_id,
                                name=source_call.name,
                                arguments=dict(source_call.arguments or {}),
                                failure_policy=source_call.failure_policy,
                                goal_ids=list(source_call.goal_ids),
                            )
                        )
                        tracking_results.append(polled)
                    if tracking_calls:
                        from .goal_loop import observe_tool_round

                        observe_tool_round(
                            ctx,
                            tracking_calls,
                            tracking_results,
                            is_read_only_call=self._executor._is_read_only_call,
                        )

                pending_interruptions = [
                    dict((result.output or {}).get("external_interruption") or {})
                    for result in results
                    if isinstance(result.output, dict)
                    and str((result.output or {}).get("status") or "")
                    == "waiting_external_input"
                    and isinstance(
                        (result.output or {}).get("external_interruption"), dict
                    )
                ]
                if pending_interruptions:
                    # A deferred invocation is neither a failed tool nor a
                    # completed task.  Do not ask the model for a fabricated
                    # final answer, and do not execute later model turns until
                    # an extension supplies an external decision.
                    ctx.extras["external_interruptions"] = pending_interruptions
                    ctx.extras["response_outcome"] = "waiting_external_input"
                    ctx.extras["execution_outcome"] = "waiting_external_input"
                    # Persist the exact model boundary before returning the
                    # HTTP/WebSocket worker.  We intentionally retain every
                    # message and tool payload: approval is an external wait,
                    # not permission to truncate the agent's working state.
                    try:
                        from extensions.approval.service import (
                            attach_continuation_checkpoint,
                        )

                        checkpoint = attach_continuation_checkpoint(
                            ctx.workspace_id,
                            session_id=ctx.session_id,
                            run_id=str(ctx.extras.get("run_id") or ""),
                            request_id=ctx.request_id,
                            user_input=ctx.user_input,
                            messages=[
                                serialize_loop_message(item) for item in messages
                            ],
                            tool_calls=[
                                {
                                    "id": call.id,
                                    "name": call.name,
                                    "arguments": dict(call.arguments or {}),
                                    "failure_policy": call.failure_policy,
                                    "goal_ids": list(call.goal_ids or []),
                                }
                                for call in model_tool_calls
                            ],
                            prior_results=[
                                serialize_streaming_tool_result(item)
                                for item in all_results
                                if item not in results
                            ],
                            round_results=[
                                serialize_streaming_tool_result(item)
                                for item in results
                            ],
                            interruption_ids=[
                                str(item.get("interruption_id") or "")
                                for item in pending_interruptions
                            ],
                            workbench_context=dict(
                                ctx.extras.get("workbench_context") or {}
                            ),
                            context_window_state=self._context_continuation.checkpoint_state(),
                        )
                        ctx.extras["approval_continuation"] = {
                            "checkpoint_id": checkpoint["checkpoint_id"],
                            "operation_ids": checkpoint["operation_ids"],
                        }
                    except Exception:
                        from extensions.approval.service import (
                            invalidate_uncheckpointed_operations,
                        )

                        invalidate_uncheckpointed_operations(
                            ctx.workspace_id,
                            [
                                str(item.get("interruption_id") or "")
                                for item in pending_interruptions
                            ],
                        )
                        return finish(
                            final_response="审批操作的恢复检查点未能保存，操作没有执行。",
                            tool_results=all_results,
                            iterations=iterations,
                            total_tool_calls=len(all_results),
                            llm_calls=llm_calls,
                            error="approval_checkpoint_persist_failed",
                        )
                    return finish(
                        final_response="操作已准备，正在等待外部决定。",
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=llm_calls,
                        metrics={"external_interruptions": pending_interruptions},
                    )

                self._emit_stage(
                    EXECUTION_COMPLETED,
                    t_start,
                    stage_started_at=execution_started,
                    iteration=iterations,
                    tool_calls=len(results),
                    failed_tool_calls=sum(1 for result in results if not result.ok),
                )

                registered_evidence_ids = register_tool_evidence(
                    ctx.extras,
                    results,
                    workspace_id=ctx.workspace_id,
                    session_id=ctx.session_id,
                    request_id=ctx.request_id,
                    user_input=ctx.user_input,
                    tool_registry=self._tool_registry,
                )
                cognitive_state.register_tool_results(
                    results,
                    evidence=evidence_summary(ctx.extras),
                )
                cognitive_registered_results = len(all_results)
                if self._emitter is not None:
                    for event in cognitive_state.events[cognitive_events_emitted:]:
                        self._emitter.emit(event["type"], event)
                cognitive_events_emitted = len(cognitive_state.events)
                document_images = [
                    item
                    for item in pending_llm_evidence(ctx.extras)
                    if item.get("evidence_id") in registered_evidence_ids
                    and item.get("kind") == "image"
                ]

                # Producers may explicitly report a successful no-op. This is
                # not progress, even if their calls have different ids.
                if results and all(
                    res.ok and (res.output or {}).get("changed") is False
                    for res in results
                ):
                    consecutive_no_changes += 1
                elif any((res.output or {}).get("changed") is True for res in results):
                    consecutive_no_changes = 0
                if consecutive_no_changes >= 3:
                    return finish(
                        final_response="三次修改均未产生新的变更，已停止重复提交。已保留当前结果，请核对尚未满足的要求。",
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=budget.llm_calls,
                        error="tool_no_progress",
                    )

                # A batch is one model proposal, not several recovery attempts.
                # Deliver its failures before counting another retry round.
                limited = self._advance_tool_failure_round(
                    consecutive_tool_failures, results
                )
                if limited is not None:
                    err_code = str(
                        (limited.output or {}).get("error")
                        or limited.error
                        or "unknown_error"
                    )
                    ctx.extras["response_outcome"] = "tool_failure_limit_reached"
                    return finish(
                        final_response=(
                            f"任务受阻：工具 {limited.tool_name} 连续多轮返回相同错误（{err_code}）。"
                            "已主动停止重复重试，避免陷入无限循环。已保留当前工作结果与对话状态，请核对后继续。"
                        ),
                        tool_results=all_results,
                        iterations=iterations,
                        total_tool_calls=len(all_results),
                        llm_calls=budget.llm_calls,
                        error="consecutive_tool_failures",
                    )

                # Append assistant message (with tool_calls) + tool results
                messages = self._append_tool_round(
                    messages, model_tool_calls, results, response=response
                )
                # New observed evidence reopens normal recovery planning.  A
                # final-text-only response after a nudge is handled below as a
                # truthful blocked state, not an unbounded dialogue loop.
                ctx.extras.pop("recovery_final_nudge_pending", None)
                checkpoint_nudge = self._task_state_checkpoint_nudge(ctx)
                if checkpoint_nudge:
                    messages = self._append_turn_nudge(messages, checkpoint_nudge)
                if self._producer_requests_final_synthesis(polled_results):
                    messages = self._append_turn_nudge(
                        messages,
                        FINAL_SYNTHESIS_CHECKPOINT_MARKER
                        + " The producer-declared long task is terminal and requested synthesis. "
                        "Prioritize answering the original request from the terminal task evidence. "
                        "Treat partial or failed targets as explicit coverage limits. Do not poll a terminal "
                        "task or repeat already collected evidence. If a specific required fact is missing "
                        "or truncated, tools remain available for a narrowly scoped follow-up; do not "
                        "restart the full inspection or substitute assumptions for evidence.",
                    )
                unknown_outcome = ctx.extras.get("unknown_outcome")
                reconciliation = ctx.extras.get("unknown_outcome_reconciliation")
                if (
                    isinstance(reconciliation, dict)
                    and reconciliation.get("status") == "reconciled"
                ):
                    messages = self._append_turn_nudge(
                        messages,
                        "同连接 read-back 已完成；请依据完整回读证据决定下一步。",
                    )
                elif isinstance(unknown_outcome, dict) and unknown_outcome:
                    messages = self._append_turn_nudge(
                        messages,
                        "上一项外部操作的实际结果尚未确定。完整结果已提供；请自行决定 read-back、继续配置、重试或向用户说明当前状态。",
                    )
                if self._has_post_configuration_readback(ctx, results):
                    from .goal_loop import (
                        supersede_generic_goals_after_completion_evidence,
                    )

                    completed_goal_ids = (
                        supersede_generic_goals_after_completion_evidence(
                            ctx,
                            completion_call_ids={
                                str(result.call_id or "")
                                for result in results
                                if result.ok and str(result.call_id or "")
                            },
                        )
                    )
                    messages = self._append_turn_nudge(
                        messages,
                        "[POST-CONFIGURATION READ-BACK] This request now has a successful device read-back "
                        "after a configuration call. Assess the user's exact completion criteria from the full "
                        "evidence already provided. If they are satisfied, produce the final answer now; do not "
                        "make duplicate device calls or re-read the same evidence artifact merely to restate it. "
                        "If a criterion is genuinely not evidenced, make only the narrow call that proves that gap.",
                    )
                    if completed_goal_ids:
                        messages = self._append_turn_nudge(
                            messages,
                            "[RUNTIME GOAL RECONCILIATION] Earlier failed exploratory calls have been superseded "
                            "by the successful requested-operation evidence. They are retained for audit only and "
                            "must not trigger retries or prevent the final answer.",
                        )
                recovered_source_ids = {
                    str(item.get("source_call_id") or "")
                    for item in ctx.extras.get("safe_read_recovery_events") or []
                    if isinstance(item, dict) and item.get("status") == "recovered"
                }
                failed_results = [
                    result
                    for result in results
                    if not result.ok and result.call_id not in recovered_source_ids
                ]
                if failed_results:
                    messages = self._append_turn_nudge(
                        messages,
                        self._build_tool_failure_recovery_nudge(failed_results),
                    )
                    ctx.extras.setdefault("tool_recovery_events", []).append(
                        {
                            "iteration": iterations,
                            "failed_tools": [
                                result.tool_name for result in failed_results
                            ],
                            "errors": [
                                str(result.error or "") for result in failed_results
                            ],
                        }
                    )
                safe_recovery_nudge = self._build_safe_read_recovery_nudge(ctx)
                if safe_recovery_nudge:
                    messages = self._append_turn_nudge(messages, safe_recovery_nudge)
                from .goal_loop import goal_loop_nudge

                generic_goal_nudge = goal_loop_nudge(ctx)
                if generic_goal_nudge:
                    messages = self._append_turn_nudge(messages, generic_goal_nudge)
                if self._has_complete_analysis_artifact(results):
                    messages = self._append_turn_nudge(
                        messages,
                        SYNTHESIS_CHECKPOINT_MARKER
                        + " The complete artifact content is included above. "
                        "Analyze it and answer the original request if sufficient. "
                        "Tools remain available if more verification is needed.",
                    )
                if document_images:
                    messages = self._append_turn_nudge(
                        messages,
                        SYNTHESIS_CHECKPOINT_MARKER
                        + " The requested embedded document image is now attached as visual evidence. "
                        "Answer the user's original question from that image when the evidence is sufficient. "
                        "Additional tools remain available for a genuine unresolved evidence gap; never claim "
                        "visual details not present in the image.",
                    )
                continue

            # No tool calls is only a proposed final response. Runtime-owned
            # recovery goals are evidence predicates, so the model cannot end
            # the turn while required evidence remains unresolved.
            from .recovery_goals import recovery_final_gate

            recovery_gate = recovery_final_gate(ctx, all_results)
            if recovery_gate.should_continue:
                if ctx.extras.get("recovery_final_nudge_pending"):
                    from .recovery_goals import block_unresolved_recovery_goals

                    block_unresolved_recovery_goals(
                        ctx,
                        recovery_gate.unresolved,
                        reason="no_executable_recovery_after_runtime_nudge",
                    )
                    ctx.extras["response_outcome"] = "blocked_no_recovery_action"
                    ctx.extras.setdefault("recovery_goal_events", []).append(
                        {
                            "type": "blocked_no_executable_recovery_action",
                            "iteration": iterations,
                            "unresolved_goal_ids": [
                                str(item.get("goal_id") or "")
                                for item in recovery_gate.unresolved
                            ],
                        }
                    )
                    recovery_gate = recovery_final_gate(ctx, all_results)
                if recovery_gate.should_continue:
                    ctx.extras["recovery_final_nudge_pending"] = True
                    messages = [
                        *messages,
                        response.assistant_message(),
                        LLMMessage(role="user", content=recovery_gate.nudge),
                    ]
                    ctx.extras.setdefault("recovery_goal_events", []).append(
                        {
                            "type": "premature_final_rejected",
                            "iteration": iterations,
                            "unresolved_goal_ids": [
                                str(item.get("goal_id") or "")
                                for item in recovery_gate.unresolved
                            ],
                        }
                    )
                    continue

            network_retry_nudge = self._network_retry_final_gate(
                ctx, str(response.content or ""), all_results
            )
            if network_retry_nudge:
                messages = [
                    *messages,
                    response.assistant_message(),
                    LLMMessage(role="user", content=network_retry_nudge),
                ]
                ctx.extras.setdefault("network_execution_evidence_events", []).append(
                    {
                        "type": "unsupported_network_retry_final_rejected",
                        "iteration": iterations,
                    }
                )
                continue

            # No tool calls and no recoverable evidence gap → final response
            if response_stage_started_at is None:
                response_stage_started_at = model_started_at
                self._emit_stage(
                    RESPONSE_STARTED,
                    t_start,
                    stage_started_at=response_stage_started_at,
                    iteration=iterations,
                )
            final_text = response.content or ""
            if not final_text.strip():
                if all_results:
                    recovered = await self._recover_final_synthesis(ctx, budget)
                    llm_calls = budget.llm_calls
                    if recovered:
                        final_text = recovered
                        ctx.extras["response_outcome"] = "recovered"
                    else:
                        final_text = self._build_tool_result_fallback(ctx, all_results)
                        ctx.extras["response_outcome"] = "deterministic_fallback"
                else:
                    final_text = "抱歉，我无法生成回复。请重新描述您的问题后再试。"
                    ctx.extras["response_outcome"] = "failed"
            else:
                final_text = final_text.strip()

            # Semantic answer quality belongs to the model, its prompt and the
            # evidence/tool contracts.  The runtime does not score or replace
            # a completed answer with generated framework text. Deterministic
            # secret/path masking remains a presentation safety boundary.
            from core.tools.redaction import redact_string

            final_text = redact_string(final_text)
            elapsed = (time.monotonic() - t_start) * 1000
            self._emit_stage(
                RESPONSE_COMPLETED,
                t_start,
                stage_started_at=response_stage_started_at,
                iteration=iterations,
            )

            return finish(
                final_response=final_text,
                tool_results=all_results,
                iterations=iterations,
                total_tool_calls=len(all_results),
                llm_calls=llm_calls,
                metrics={
                    "elapsed_ms": elapsed,
                    "iterations": iterations,
                    "tool_calls": len(all_results),
                    "llm_calls": llm_calls,
                    "context_estimated_chars": _estimate_chars(messages),
                    "context_estimated_tokens": _estimate_message_tokens(messages),
                    "context_compacted": metrics.snapshot().context_compacted
                    if metrics
                    else False,
                    "context_budget": self._context_budget.as_dict(),
                    "context_epochs": list(ctx.extras.get("context_epochs") or []),
                    "execution_duration_ms": execution_duration_ms,
                    "max_parallel_width": self._executor.max_parallel_width,
                },
            )
