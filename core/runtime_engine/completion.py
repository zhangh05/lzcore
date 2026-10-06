"""Record trusted checks when the model ends its turn, without directing repair."""

from __future__ import annotations

import asyncio

from storage.redaction import redact_value


def terminal_completion(observation):
    if not observation or observation["status"] == "passed":
        return None
    if observation["status"] == "unknown":
        return {"error": "completion_outcome_unknown"}
    return {"error": str(observation.get("terminal_error") or "completion_check_failed")}


async def observe_completion(ctx):
    check = ctx.extras.get("__completion_check")
    if not callable(check):
        return None
    try:
        observed = await asyncio.to_thread(check)
        if not isinstance(observed, dict) or observed.get("status") not in {"passed", "failed", "unknown"}:
            raise ValueError("invalid_completion_observation")
        observed = redact_value(observed)
    except Exception as exc:
        observed = {"status": "unknown", "error": type(exc).__name__,
                    "automatic_retry_allowed": False}
    ctx.extras["completion_observation"] = observed
    ctx.extras.setdefault("completion_events", []).append(observed)
    return observed
