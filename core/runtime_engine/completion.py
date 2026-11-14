"""Record trusted checks when the model ends its turn, without directing repair."""

from __future__ import annotations

import asyncio
import time

from storage.redaction import redact_value
from storage.principal import ContextThreadPoolExecutor

COMPLETION_CHECK_TIMEOUT_SECONDS = 30.0
COMPLETION_POLL_SECONDS = 0.05


def _cancelled(ctx):
    check = ctx.extras.get("cancel_check")
    return bool(check()) if callable(check) else False


def terminal_completion(observation):
    if observation and observation.get("cancelled"):
        return {"error": "cancelled_by_user"}
    if not observation or observation["status"] == "passed":
        return None
    if observation["status"] == "unknown":
        return {"error": "completion_outcome_unknown"}
    return {"error": str(observation.get("terminal_error") or "completion_check_failed")}


async def observe_completion(ctx, budget=None):
    check = ctx.extras.get("__completion_check")
    if not callable(check):
        return None
    task = None
    executor = None
    try:
        if _cancelled(ctx):
            return {"status": "unknown", "cancelled": True}
        # A timed-out observer must not keep asyncio.run() blocked while it
        # shuts down its default executor. Preserve principal/context in a
        # separately owned worker and report any continued observation.
        executor = ContextThreadPoolExecutor(max_workers=1, thread_name_prefix="completion-check")
        task = asyncio.wrap_future(executor.submit(check))
        deadline = time.monotonic() + COMPLETION_CHECK_TIMEOUT_SECONDS
        while not task.done():
            if _cancelled(ctx):
                observed = {"status": "unknown", "cancelled": True,
                            "error": "cancelled_by_user"}
                break
            if budget is not None and not budget.check_execution().ok:
                observed = {"status": "unknown", "error": "budget_exhausted"}
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                observed = {"status": "unknown", "error": "completion_check_timeout"}
                break
            await asyncio.wait({task}, timeout=min(COMPLETION_POLL_SECONDS, remaining))
        else:
            observed = task.result()
        if _cancelled(ctx):
            observed = {"status": "unknown", "cancelled": True,
                        "error": "cancelled_by_user"}
        if not isinstance(observed, dict) or observed.get("status") not in {"passed", "failed", "unknown"}:
            raise ValueError("invalid_completion_observation")
        if not task.done():
            observed.update(check_may_continue=True, automatic_retry_allowed=False)
        observed = redact_value(observed)
    except Exception as exc:
        observed = {"status": "unknown", "error": type(exc).__name__,
                    "automatic_retry_allowed": False}
    finally:
        if task is not None and not task.done():
            # This cancels only the wait: the synchronous observer may still
            # run. Its late result must never replace the terminal observation.
            task.cancel()
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
    ctx.extras["completion_observation"] = observed
    ctx.extras.setdefault("completion_events", []).append(observed)
    return observed
