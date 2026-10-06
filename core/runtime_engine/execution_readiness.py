"""Trusted execution-resource lifecycle, separate from provider and goal state."""

from __future__ import annotations

import asyncio


async def observe_execution_readiness(ctx):
    check = ctx.extras.get("__execution_readiness_check")
    if not callable(check):
        return None
    try:
        observed = await asyncio.to_thread(check)
        if not isinstance(observed, dict) or observed.get("status") not in {"ready", "unavailable"}:
            raise ValueError("invalid_execution_readiness")
        if observed["status"] == "ready":
            return None
        observation = {key: observed.get(key) for key in (
            "status", "reason", "cleanup_confirmed", "execution_may_continue",
        )}
    except Exception as exc:  # noqa: BLE001 -- A failed lifecycle probe must stop execution without exposing its payload.
        observation = {"status": "unknown", "reason": type(exc).__name__,
                       "cleanup_confirmed": False, "execution_may_continue": True}
    observation["automatic_retry_allowed"] = False
    ctx.extras["execution_readiness"] = observation
    ctx.extras["response_outcome"] = "execution_environment_unavailable"
    metrics = {"execution_readiness": observation}
    if observation["execution_may_continue"] or observation["status"] == "unknown":
        metrics["execution_outcome"] = "unknown"
    return {
        "error": "execution_readiness_unknown" if observation["status"] == "unknown" else "execution_environment_unavailable",
        "final_response": "执行环境已不可用，已保留工程、工具结果与失败证据；清理未确认或结果未知的操作没有自动重放。协调者须核对状态后明确重新安排执行。",
        "metrics": metrics,
    }
