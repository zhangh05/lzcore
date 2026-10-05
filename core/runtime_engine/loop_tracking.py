"""Producer tracking, cancellation, checkpoint degradation and wait lifecycle."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from agent.llm.schemas import LLMToolCall

from .loop_messages import StreamingToolResult, _json_compact, _redact_tool_error
from .models import StatelessContext
from .tracking import extract_tracking_payload, normalize_tracking_payload


class LoopTracking:
    """Producer tracking, cancellation, checkpoint degradation and wait lifecycle. Shared context belongs to the QueryLoop driver."""

    @staticmethod
    def _should_poll_tracking(user_input: str, tracking: dict) -> bool:
        """Track every producer-declared long task within runtime budgets."""
        if tracking.get("done"):
            return False
        if tracking.get("auto_polling") == "stopped":
            return False
        action = str(tracking.get("suggested_next_action") or "").lower()
        if action and action != "poll_get":
            return False
        return str(tracking.get("kind") or "") == "long_task"

    async def _settle_tracking(
        self,
        ctx: StatelessContext,
        results: list[StreamingToolResult],
        budget=None,
    ) -> list[StreamingToolResult]:
        """After tool execution, observe producer-declared long tasks.

        Automatic polling is only an optimisation while a producer keeps
        returning a valid, non-terminal tracking contract.  A failed poll or
        a poll that no longer declares tracking is an observation for the LLM,
        not permission for the runtime to spin forever against stale
        ``done=false`` metadata.  Every observation is returned intact so the
        model can choose the next action from the complete history.
        """
        tracked_results: list[StreamingToolResult] = []
        if not getattr(self._config, "tracking_enabled", True):
            return []

        cap_seconds = float(
            getattr(self._config, "tracking_poll_interval_cap_seconds", 2.0)
        )
        grace_seconds = max(0.0, float(
            getattr(self._config, "tracking_no_progress_grace_seconds", 120.0)
        ))
        deadline = float("inf")
        user_input = ctx.user_input or ""
        states: list[dict[str, Any]] = []

        for r in results:
            tracking = extract_tracking_payload(r.output)
            if not tracking:
                continue
            tracking = normalize_tracking_payload(tracking)

            if tracking.get("done"):
                continue

            # Producer-declared tracking avoids keyword or intent guessing.
            if not self._should_poll_tracking(user_input, tracking):
                continue

            task_id = str(tracking.get("task_id") or "").strip()
            # Use the canonical tool name from result, not domain from tracking
            tool_name = (r.tool_name or "").strip()
            if not task_id or not tool_name:
                continue
            if not self._tool_runtime.has_tool(tool_name):
                continue

            ctx.extras.setdefault("tracking_events", [])
            ctx.extras["tracking_events"].append(
                {
                    "tool": tool_name,
                    "call_id": r.call_id,
                    "tracking": tracking,
                    "source": "initial",
                }
            )
            ctx.extras["tracking_summary"] = tracking

            states.append(
                {
                    "result": r,
                    "tracking": tracking,
                    "task_id": task_id,
                    "tool_name": tool_name,
                    "poll_index": 0,
                    "last_error_count": 0,
                    # Quiet intervals are normal while a producer computes or
                    # waits for a model/tool. Require sustained inactivity before
                    # handing the same live state back to another LLM round.
                    "observation_key": self._tracking_observation_key(tracking),
                    "last_progress_at": time.monotonic(),
                    "due_at": time.monotonic()
                    + self._tracking_wait(tracking, cap_seconds, deadline),
                }
            )

        state_by_source = {state["result"].call_id: state for state in states}

        def stop_polling(state, poll_result, reason):
            # Observer control is separate from producer lifecycle. A quiet or
            # unavailable poll never proves that the underlying task ended.
            tracking = dict(state["tracking"])
            payload = dict(poll_result.output or {})
            payload["tracking"] = {
                **tracking,
                "auto_polling": "stopped",
                "stop_reason": reason,
            }
            payload["tracking_prior_state"] = tracking
            poll_result.output = payload
            state["auto_polling_stopped"] = True
            state["tracking"] = payload["tracking"]
            ctx.extras["tracking_summary"] = payload["tracking"]
            ctx.extras["tracking_events"].append({
                "tool": state["tool_name"],
                "call_id": poll_result.call_id,
                "tracking": payload["tracking"],
                "source": "auto_polling_stopped",
                "poll_index": state["poll_index"],
                "reason": reason,
            })

        # Poll the earliest-due task first, then requeue it.  A valid running
        # producer may continue while progress arrives; sustained inactivity
        # pauses only this observer. Cancellation and failed reads stay prompt.
        while states and not self._is_cancelled(ctx):
            states = [state for state in states if not (
                state["tracking"].get("done") or state.get("auto_polling_stopped")
            )]
            if not states:
                break
            state = min(states, key=lambda item: float(item["due_at"]))
            wait_s = min(
                max(0.0, float(state["due_at"]) - time.monotonic()),
                max(0.0, deadline - time.monotonic()),
            )
            if wait_s > 0 and await self._sleep_until_poll_or_cancel(ctx, wait_s):
                break

            state["poll_index"] = int(state["poll_index"]) + 1
            poll_index = int(state["poll_index"])
            source_result = state["result"]
            tracking = state["tracking"]
            tool_name = str(state["tool_name"])
            task_id = str(state["task_id"])
            poll_call_id = f"{source_result.call_id}_track_{poll_index}"
            poll_arguments = dict(tracking.get("poll_arguments") or {})
            # A producer-declared polling contract is authoritative. Different
            # tools intentionally use different identifiers (for example
            # ``subtask_id`` and ``job_id``); injecting a generic ``task_id``
            # corrupts closed schemas. The generic fallback exists only for
            # producers that supplied no polling arguments.
            if poll_arguments:
                poll_arguments.setdefault(
                    "action", str(tracking.get("poll_action") or "get")
                )
            else:
                poll_arguments = {
                    "action": str(tracking.get("poll_action") or "get"),
                    "task_id": task_id,
                }
            poll_call = LLMToolCall(
                id=poll_call_id,
                name=tool_name,
                arguments=poll_arguments,
            )
            try:
                poll_result = await self._executor._execute_one(
                    poll_call, ctx=ctx, budget=budget
                )
                tracked_results.append(poll_result)

                new_tracking = extract_tracking_payload(poll_result.output)
                if new_tracking:
                    tracking = normalize_tracking_payload(new_tracking)
                    state["tracking"] = tracking
                    ctx.extras["tracking_summary"] = tracking
                    ctx.extras["tracking_events"].append(
                        {
                            "tool": tool_name,
                            "call_id": poll_call_id,
                            "tracking": tracking,
                            "source": "poll",
                            "poll_index": poll_index,
                        }
                    )
                if not poll_result.ok or not new_tracking:
                    # Do not keep polling stale ``done=false`` metadata after
                    # an actual tool failure or a producer contract breach.
                    # Preserve the original producer state alongside the
                    # exact poll result; the next LLM turn decides whether to
                    # retry, inspect, delegate, or finish.
                    reason = (
                        "tracking_poll_failed"
                        if not poll_result.ok
                        else "tracking_contract_missing"
                    )
                    stop_polling(state, poll_result, reason)
                    continue
                observation_key = self._tracking_observation_key(tracking)
                observed_at = time.monotonic()
                if (
                    not tracking.get("done")
                    and observation_key == state["observation_key"]
                    and observed_at - state["last_progress_at"] >= grace_seconds
                ):
                    # This is an observer pause, not a producer deadline. Keep
                    # exact lifecycle facts and allow a later explicit read.
                    stop_polling(state, poll_result, "tracking_no_progress")
                    continue
                if observation_key != state["observation_key"]:
                    state["last_progress_at"] = observed_at
                state["observation_key"] = observation_key
                state["due_at"] = time.monotonic() + self._tracking_wait(
                    state["tracking"], cap_seconds, deadline
                )
            except Exception as e:
                poll_result = StreamingToolResult(
                    tool_name=tool_name,
                    call_id=poll_call_id,
                    output={},
                    ok=False,
                    error="poll_crash: " + _redact_tool_error(e),
                )
                tracked_results.append(poll_result)
                stop_polling(state, poll_result, "tracking_poll_crash")

        for result in tracked_results:
            if not isinstance(result.output, dict):
                continue
            source_call_id = str(result.call_id).rsplit("_track_", 1)[0]
            state = state_by_source.get(source_call_id)
            if state is None:
                continue
            result.output.setdefault("tracking_poll_count", int(state["poll_index"]))
            result.output.setdefault("tracking_source_call_id", source_call_id)
        return tracked_results

    @staticmethod
    def _tracking_observation_key(tracking: dict[str, Any]) -> str:
        """Stable producer-state identity for automatic polling only.

        Deliberately omit poll counters and timing hints: they describe the
        polling mechanism, not a change in the producer's actual state.
        Producers can expose a revision/timestamp in ``observation_token``
        when progress is not represented by ``status`` or ``progress``.
        """
        progress = (
            tracking.get("progress")
            if isinstance(tracking.get("progress"), dict)
            else {}
        )
        return _json_compact(
            {
                "status": str(tracking.get("status") or ""),
                "done": bool(tracking.get("done")),
                "progress": progress,
                "observation_token": str(
                    tracking.get("observation_token")
                    or tracking.get("revision")
                    or tracking.get("updated_at")
                    or ""
                ),
            }
        )

    async def _sleep_until_poll_or_cancel(
        self,
        ctx: StatelessContext,
        seconds: float,
    ) -> bool:
        """Sleep in short slices so a user stop is observed promptly."""
        wake_at = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < wake_at:
            if self._is_cancelled(ctx):
                return True
            await asyncio.sleep(min(0.25, max(0.0, wake_at - time.monotonic())))
        return self._is_cancelled(ctx)

    async def _wait_for_provider_recovery(
        self,
        ctx: StatelessContext,
        failure_count: int,
    ) -> bool:
        """Wait between provider retries without imposing a retry ceiling."""
        delay = min(5.0, 0.25 * (2 ** min(max(0, failure_count - 1), 5)))
        return not await self._sleep_until_poll_or_cancel(ctx, delay)

    @staticmethod
    def _record_checkpoint_degradation(
        ctx: StatelessContext,
        phase: str,
        error: Exception,
    ) -> None:
        """Record persistence trouble as runtime evidence, never a loop gate."""
        events = ctx.extras.setdefault("task_state_checkpoint_events", [])
        if not isinstance(events, list):
            events = []
            ctx.extras["task_state_checkpoint_events"] = events
        events.append(
            {
                "phase": str(phase),
                "status": "degraded",
                "error": _redact_tool_error(error),
            }
        )

    @staticmethod
    def _task_state_checkpoint_nudge(ctx: StatelessContext) -> str:
        """Expose checkpoint degradation without replacing tool evidence."""
        events = ctx.extras.get("task_state_checkpoint_events") or []
        if not isinstance(events, list) or not events:
            return ""
        latest = events[-1] if isinstance(events[-1], dict) else {}
        if latest.get("nudge_delivered"):
            return ""
        latest["nudge_delivered"] = True
        return (
            "[RUNTIME PERSISTENCE OBSERVATION] Task-state checkpoint persistence is degraded, "
            "but the complete tool results above are real execution evidence. Continue the original "
            "goal from those results; do not claim the persistence layer succeeded."
        )

    @staticmethod
    def _is_cancelled(ctx: StatelessContext) -> bool:
        check = ctx.extras.get("cancel_check")
        if not callable(check):
            return False
        try:
            return bool(check())
        except Exception:
            return False

    def _tracking_wait(self, tracking: dict, cap: float, deadline: float) -> float:
        """Calculate poll wait time, capped and bounded by deadline."""
        try:
            requested = float(tracking.get("next_poll_seconds") or 0)
        except (TypeError, ValueError):
            requested = 0.0
        remaining = max(0.0, deadline - time.monotonic())
        cap = max(0.0, cap)
        if requested <= 0 or cap <= 0 or remaining <= 0:
            return 0.0
        return max(0.0, min(requested, cap, remaining))
