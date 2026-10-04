"""Resume exact external-decision evidence; never replay a frozen operation."""

from __future__ import annotations

from agent.llm.schemas import LLMToolCall

from .evidence import evidence_summary, register_tool_evidence
from .loop_messages import (
    StreamingToolResult,
    deserialize_loop_message,
    deserialize_streaming_tool_result,
)


class LoopApprovalContinuation:
    def _resume_approval(self, ctx, resume, messages, all_results, cognitive_state):
        cognitive_registered_results = 0
        try:
            if resume.get("context_window_state"):
                self._context_continuation.restore_checkpoint_state(
                    resume["context_window_state"]
                )
                ctx.extras["context_epochs"] = list(self._context_continuation.epochs)
            stored_messages = resume.get("messages") or []
            stored_calls = resume.get("tool_calls") or []
            stored_prior = resume.get("prior_results") or []
            stored_round = resume.get("round_results") or []
            operations = {
                str(item.get("call_id") or ""): item
                for item in (resume.get("operations") or [])
                if isinstance(item, dict)
            }
            messages = [
                deserialize_loop_message(item)
                for item in stored_messages
                if isinstance(item, dict)
            ]
            model_calls = [
                LLMToolCall(
                    id=str(item.get("id") or ""),
                    name=str(item.get("name") or ""),
                    arguments=dict(item.get("arguments") or {}),
                    failure_policy=str(item.get("failure_policy") or "replan"),
                    goal_ids=list(item.get("goal_ids") or []),
                )
                for item in stored_calls
                if isinstance(item, dict)
            ]
            prior_results = [
                deserialize_streaming_tool_result(item)
                for item in stored_prior
                if isinstance(item, dict)
            ]
            round_results = [
                deserialize_streaming_tool_result(item)
                for item in stored_round
                if isinstance(item, dict)
            ]
            if not messages or not model_calls:
                raise ValueError("approval_checkpoint_incomplete")
            resolved_round: list[StreamingToolResult] = []
            for item in round_results:
                operation = operations.get(item.call_id)
                if operation is None:
                    resolved_round.append(item)
                    continue
                status = str(operation.get("status") or "")
                execution = (
                    operation.get("execution")
                    if isinstance(operation.get("execution"), dict)
                    else {}
                )
                raw = (
                    execution.get("result")
                    if isinstance(execution.get("result"), dict)
                    else {}
                )
                if status in {"executed", "unknown"}:
                    resolved_round.append(
                        StreamingToolResult(
                            tool_name=item.tool_name,
                            call_id=item.call_id,
                            output=dict(raw),
                            ok=bool(raw.get("ok")),
                            error=str(raw.get("error") or "") or None,
                            error_code=str(raw.get("error_code") or ""),
                            execution_may_continue=bool(
                                raw.get("execution_may_continue")
                            ),
                        )
                    )
                else:
                    reason = str(
                        operation.get("invalidated_reason")
                        or status
                        or "approval_not_executed"
                    )
                    resolved_round.append(
                        StreamingToolResult(
                            tool_name=item.tool_name,
                            call_id=item.call_id,
                            output={
                                "ok": False,
                                "status": status,
                                "error_code": "approval_" + reason,
                                "operation_id": operation.get("operation_id"),
                                "decision": dict(operation.get("decision") or {}),
                                "execution": execution,
                            },
                            ok=False,
                            error=reason,
                            error_code="APPROVAL_" + reason.upper(),
                        )
                    )
            all_results.extend(prior_results)
            all_results.extend(resolved_round)
            register_tool_evidence(
                ctx.extras,
                resolved_round,
                workspace_id=ctx.workspace_id,
                session_id=ctx.session_id,
                request_id=ctx.request_id,
                user_input=ctx.user_input,
                tool_registry=self._tool_registry,
            )
            cognitive_state.register_tool_results(
                resolved_round, evidence=evidence_summary(ctx.extras)
            )
            cognitive_registered_results = len(all_results)
            messages = self._append_tool_round(messages, model_calls, resolved_round)
            messages = self._append_turn_nudge(
                messages,
                "[EXTERNAL DECISIONS RESOLVED] The exact results for the previously paused tool calls are above. "
                "Continue the original task from this evidence. Do not repeat a settled call; decide the next step yourself.",
            )
            ctx.extras["approval_continuation_resumed"] = {
                "checkpoint_id": str(resume.get("checkpoint_id") or ""),
                "operation_ids": [
                    str(item.get("operation_id") or "") for item in operations.values()
                ],
            }
        except Exception as exc:
            # Keep the normal loop available for a structured error
            # response below; never guess or replay a frozen operation.
            ctx.extras["approval_resume_error"] = str(exc)
            messages = self._append_turn_nudge(
                self._build_initial(ctx),
                "The approval continuation checkpoint is invalid. Do not repeat any prior operation; explain that recovery evidence is unavailable.",
            )
        return messages, cognitive_registered_results
