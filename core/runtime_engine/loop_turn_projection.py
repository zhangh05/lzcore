"""One terminal projection for every QueryLoop exit; no execution or retry ownership."""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Any

from .context_compaction import estimate_chars as _estimate_chars
from .context_compaction import estimate_message_tokens as _estimate_message_tokens
from .evidence import evidence_summary
from .loop_messages import QueryLoopResult


class LoopTurnProjection:
    def _finish_turn(
        self,
        *,
        ctx,
        t_start,
        all_results,
        iterations,
        llm_calls,
        messages,
        metrics,
        execution_duration_ms,
        validation_correction_attempts,
        cognitive_state,
        cognitive_registered_results,
        cognitive_events_emitted,
        values: dict[str, Any],
    ) -> QueryLoopResult:
        """Build every exit projection with the same runtime metrics."""
        if (
            values.get("error") == "cancelled_by_user"
            or (ctx.extras.get("synthesis_recovery") or {}).get("error")
            == "cancelled_by_user"
        ):
            values["error"] = "cancelled_by_user"
            values["final_response"] = (
                "任务已取消。已完成的操作及证据保留在运行记录中；未完成或结果未知的写入没有自动重跑。"
                if all_results
                else "任务已取消。"
            )
            ctx.extras["response_outcome"] = "cancelled"
        try:
            self._context_continuation.persist_terminal(
                messages, ctx, error=values.get("error"), final_response=values.get("final_response"))
        except (OSError, RuntimeError, TypeError, ValueError):
            # Never overwrite an execution failure or retry its effects because
            # evidence storage is unavailable; make the missing archive visible.
            ctx.extras["terminal_context_archive_error"] = "context_archive_persist_failed"
            values["error"] = values.get("error") or "context_archive_persist_failed"
        projected_metrics = {
            "elapsed_ms": (time.monotonic() - t_start) * 1000,
            "iterations": iterations,
            "tool_calls": len(all_results),
            "llm_calls": values.get("llm_calls", llm_calls),
            "context_estimated_chars": _estimate_chars(messages),
            "context_estimated_tokens": _estimate_message_tokens(messages),
            "context_compacted": (
                metrics.snapshot().context_compacted if metrics else False
            ),
            "context_budget": self._context_budget.as_dict(),
            "context_epochs": list(ctx.extras.get("context_epochs") or []),
            "terminal_context_epoch": dict(ctx.extras.get("terminal_context_epoch") or {}),
            "terminal_context_archive_error": str(ctx.extras.get("terminal_context_archive_error") or ""),
            "context_continuation_error": str(
                ctx.extras.get("context_continuation_error") or ""
            ),
            "execution_duration_ms": execution_duration_ms,
            "max_parallel_width": self._executor.max_parallel_width,
            "orchestration_batches": list(
                ctx.extras.get("orchestration_batches") or []
            ),
            "batch_compile_events": list(ctx.extras.get("batch_compile_events") or []),
            "validation_corrections": validation_correction_attempts,
            "batch_replans": 0,
            "evidence": evidence_summary(ctx.extras),
            "response_outcome": str(ctx.extras.get("response_outcome") or "complete"),
            "synthesis_recovery": dict(ctx.extras.get("synthesis_recovery") or {}),
            "stage_outputs": list(ctx.extras.get("stage_outputs") or []),
            "prompt_policy_events": list(ctx.extras.get("prompt_policy_events") or []),
            "llm_usage": self._aggregate_llm_usage(ctx.extras),
            "active_capability_playbooks": list(
                ctx.extras.get("active_capability_playbooks") or []
            ),
            "safe_read_recovery_events": list(
                ctx.extras.get("safe_read_recovery_events") or []
            ),
            "recovery_goals": list(ctx.extras.get("recovery_goals") or []),
            "recovery_goal_events": list(ctx.extras.get("recovery_goal_events") or []),
            "goal_loop_observations": list(
                ctx.extras.get("goal_loop_observations") or []
            )[-256:],
            "task_state_execution_manifest": list(
                ctx.extras.get("task_state_execution_manifest") or []
            )[-128:],
        }
        metric_overrides = dict(values.pop("metrics", {}) or {})
        projected_metrics.update(metric_overrides)
        # Reconcile each uncertain operation against causally later evidence.
        # One reconciled operation cannot mask another unknown write or error.
        unknown_outcome = ctx.extras.get(
            "unknown_outcome_reconciliation"
        ) or ctx.extras.get("unknown_outcome")
        effective_results = []
        for result in all_results:
            output = result.output or {}
            if not result.execution_may_continue or output.get("read_only"):
                effective_results.append(result)
                continue
            pending = {
                "tool_id": result.tool_name.replace("__", "."),
                "call_id": result.call_id,
                "operation_id": output.get("operation_id"),
                "operation_finished_at": output.get("operation_finished_at"),
                "connection_id": (output.get("_runtime_write") or {}).get("connection_id"),
            }
            if isinstance(unknown_outcome, dict) and (
                unknown_outcome.get("call_id") == result.call_id
                or (pending["operation_id"] and unknown_outcome.get("operation_id") == pending["operation_id"])
            ):
                pending = {**unknown_outcome, **{key: value for key, value in pending.items() if value}}
            readback = self._late_network_readback(all_results, pending)
            if readback is not None and pending.get("operation_id"):
                from .operation_ledger import settle_operation

                try:
                    settled = settle_operation(
                        ctx.workspace_id, pending["operation_id"], status="reconciled",
                        resolved_by="network_readback",
                        resolution_reason=f"same_connection_readback:{readback.call_id}",
                    )
                except (OSError, RuntimeError, TypeError, ValueError):
                    readback = None
                else:
                    if settled.get("status") != "reconciled":
                        readback = None
            if readback is None:
                effective_results.append(result)
                continue
            effective_results.append(replace(result, execution_may_continue=False))
            if isinstance(unknown_outcome, dict) and unknown_outcome.get("call_id") == pending["call_id"]:
                unknown_outcome = {**pending, "status": "reconciled", "reconciled_by_call_id": readback.call_id}
                ctx.extras["unknown_outcome_reconciliation"] = unknown_outcome
        if isinstance(unknown_outcome, dict) and unknown_outcome:
            projected_metrics["unknown_outcome"] = dict(unknown_outcome)
        from .goal_assertions import evaluate_goal_assertions

        assertion_result = evaluate_goal_assertions(ctx, all_results)
        projected_metrics["goal_assertions"] = assertion_result
        from .goal_loop import goal_loop_summary

        projected_metrics["goal_loop"] = goal_loop_summary(ctx)
        if assertion_result["required"] and assertion_result["status"] != "passed":
            if assertion_result["status"] == "unknown" or not any(
                bool(getattr(item, "ok", False)) for item in all_results
            ):
                values.setdefault("error", "goal_assertion_not_satisfied")
            else:
                ctx.extras["response_outcome"] = "partial"
                projected_metrics["response_outcome"] = "partial"
        from .turn_outcome import (
            derive_execution_outcome,
            derive_tool_execution_outcome,
        )

        projected_metrics["tool_execution_outcome"] = derive_tool_execution_outcome(
            all_results
        )
        projected_metrics["execution_outcome"] = (
            "unknown"
            if (ctx.extras.get("completion_observation") or {}).get("status") == "unknown"
            else "unknown"
            if metric_overrides.get("execution_outcome") == "unknown"
            else "waiting_external_input"
            if metric_overrides.get("execution_outcome") == "waiting_external_input"
            else derive_execution_outcome(
                effective_results,
                terminal_error=values.get("error"),
                goal_assertions=assertion_result,
            )
        )
        unregistered_cognitive_results = all_results[cognitive_registered_results:]
        if unregistered_cognitive_results:
            cognitive_state.register_tool_results(
                unregistered_cognitive_results,
                evidence=(
                    projected_metrics["evidence"]
                    if isinstance(projected_metrics["evidence"], dict)
                    else None
                ),
            )
            cognitive_registered_results = len(all_results)
        cognitive_state.set_decision(
            "model_directed",
            reason_codes=["runtime_facts_delivered"],
            visible_summary="完整工具结果已提供给模型，由模型决定下一步。",
        )
        cognitive_state.set_outcome(
            "model_directed",
            reason_codes=["runtime_facts_delivered"],
            visible_summary="完整工具结果已提供给模型，由模型决定下一步。",
        )
        cognitive_state._append(
            "cognitive_model_state_recorded",
            {
                "outcome": "model_directed",
                "reason_codes": ["runtime_facts_delivered"],
                "terminal": False,
            },
        )
        projected_metrics["cognitive"] = cognitive_state.summary()
        projected_metrics["cognitive_events"] = list(cognitive_state.events)
        ctx.extras["cognitive_state"] = cognitive_state.as_trace_payload()
        if self._emitter is not None:
            for event in cognitive_state.events[cognitive_events_emitted:]:
                self._emitter.emit(event["type"], event)
        cognitive_events_emitted = len(cognitive_state.events)
        values.setdefault("tool_results", all_results)
        values.setdefault("iterations", iterations)
        values.setdefault("total_tool_calls", len(all_results))
        values.setdefault("llm_calls", llm_calls)
        from .failure_attribution import collect
        projected_metrics["failure_attributions"] = collect(
            errors=[values.get("error")], tool_calls=all_results, run_id=ctx.request_id,
            failed=bool(values.get("error")), provider_events=ctx.extras.get("provider_recovery_events", []),
            retry_events=ctx.extras.get("retry_events", []))
        projected_metrics["runtime_fact_projection"] = ctx.extras.get("runtime_fact_projection", {})
        return QueryLoopResult(metrics=projected_metrics, **values)
