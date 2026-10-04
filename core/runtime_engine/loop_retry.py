"""Read retry decisions, attempt evidence and terminal outcome classification."""

from __future__ import annotations

import asyncio
import time

from .models import ExecutionNode, StatelessContext, ToolResult


class ReadRetryPolicy:
    """Retry only governed reads; unknown writes remain owned by the operation ledger."""

    async def _maybe_retry_node(
        self,
        node: ExecutionNode,
        ctx: StatelessContext,
        original_result: ToolResult,
        budget,
    ) -> ToolResult:
        from .contracts import get_retry_contract
        from .tool_retry_policy import should_retry_tool_failure

        contract = get_retry_contract(node.tool, node.args)
        current_result = original_result
        total_latency_ms = float(original_result.latency_ms or 0.0)

        while not current_result.success:
            current_result = self._normalize_read_timeout_for_retry(
                node, current_result
            )
            error_code = self._retry_error_code(current_result)
            budget_ok = (
                bool(budget.check_execution().ok) if budget is not None else True
            )
            decision = should_retry_tool_failure(
                node=node,
                tool_contract=contract,
                error_code=error_code,
                error_message=current_result.error or "",
                config_max_retries=(
                    int(getattr(contract, "max_retries", 0) or 0)
                    if contract is not None
                    else 0
                ),
                global_max_retries_per_node=self._config.max_retries_per_node,
                budget_ok=budget_ok,
            )
            event_index = self._record_retry_decision(ctx, node, decision)
            if not decision.retry_allowed:
                return current_result

            await asyncio.sleep(decision.backoff_ms / 1000.0)
            # A retry that was legal before backoff may no longer fit in the
            # request budget afterwards. Never start it once the deadline has
            # elapsed.
            if budget is not None and not budget.check_execution().ok:
                self._record_retry_aborted(
                    ctx, event_index, "budget_exceeded_after_backoff"
                )
                return current_result

            node.retry_count += 1
            retry_started = time.monotonic()
            current_result = await self._runtime.execute_node(node, ctx, {})
            current_result = self._normalize_read_timeout_for_retry(
                node, current_result
            )
            retry_duration_ms = (time.monotonic() - retry_started) * 1000
            total_latency_ms += retry_duration_ms + float(decision.backoff_ms)
            current_result.retry_count = node.retry_count
            current_result.metadata = dict(current_result.metadata or {})
            current_result.metadata.update(
                {
                    "retried": True,
                    "retry_count": node.retry_count,
                    "retry_reason": decision.reason,
                    "retry_backoff_ms": decision.backoff_ms,
                    "retry_error_code": decision.error_code,
                    "retry_original_error": decision.notes.get("original_error", ""),
                    "retry_total_latency_ms": total_latency_ms,
                }
            )
            self._record_retry_result(
                ctx,
                node,
                current_result,
                event_index=event_index,
                duration_ms=retry_duration_ms,
            )

        return current_result

    def _normalize_read_timeout_for_retry(
        self,
        node: ExecutionNode,
        result: ToolResult,
    ) -> ToolResult:
        """Turn an uncertain *read* timeout into the canonical retryable timeout.

        The worker may still finish, so that fact remains in audit metadata.
        Replaying an idempotent read cannot duplicate a mutation, however, and
        must use the normal retry policy without altering write behavior.
        Write and unknown-action calls retain ``TOOL_TIMEOUT_UNCERTAIN``.
        """
        if (
            result.success
            or str(result.error_code or "").upper() != "TOOL_TIMEOUT_UNCERTAIN"
        ):
            return result
        from .contracts import is_read_only_call

        if not is_read_only_call(
            node.tool,
            node.args,
            self._tool_registry.get(node.tool.replace("__", ".")),
        ):
            return result
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "read_only": True,
                "read_execution_may_continue": bool(
                    metadata.get("execution_may_continue", True)
                ),
                "execution_may_continue": False,
                "timeout_normalized_for_retry": True,
            }
        )
        result.metadata = metadata
        result.error_code = "TOOL_TIMEOUT"
        result.error_code_norm = "TOOL_TIMEOUT"
        return result

    @staticmethod
    def _retry_error_code(result: ToolResult) -> str:
        error_code = (result.error_code or "").strip().upper()
        # Generic handler failure carries no retry semantics. Infer only a
        # narrow set of transient classes from the normalized error text.
        if error_code and error_code != "TOOL_RETURNED_NOT_OK":
            return error_code
        err = (result.error or "").lower()
        if any(
            token in err
            for token in (
                "authentication",
                "permission denied",
                "password",
                "credential",
            )
        ):
            return "CREDENTIAL_ACCESS"
        if any(
            token in err
            for token in (
                "security check failed",
                "forbidden",
                "policy blocked",
                "not allowed",
                "blocked:",
                "workspace_mismatch",
            )
        ):
            return "POLICY_BLOCKED"
        if "timeout" in err or "timed out" in err:
            return "TOOL_TIMEOUT"
        if "rate" in err and "limit" in err:
            return "RATE_LIMITED"
        if "connection" in err and "reset" in err:
            return "CONNECTION_RESET"
        for status in (429, 500, 502, 503, 504):
            if f"http {status}" in err or f"status {status}" in err:
                return f"HTTP_{status}"
        if any(
            token in err
            for token in (
                " is required",
                "invalid ",
                "unknown action",
                "unsupported ",
                "not found",
                "no such ",
                "does not exist",
                "_not_found",
                "not_found",
                "_required",
                "unsupported_",
                "unknown_",
                "artifact_empty",
                "empty_document",
            )
        ):
            return "ARGS_INVALID"
        return "TOOL_EXCEPTION"

    @staticmethod
    def _has_safe_read_recovery(node: ExecutionNode, result: ToolResult) -> bool:
        """Recognise a registered handler's typed, read-only fallback."""
        payload = result.data if isinstance(result.data, dict) else {}
        published = payload.get("runtime_recoveries")
        directives = (
            published
            if isinstance(published, list)
            else [payload.get("runtime_recovery")]
        )
        return any(
            isinstance(directive, dict)
            and directive.get("kind")
            in {"safe_read_fallback", "documentation_read_fallback"}
            and isinstance(directive.get("arguments"), dict)
            for directive in directives
        )

    @staticmethod
    def _record_retry_decision(
        ctx: StatelessContext, node: ExecutionNode, decision
    ) -> int:
        events = list(ctx.extras.get("retry_events") or [])
        # Exhaustion is the terminal state of the retry attempt already
        # recorded for this node, not a second "not retried" incident. Merge
        # it into that event so audit and UI both report one coherent recovery
        # story per tool call.
        if decision.reason == "max_retries_exhausted":
            for index in range(len(events) - 1, -1, -1):
                event = events[index]
                if event.get("node_id") != node.id:
                    continue
                events[index] = {
                    **event,
                    "exhausted": True,
                    "terminal_reason": decision.reason,
                }
                ctx.extras["retry_events"] = events
                return index
        events.append(
            {
                **decision.to_dict(),
                "node_id": node.id,
                "tool_id": node.tool,
            }
        )
        ctx.extras["retry_events"] = events
        summary = dict(
            ctx.extras.get("retry_summary")
            or {
                "retry_attempts": 0,
                "retried_nodes": [],
                "retry_succeeded": 0,
                "retry_failed": 0,
                "retry_blocked": 0,
            }
        )
        if not decision.retry_allowed:
            summary["retry_blocked"] = int(summary.get("retry_blocked", 0) or 0) + 1
        ctx.extras["retry_summary"] = summary
        return len(events) - 1

    @staticmethod
    def _record_retry_result(
        ctx: StatelessContext,
        node: ExecutionNode,
        result: ToolResult,
        *,
        event_index: int,
        duration_ms: float,
    ) -> None:
        summary = dict(
            ctx.extras.get("retry_summary")
            or {
                "retry_attempts": 0,
                "retried_nodes": [],
                "retry_succeeded": 0,
                "retry_failed": 0,
                "retry_blocked": 0,
            }
        )
        summary["retry_attempts"] = int(summary.get("retry_attempts", 0) or 0) + 1
        nodes = list(summary.get("retried_nodes") or [])
        if node.id not in nodes:
            nodes.append(node.id)
        summary["retried_nodes"] = nodes
        if result.success:
            summary["retry_succeeded"] = int(summary.get("retry_succeeded", 0) or 0) + 1
        else:
            summary["retry_failed"] = int(summary.get("retry_failed", 0) or 0) + 1
        ctx.extras["retry_summary"] = summary
        events = list(ctx.extras.get("retry_events") or [])
        if 0 <= event_index < len(events):
            events[event_index] = {
                **events[event_index],
                "attempt": node.retry_count,
                "final_status": "succeeded" if result.success else "failed",
                "duration_ms": round(float(duration_ms or 0.0), 3),
                "result_error_code": result.error_code or "",
            }
            ctx.extras["retry_events"] = events

    @staticmethod
    def _record_retry_aborted(
        ctx: StatelessContext, event_index: int, reason: str
    ) -> None:
        events = list(ctx.extras.get("retry_events") or [])
        if 0 <= event_index < len(events):
            events[event_index] = {
                **events[event_index],
                "retry_allowed": False,
                "blocked_by_policy": False,
                "final_status": "aborted",
                "reason": reason,
            }
            ctx.extras["retry_events"] = events
        summary = dict(ctx.extras.get("retry_summary") or {})
        summary["retry_blocked"] = int(summary.get("retry_blocked", 0) or 0) + 1
        ctx.extras["retry_summary"] = summary
