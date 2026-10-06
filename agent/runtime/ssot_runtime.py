"""SSOT runtime boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import logging
import time
from types import SimpleNamespace
from typing import Any

from agent.runtime.result import AgentResult
from agent.runtime.stream_emitter import build_trace_id
from agent.runtime.turn_persistence import persist_run_record

from .ssot_context import (
    _active_attachment_references,
    _build_history_block,
    _build_retrieved_context_block,
    _load_context_messages,
    _merge_attachment_references,
    _recent_session_attachments,
)
from .ssot_memory import _record_experience_and_maybe_reflect
from .ssot_metadata import _apply_runtime_control, _sanitize_caller_runtime_metadata
from .ssot_persistence import (
    _mark_run_record_persistence_failure,
    _mark_task_state_persistence_failure,
    _persist_inflight_user_message,
    _sync_session_history,
    _task_state_runtime_metadata,
)
from .ssot_projection import (
    _event,
    _final_response,
    _project_events,
    _project_tool_calls,
    _timeline_summary,
    _tool_decision,
    _tool_result_fallback_from_projected_calls,
)
from .ssot_provider import (
    _build_runtime_context_budget,
    _current_model_name,
    _current_provider_name,
    _invoke_llm_for_ssot_runtime,
    _run_async,
)
from .ssot_tools import _make_tool_handler

_LOG = logging.getLogger(__name__)
from .ssot_catalog import build_runtime_catalog
from .ssot_context import (
    _append_context_message,
    _attachment_reference_terms,
    _history_overlap,
)
from .ssot_memory import _log_memory_reflection_failure
from .ssot_projection import _retry_event_summary, _tool_summary


class _TaskStateResolutionFailure(RuntimeError):
    """Internal marker for a fail-closed TaskState read boundary."""


def run_ssot_turn(
    session,
    turn,
    *,
    allowed_tool_ids: set[str] | list[str] | tuple[str, ...] | None = None,
    requested_by: str = "turn_runner",
    emitter: Any | None = None,
) -> AgentResult:
    """Run one user turn through SSOT Runtime and return the stable AgentResult.

    Args:
        emitter: Optional StreamEmitter (or any object exposing ``emit(event_type, payload)``)
            used by SSOT Runtime to publish per-stage progress events to the WebSocket
            real-time callback. When omitted, SSOT Runtime runs without progress signals
            (used by offline tests / replay tools).
    """
    started = time.monotonic()
    trace_id = build_trace_id()
    workspace_id = getattr(session, "workspace_id", "") or getattr(
        turn.op, "workspace_id", ""
    )
    session_id = getattr(session, "session_id", "") or getattr(
        turn.op, "session_id", ""
    )
    user_input = (getattr(turn.op, "user_input", "") or "").strip()
    metadata_in = _sanitize_caller_runtime_metadata(
        getattr(turn.op, "metadata", {}) or {}
    )
    _apply_runtime_control(metadata_in, getattr(turn.op, "runtime_control", None))
    from .ssot_metadata import _bind_execution_readiness

    _bind_execution_readiness(metadata_in, workspace_id)
    task_continuation_contract: dict[str, Any] | None = None

    try:
        from backend.core.chat_attachments import build_attachment_runtime_guidance

        # Follow-up turns do not repeat an upload. Keep the latest managed file
        # references available as trusted runtime metadata so the model can reuse
        # the FileStore id instead of hallucinating a transient workspace path.
        current_attachments = list(metadata_in.get("attachments") or [])
        historical_attachments = (
            []
            if current_attachments
            else _recent_session_attachments(
                session,
                user_input=user_input,
            )
        )
        known_attachments = _active_attachment_references(
            workspace_id,
            _merge_attachment_references(
                current_attachments,
                historical_attachments,
            ),
        )
        if known_attachments:
            metadata_in["attachments"] = known_attachments
        attachment_guidance = build_attachment_runtime_guidance(known_attachments)
        if attachment_guidance:
            from core.runtime_engine.prompt_contract import trusted_prompt_item

            metadata_in.setdefault("trusted_prompt_items", []).append(
                trusted_prompt_item("managed_attachment", attachment_guidance)
            )
    except Exception:
        _LOG.warning("attachment runtime guidance preparation failed", exc_info=True)

    workbench_context = metadata_in.get("workbench_context")
    if isinstance(workbench_context, dict):
        from core.runtime_engine.prompt_contract import trusted_prompt_item
        from extensions.runtime import render_workbench_prompt

        metadata_in.setdefault("trusted_prompt_items", []).append(
            trusted_prompt_item(
                "workbench_skill",
                render_workbench_prompt(workbench_context),
                label=str(workbench_context.get("skill_id") or "selected_skill"),
            )
        )

    # Build the full LLM-visible tool registry first. RuntimeContextBudget
    # deducts its schema cost before assigning history/retrieval capacity.
    ssot_registry = _build_ssot_runtime_tool_registry(allowed_tool_ids)
    if isinstance(workbench_context, dict):
        from extensions.runtime import apply_workbench_tool_boundary

        ssot_registry = apply_workbench_tool_boundary(ssot_registry, workbench_context)
    runtime_context_budget = _build_runtime_context_budget(ssot_registry)

    # ── Build canonical conversation context for prompt injection ──
    metadata_in["__raw_user_input"] = user_input
    history_exclude_run_id = ""
    history_exclude_client_request_id = str(metadata_in.get("client_request_id") or "")
    history_block = _build_history_block(
        session,
        user_input=user_input,
        max_tokens=runtime_context_budget.history_tokens,
        exclude_run_id=history_exclude_run_id,
        exclude_client_request_id=history_exclude_client_request_id,
    )
    if history_block:
        metadata_in["conversation_history_block"] = history_block
    # One server-filtered history projection feeds every state resolver. This
    # prevents current pre-written requests from becoming continuation history.
    context_messages = _load_context_messages(
        session,
        exclude_run_id=history_exclude_run_id,
        exclude_client_request_id=history_exclude_client_request_id,
    )
    # Session task continuation is a separate SSOT. Only server-derived
    # relation/progress fields enter trusted guidance; historic user wording
    # remains untrusted in the conversation history block.
    try:
        from agent.runtime.task_continuation import (
            render_task_continuation_guidance,
            resolve_task_continuation,
        )
        from core.runtime_engine.prompt_contract import trusted_prompt_item

        task_continuation_contract = resolve_task_continuation(
            workspace_id=workspace_id,
            session_id=session_id,
            user_input=user_input,
            messages=context_messages,
        )
        if task_continuation_contract:
            metadata_in["task_continuation_contract"] = task_continuation_contract
            metadata_in.setdefault("trusted_prompt_items", []).append(
                trusted_prompt_item(
                    "task_continuation",
                    render_task_continuation_guidance(task_continuation_contract),
                )
            )
    except Exception:
        _LOG.warning("task continuation resolution failed", exc_info=True)

    # Generic TaskState is a trusted runtime projection, not a second planner.
    # It carries only server-derived lifecycle facts into the canonical QueryLoop.
    task_state_contract: dict[str, Any] | None = None
    task_state_resolution_error: Exception | None = None
    try:
        from agent.runtime.task_state import (
            render_task_state_guidance,
            resolve_task_state,
        )
        from core.runtime_engine.prompt_contract import trusted_prompt_item

        task_state_contract = resolve_task_state(
            workspace_id=workspace_id,
            session_id=session_id,
            user_input=user_input,
            messages=context_messages,
        )
        if task_state_contract:
            metadata_in["task_state_contract"] = task_state_contract
            metadata_in["__trusted_task_state_contract"] = task_state_contract
            metadata_in.setdefault("trusted_prompt_items", []).append(
                trusted_prompt_item(
                    "task_state",
                    render_task_state_guidance(task_state_contract),
                )
            )
    except Exception as exc:
        # Generic task state is a safety-relevant SSOT contract.  Continuing as
        # an untracked turn can repeat a prior mutation or falsely complete a
        # replan, so defer a fail-closed result until the common context exists.
        task_state_resolution_error = exc
        _LOG.warning("task state resolution failed", exc_info=True)
    if task_state_resolution_error is None:
        try:
            from agent.runtime.task_state import begin_task_state

            active_task_contract = begin_task_state(
                workspace_id=workspace_id,
                session_id=session_id,
                run_id=turn.turn_id,
                user_input=user_input,
                continuation_contract=task_state_contract,
            )
            if active_task_contract is None:
                raise RuntimeError("task_state_begin_rejected")
            task_state_contract = active_task_contract
            metadata_in["task_state_contract"] = active_task_contract
            metadata_in["__trusted_task_state_contract"] = active_task_contract
            trusted_items = list(metadata_in.get("trusted_prompt_items") or [])
            metadata_in["trusted_prompt_items"] = [
                item
                for item in trusted_items
                if getattr(item, "source_kind", "") != "task_state"
            ]
            from agent.runtime.task_state import render_task_state_guidance
            from core.runtime_engine.prompt_contract import trusted_prompt_item

            metadata_in["trusted_prompt_items"].append(
                trusted_prompt_item(
                    "task_state", render_task_state_guidance(active_task_contract)
                )
            )
            from agent.runtime.task_state import checkpoint_task_state_execution

            def _task_state_execution_checkpoint(
                phase: str, manifest: list[dict[str, Any]]
            ):
                nonlocal task_state_contract
                next_contract = checkpoint_task_state_execution(
                    workspace_id=workspace_id,
                    session_id=session_id,
                    run_id=turn.turn_id,
                    contract=dict(task_state_contract or {}),
                    phase=phase,
                    manifest=manifest,
                )
                if next_contract is None:
                    raise RuntimeError("task_state_execution_checkpoint_rejected")
                task_state_contract = next_contract
                metadata_in["task_state_contract"] = next_contract
                metadata_in["__trusted_task_state_contract"] = next_contract
                return next_contract

            metadata_in["__task_state_execution_checkpoint"] = (
                _task_state_execution_checkpoint
            )
        except Exception as exc:
            task_state_resolution_error = exc
            _LOG.warning("task state begin checkpoint failed", exc_info=True)
    retrieved_context_block = _build_retrieved_context_block(
        workspace_id=workspace_id,
        session_id=session_id,
        task_id=turn.turn_id,
        user_input=user_input,
        max_tokens=runtime_context_budget.retrieved_context_tokens,
        include_workspace_memory=not bool(getattr(session, "is_sub_agent", False)),
    )
    if retrieved_context_block:
        metadata_in["retrieved_context_block"] = retrieved_context_block

    metadata_in["runtime_context_budget"] = runtime_context_budget.as_dict()

    context = SimpleNamespace(
        workspace_id=workspace_id,
        session_id=session_id,
        turn_id=turn.turn_id,
        trace_id=trace_id,
        requested_by=requested_by,
        metadata={
            "runtime_engine": "ssot_runtime",
            "transport": metadata_in.get("transport", ""),
            "stream_mode": metadata_in.get("stream_mode", ""),
            "intent": "assistant_chat",
            "visible_tools": sorted(ssot_registry.keys()),
            "requested_by": requested_by,
        },
    )

    events: list[dict[str, Any]] = [
        _event("turn_start", "轮次开始", trace_id, turn.turn_id, started_at=started),
        _event("model", "model", trace_id, turn.turn_id, started_at=started),
    ]

    try:
        if task_state_resolution_error is not None:
            # TaskState is a durable observer of the agent loop.  Its storage
            # outage is delivered as runtime context, never a reason to erase
            # the model/tool loop before it can pursue the user's goal.
            metadata_in["task_state_persistence"] = {
                "stage": "resolution",
                "status": "degraded",
                "code": "task_state_resolution_failed",
            }
        # This identifier is server-owned and binds an external interruption
        # checkpoint to the exact logical turn that created it.
        metadata_in["run_id"] = turn.turn_id
        _persist_inflight_user_message(session, turn, user_input)
        engine = _build_engine(
            workspace_id=workspace_id,
            session_id=session_id,
            run_id=turn.turn_id,
            task_id=str((task_state_contract or {}).get("task_id") or turn.turn_id),
            trace_id=trace_id,
            allowed_tool_ids=allowed_tool_ids,
            requested_by=requested_by,
            emitter=emitter,
            prebuilt_registry=ssot_registry,
            max_query_loop_iterations=metadata_in.get("max_steps"),
            max_tool_nodes=metadata_in.get("max_tool_nodes"),
            context_budget=runtime_context_budget,
            workbench_context=workbench_context
            if isinstance(workbench_context, dict)
            else None,
        )
        runtime_result = _run_async(
            engine.run(
                user_input=user_input,
                workspace_id=workspace_id,
                session_id=session_id,
                extras=metadata_in,
            )
        )

        tool_calls = _project_tool_calls(runtime_result)
        final_response = _final_response(runtime_result)
        if not final_response:
            if tool_calls:
                final_response = _tool_result_fallback_from_projected_calls(tool_calls)
            else:
                final_response = "抱歉，服务暂时无法处理您的请求，请稍后重试。"
        events.extend(_project_events(runtime_result, trace_id, turn.turn_id))
        events.append(
            _event("final", "final", trace_id, turn.turn_id, started_at=started)
        )

        timeline_summary = _timeline_summary(
            started=started,
            events=events,
            tool_calls=tool_calls,
            runtime_result=runtime_result,
        )
        # QueryLoop exposes a terminal error both as a primary `error` field
        # and, for multi-error paths, as `errors`. Preserve the ordered union
        # before projecting lifecycle facts; otherwise cancellation is visible
        # to the response but lost to TaskState terminal derivation.
        runtime_errors = [
            str(item) for item in (runtime_result.errors or []) if str(item).strip()
        ]
        terminal_error = str(getattr(runtime_result, "error", "") or "").strip()
        if terminal_error and terminal_error not in runtime_errors:
            runtime_errors.append(terminal_error)
        metadata = {
            **context.metadata,
            "runtime_engine": "ssot_runtime",
            "ssot_runtime": runtime_result.metadata,
            "timeline_summary": timeline_summary,
            "steps": 1,
            "model": _current_model_name(),
            "llm": {
                "used": True,
                "provider": _current_provider_name(),
                "model": _current_model_name(),
                "task": "assistant_chat",
            },
            # v3.10 (tool retry): top-level projections so the
            # frontend / API consumers don't have to walk through
            # ``metadata.runtime.*`` to find the retry surface. The
            # canonical source stays inside ``metadata.runtime``; the
            # top-level fields are read-only mirrors maintained for
            # convenience. If both fields are present they MUST be
            # byte-identical.
            "retry_summary": dict(
                (runtime_result.metadata or {}).get("retry_summary")
                or {
                    "retry_attempts": 0,
                    "retried_nodes": [],
                    "retry_succeeded": 0,
                    "retry_failed": 0,
                    "retry_blocked": 0,
                },
            ),
            "retry_events": list(
                (runtime_result.metadata or {}).get("retry_events") or []
            ),
            "validation_correction_summary": dict(
                (runtime_result.metadata or {}).get("validation_correction_summary")
                or {}
            ),
            "validation_correction_events": list(
                (runtime_result.metadata or {}).get("validation_correction_events")
                or []
            ),
            "tool_recovery_events": list(
                (runtime_result.metadata or {}).get("tool_recovery_events") or []
            ),
            "recovery_goals": list(
                (runtime_result.metadata or {}).get("recovery_goals") or []
            ),
            "recovery_goal_events": list(
                (runtime_result.metadata or {}).get("recovery_goal_events") or []
            ),
            "goal_loop": dict((runtime_result.metadata or {}).get("goal_loop") or {}),
            "orchestration_batches": list(
                (runtime_result.metadata or {}).get("orchestration_batches") or []
            ),
            "tracking_summary": dict(
                (runtime_result.metadata or {}).get("tracking_summary") or {}
            ),
            "tracking_events": list(
                (runtime_result.metadata or {}).get("tracking_events") or []
            ),
            "provider_recovery_events": list(
                (runtime_result.metadata or {}).get("provider_recovery_events") or []
            ),
            "task_state_persistence": dict(
                (runtime_result.metadata or {}).get("task_state_persistence")
                or metadata_in.get("task_state_persistence")
                or {}
            ),
            "task_state_checkpoint_events": list(
                (runtime_result.metadata or {}).get("task_state_checkpoint_events")
                or []
            ),
            "context_compacted": bool(
                (runtime_result.metadata or {}).get("context_compacted", False)
            ),
            "context_estimated_tokens": int(
                (runtime_result.metadata or {}).get("context_estimated_tokens", 0) or 0
            ),
            "context_budget": dict(
                (runtime_result.metadata or {}).get("context_budget") or {}
            ),
            "context_epochs": list(
                (runtime_result.metadata or {}).get("context_epochs") or []
            ),
            "context_continuation_error": str(
                (runtime_result.metadata or {}).get("context_continuation_error") or ""
            ),
            "execution_outcome": str(
                (runtime_result.metadata or {}).get("execution_outcome")
                or ("complete" if runtime_result.success else "failed")
            ),
            # Server-produced terminal errors are lifecycle facts for TaskState;
            # request metadata never contributes to this list.
            "runtime_errors": list(runtime_errors),
            "tool_execution_outcome": str(
                (runtime_result.metadata or {}).get("tool_execution_outcome")
                or (
                    "complete"
                    if runtime_result.success and not runtime_errors
                    else "failed"
                )
            ),
            "response_outcome": str(
                (runtime_result.metadata or {}).get("response_outcome")
                or ("complete" if runtime_result.success else "failed")
            ),
            "synthesis_recovery": dict(
                (runtime_result.metadata or {}).get("synthesis_recovery") or {}
            ),
            "stage_outputs": list(
                (runtime_result.metadata or {}).get("stage_outputs") or []
            ),
            # Read-only terminal facts for API/UI consumers. QueryLoop remains
            # the only owner of execution, recovery and write fencing.
            "unknown_outcome": (
                dict((runtime_result.metadata or {}).get("unknown_outcome") or {})
                if isinstance(
                    (runtime_result.metadata or {}).get("unknown_outcome"), dict
                )
                else {}
            ),
            "goal_assertions": (
                dict((runtime_result.metadata or {}).get("goal_assertions") or {})
                if isinstance(
                    (runtime_result.metadata or {}).get("goal_assertions"), dict
                )
                else {}
            ),
            "evidence": dict((runtime_result.metadata or {}).get("evidence") or {}),
            # Read-only CognitiveState projection from the SSOT QueryLoop.
            # The adapter mirrors server-owned fields only; request metadata is
            # never consulted for cognitive state.
            "cognitive": (
                dict((runtime_result.metadata or {}).get("cognitive") or {})
                if isinstance((runtime_result.metadata or {}).get("cognitive"), dict)
                else {}
            ),
            "cognitive_events": (
                list((runtime_result.metadata or {}).get("cognitive_events") or [])
                if isinstance(
                    (runtime_result.metadata or {}).get("cognitive_events"), list
                )
                else []
            ),
        }
        failed_tool_count = sum(1 for call in tool_calls if not call.get("ok"))
        successful_tool_count = len(tool_calls) - failed_tool_count
        # An unknown external outcome is a fact for the model to reason about,
        # not a server-owned pause or retry restriction.
        if (
            not runtime_result.success
            and failed_tool_count
            and not runtime_errors
            and metadata["execution_outcome"] != "unknown"
        ):
            runtime_errors.append("all_tool_calls_failed")
        runtime_warnings = []
        if failed_tool_count and successful_tool_count:
            runtime_warnings.append(
                f"partial_tool_failure: {failed_tool_count} failed, {successful_tool_count} succeeded"
            )

        result = AgentResult(
            ok=bool(runtime_result.success),
            final_response=final_response,
            events=events,
            trace_id=trace_id,
            session_id=session_id,
            turn_id=turn.turn_id,
            tool_calls=tool_calls,
            warnings=runtime_warnings,
            errors=runtime_errors,
            metadata=metadata,
            error_type="" if runtime_result.success else "ssot_runtime_error",
            tool_decision=_tool_decision(runtime_result, tool_calls),
            no_tool_reason=""
            if tool_calls
            else "SSOT Runtime planner selected no tools.",
        )

    except _TaskStateResolutionFailure:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        events.append(
            _event(
                "error",
                "TaskState resolution failed",
                trace_id,
                turn.turn_id,
                started_at=started,
            )
        )
        result = AgentResult(
            ok=False,
            final_response=(
                "任务状态无法读取，系统已安全停止，未执行模型或工具。"
                "请稍后重试；不要把本轮视为已完成。"
            ),
            events=events,
            trace_id=trace_id,
            session_id=session_id,
            turn_id=turn.turn_id,
            errors=["task_state_resolution_failed"],
            metadata={
                **context.metadata,
                "runtime_engine": "ssot_runtime",
                "execution_outcome": "failed",
                "tool_execution_outcome": "failed",
                "task_state_persistence": {"stage": "resolution", "status": "failed"},
                "timeline_summary": {
                    "node_count": len(events),
                    "total_duration_ms": elapsed_ms,
                    "artifact_saved_count": 0,
                },
            },
            error_type="task_state_resolution_failed",
            tool_decision={
                "needed": False,
                "reason": "TaskState resolution failed before execution.",
            },
            no_tool_reason="task_state_resolution_failed",
        )
    except Exception as exc:
        _LOG.exception("SSOT Runtime turn failed")
        from storage.redaction import redact_text

        safe_error = redact_text(str(exc))[:500] or "ssot_runtime_error"
        elapsed_ms = int((time.monotonic() - started) * 1000)
        events.append(
            _event(
                "error",
                "SSOT Runtime error",
                trace_id,
                turn.turn_id,
                started_at=started,
            )
        )
        result = AgentResult(
            ok=False,
            final_response="运行时处理失败，系统已安全停止。请稍后重试。",
            events=events,
            trace_id=trace_id,
            session_id=session_id,
            turn_id=turn.turn_id,
            errors=[safe_error],
            metadata={
                **context.metadata,
                "runtime_engine": "ssot_runtime",
                "execution_outcome": "failed",
                "tool_execution_outcome": "failed",
                "timeline_summary": {
                    "node_count": len(events),
                    "total_duration_ms": elapsed_ms,
                    "artifact_saved_count": 0,
                },
            },
            error_type="ssot_runtime_error",
            tool_decision={
                "needed": False,
                "reason": "SSOT Runtime failed before execution.",
            },
            no_tool_reason="ssot_runtime_error",
        )

    # ── Section 2: unified exit — sync session.history for both success
    #    and exception paths so the next turn always has context.
    _sync_session_history(
        session,
        user_input,
        result.final_response,
        include_user=not bool(metadata_in.get("approval_continuation_resume")),
        include_assistant=True,
        run_id=turn.turn_id,
        client_request_id=history_exclude_client_request_id,
    )
    task_state_commit_error = ""
    try:
        from agent.runtime.task_state import commit_task_state

        task_state_snapshot = commit_task_state(
            workspace_id=workspace_id,
            session_id=session_id,
            run_id=turn.turn_id,
            user_input=user_input,
            final_response=result.final_response or "",
            run_ok=bool(result.ok),
            runtime_metadata=_task_state_runtime_metadata(result.metadata),
            tool_calls=list(result.tool_calls or []),
            continuation_contract=task_state_contract,
        )
        if task_state_snapshot and isinstance(result.metadata, dict):
            result.metadata["task_state"] = task_state_snapshot
        elif task_state_snapshot is None:
            # A None result includes a stale continuation CAS.  Do not expose a
            # seemingly completed response whose canonical task state did not
            # advance.
            task_state_commit_error = "task_state_commit_rejected"
    except Exception:
        task_state_commit_error = "task_state_commit_failed"
        _LOG.warning("task state commit failed", exc_info=True)
    if task_state_commit_error:
        _mark_task_state_persistence_failure(result, task_state_commit_error)
    else:
        # Enumerated delivery continuation is a secondary, domain-specific
        # projection.  It may advance only after the generic TaskState SSOT
        # accepted the same terminal turn; otherwise the two stores diverge.
        try:
            from agent.runtime.task_continuation import commit_task_continuation

            task_snapshot = commit_task_continuation(
                workspace_id=workspace_id,
                session_id=session_id,
                run_id=turn.turn_id,
                user_input=user_input,
                assistant_response=result.final_response or "",
                run_ok=bool(result.ok),
                continuation_contract=task_continuation_contract,
            )
            if task_snapshot and isinstance(result.metadata, dict):
                result.metadata["task_continuation"] = task_snapshot
        except Exception:
            _LOG.warning("task continuation commit failed", exc_info=True)

    run_record_persisted = persist_run_record(session, turn, result, context)
    if run_record_persisted is False:
        _mark_run_record_persistence_failure(result, "run_record_persistence_failed")

    # ── Experience journal and memory reflection ─────────────────────
    # Every completed turn is durable experience. Explicit user memory
    # commands are applied immediately; ordinary turns are consolidated only
    # at an operational task boundary or after a small accumulated batch.
    if run_record_persisted is not False:
        _record_experience_and_maybe_reflect(
            workspace_id=workspace_id,
            session_id=session_id,
            task_id=turn.turn_id,
            user_input=user_input,
            assistant_response=result.final_response or "",
            tool_calls=list(result.tool_calls or []),
            task_ok=bool(result.ok),
        )

    return result


def _build_engine(
    *,
    workspace_id: str,
    session_id: str,
    run_id: str,
    trace_id: str,
    allowed_tool_ids=None,
    requested_by: str,
    task_id: str = "",
    emitter: Any | None = None,
    prebuilt_registry: dict[str, dict[str, Any]] | None = None,
    max_query_loop_iterations: int | None = None,
    max_tool_nodes: int | None = None,
    context_budget=None,
    workbench_context: dict[str, Any] | None = None,
):
    from core.runtime_engine import SSOTRuntimeConfig, SSOTRuntimeEngine
    from core.runtime_engine.tool_runtime import ToolRuntime

    config = SSOTRuntimeConfig(
        max_global_concurrency=8,
        max_layer_concurrency=5,
        # Zero means unbounded. A loop ends on the model's final response,
        # cancellation, or an external interruption—not a hidden counter.
        max_llm_calls=0,
        # A turn is goal-driven, not elapsed-time-driven. Per-provider and
        # per-tool transport deadlines still protect unavailable endpoints.
        max_total_seconds=0,
        max_tool_seconds=0,
        single_node_timeout_ms=120_000,
        parallel_layer_timeout_ms=300_000,
        tracking_max_seconds=0,
        # Tracking belongs to the same goal-driven loop.  Zero means it has
        # no hidden poll-count ceiling; only user cancellation or the producer
        # reporting a terminal state ends automatic tracking.
        tracking_max_polls=0,
        tracking_poll_interval_cap_seconds=5,
        max_query_loop_iterations=(
            max(0, int(max_query_loop_iterations))
            if max_query_loop_iterations is not None
            else 0
        ),
        max_nodes=(max(0, int(max_tool_nodes)) if max_tool_nodes is not None else 0),
        max_tool_calls_per_iteration=(
            max(0, int(max_tool_nodes)) if max_tool_nodes is not None else 0
        ),
        context_window_tokens=int(
            getattr(context_budget, "context_window_tokens", 0) or 0
        ),
        max_input_tokens=int(
            getattr(context_budget, "max_input_tokens", 48_000) or 48_000
        ),
        max_output_tokens=int(
            getattr(context_budget, "reserved_output_tokens", 4096) or 4096
        ),
        context_safety_tokens=int(
            getattr(context_budget, "safety_tokens", 2048) or 2048
        ),
    )
    registry = prebuilt_registry or _build_ssot_runtime_tool_registry(allowed_tool_ids)
    client = _tool_runtime_client()
    engine_kwargs: dict[str, Any] = {
        "config": config,
        "llm_invoke": _invoke_llm_for_ssot_runtime,
        "tool_registry": registry,
        "tool_runtime": ToolRuntime(config),
    }
    if emitter is not None:
        engine_kwargs["emitter"] = emitter
    engine = SSOTRuntimeEngine(**engine_kwargs)

    for tool_id in registry:
        engine.register_tool(
            tool_id,
            _make_tool_handler(
                client=client,
                tool_id=tool_id,
                workspace_id=workspace_id,
                session_id=session_id,
                run_id=run_id,
                task_id=task_id,
                trace_id=trace_id,
                requested_by=requested_by,
                skill_id=str((workbench_context or {}).get("skill_id") or ""),
                skill_connection_ids=tuple(
                    str(item)
                    for item in ((workbench_context or {}).get("connection_ids") or [])
                ),
            ),
            description=registry[tool_id].get("description", ""),
            args_schema=registry[tool_id].get("args_schema", {}),
        )
    return engine


def _tool_runtime_client():
    from core.tools.integration import get_default_tool_runtime_client

    return get_default_tool_runtime_client()


def _build_ssot_runtime_tool_registry(allowed_tool_ids=None):
    return build_runtime_catalog(_tool_runtime_client(), allowed_tool_ids)
