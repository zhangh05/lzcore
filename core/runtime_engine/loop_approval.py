"""Resume exact external-decision evidence; never replay a frozen operation."""

from __future__ import annotations

from dataclasses import asdict

from agent.llm.schemas import LLMToolCall

from .evidence import evidence_summary, register_tool_evidence
from .loop_messages import (
    StreamingToolResult,
    deserialize_loop_message,
    deserialize_streaming_tool_result,
)


class LoopApprovalContinuation:
    @staticmethod
    def _approval_orchestration_checkpoint(ctx):
        return {
            "version": 1,
            "evidence": [asdict(item) for item in (ctx.extras.get("orchestration_evidence") or {}).values()],
            "depths": dict(ctx.extras.get("orchestration_depths") or {}),
        }

    @staticmethod
    def _restore_approval_orchestration(ctx, resume, prior_results, resolved_round, model_calls):
        from .orchestration import OrchestrationError, StepEvidence, extract_orchestration

        state = (resume.get("context_window_state") or {}).get("runtime_orchestration")
        evidence = {}
        depths = {}
        saved_depths = {}
        if state is not None:
            if not isinstance(state, dict) or state.get("version") != 1:
                raise ValueError("unsupported_approval_orchestration_version")
            for item in state["evidence"]:
                entry = StepEvidence(**item)
                if entry.step_id in evidence:
                    raise ValueError("duplicate_approval_step")
                evidence[entry.step_id] = entry
            saved_depths = dict(state["depths"])
            if set(saved_depths) != set(evidence) or any(
                type(value) is not int or value < 1 for value in saved_depths.values()
            ):
                raise ValueError("invalid_approval_depths")
        calls = {call.id: call for call in model_calls}
        dependencies = {key: list((item.output.get("_orchestration") or {}).get("depends_on") or [])
                        for key, item in evidence.items()}
        for result in [*prior_results, *resolved_round]:
            call = calls.get(result.call_id)
            metadata = (result.output or {}).get("_orchestration") or {}
            previous = next((item for item in evidence.values() if item.call_id == result.call_id), None)
            step_id = str(
                (call.step_id if call else "") or metadata.get("step_id")
                or (previous.step_id if previous else "")
                or extract_orchestration({}, result.call_id)[1]
            )
            depends_on = list(call.depends_on if call else metadata.get("depends_on") or [])
            dependencies[step_id] = depends_on
            # A later retry of a failed step is authoritative, in result order.
            evidence[step_id] = StepEvidence(
                step_id, result.call_id, result.tool_name,
                result.ok and not result.execution_may_continue,
                dict(result.output), result.error or "",
                str((call.arguments if call else {}).get("action")
                    or metadata.get("action")
                    or ((result.output or {}).get("_runtime_readback") or {}).get("action")
                    or (previous.action if previous else "") or ""),
            )

        def depth(step_id, visiting):
            if step_id in depths:
                return depths[step_id]
            if step_id not in evidence or step_id in visiting:
                raise OrchestrationError("invalid_approval_dependency_state")
            depths[step_id] = 1 + max(
                (depth(dependency, visiting | {step_id}) for dependency in dependencies.get(step_id, [])),
                default=0,
            )
            return depths[step_id]

        for step_id in evidence:
            depth(step_id, set())
        if any(depths.get(key) != value for key, value in saved_depths.items()):
            raise ValueError("approval_depth_mismatch")
        ctx.extras["orchestration_evidence"] = evidence
        ctx.extras["orchestration_depths"] = depths

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
            round_metadata = {
                str(item.get("call_id") or ""): (item.get("output") or {}).get("_orchestration") or {}
                for item in stored_round if isinstance(item, dict)
            }
            model_calls = [
                LLMToolCall(
                    id=str(item.get("id") or ""),
                    name=str(item.get("name") or ""),
                    arguments=dict(item.get("arguments") or {}),
                    step_id=str(item.get("step_id") or round_metadata.get(item.get("id"), {}).get("step_id") or ""),
                    depends_on=list(item.get("depends_on", round_metadata.get(item.get("id"), {}).get("depends_on")) or []),
                    result_bindings=dict(item.get("result_bindings") or {}),
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
                    if status == "unknown":
                        raw = {**raw, "ok": False, "status": "unknown", "execution_may_continue": True}
                    resolved_round.append(
                        StreamingToolResult(
                            tool_name=item.tool_name,
                            call_id=item.call_id,
                            output={**raw, "_orchestration": dict((item.output or {}).get("_orchestration") or {})},
                            ok=status == "executed" and bool(raw.get("ok")),
                            error=str(raw.get("error") or "") or None,
                            error_code=str(raw.get("error_code") or ""),
                            execution_may_continue=status == "unknown" or bool(raw.get("execution_may_continue")),
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
            if {item.call_id for item in resolved_round} != {call.id for call in model_calls}:
                raise ValueError("approval_checkpoint_results_incomplete")
            self._restore_approval_orchestration(ctx, resume, prior_results, resolved_round, model_calls)
            register_tool_evidence(
                ctx.extras,
                [*prior_results, *resolved_round],
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
            from .goal_loop import observe_tool_round

            resolved_by_id = {item.call_id: item for item in resolved_round}
            observe_tool_round(
                ctx, model_calls, [resolved_by_id[call.id] for call in model_calls],
                is_read_only_call=self._executor._is_read_only_call,
            )
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
