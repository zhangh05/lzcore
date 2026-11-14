# agent/runtime/durable/control.py
"""Phase 3: Runtime control primitives — checkpoint, cancel, retry, resume.

Checkpoint snapshots are supported. The independent durable records have no
executor bridge; cancel/retry/resume fail closed without changing task state.

All operations:
- Preserve TaskState as single source of truth
- Write RuntimeEvents for audit
- Enforce workspace boundary
- Redact payloads before persistence
"""

from __future__ import annotations
from typing import Optional
from .models import (
    RuntimeStep, RuntimeEvent, RuntimeCheckpoint,
    _next_id, _now,
)
from .store import append_event, save_checkpoint, get_task

# ── Idempotency / Destructive — derived from Capability Manifest ──


def _get_manifest(tool_id: str | None):
    """Look up manifest for a tool_id. Returns None if not found."""
    if not tool_id:
        return None
    try:
        from core.tools.manifest_registry import get_manifest as gm
        return gm(tool_id)
    except Exception:
        return None


def _is_retryable(step: RuntimeStep) -> bool:
    """Return whether a persisted step has enough information for safe replay.

    RuntimeStep stores a tool id but deliberately does not retain tool
    arguments.  A merged tool can expose both reads and writes, so its
    tool-level manifest cannot prove a particular old step was read-only.
    Never replay such a step on a guess.
    """
    m = _get_manifest(step.tool_id)
    if m and m.destructive:
        return False
    if m and step.tool_id:
        from core.runtime_engine.contracts import ALWAYS_READ_ONLY_TOOLS
        return step.tool_id in ALWAYS_READ_ONLY_TOOLS and m.idempotency == "safe_to_retry"
    # Fallback for non-tool steps: model/message/checkpoint are safe
    return step.kind in ("message", "model", "validation", "checkpoint")


# ── Checkpoint ──

def checkpoint_task(
    task_id: str, ws_id: str, reason: str = "",
    step_id: Optional[str] = None, pending_action: Optional[dict] = None,
) -> Optional[RuntimeCheckpoint]:
    """Create a checkpoint snapshot of the current TaskState."""
    task = get_task(ws_id, task_id)
    if not task:
        return None
    if task.workspace_id != ws_id:
        return None

    cp = RuntimeCheckpoint(
        checkpoint_id=_next_id("cp"),
        task_id=task_id,
        workspace_id=ws_id,
        session_id=task.session_id,
        run_id=task.run_id,
        step_id=step_id or task.current_step_id,
        state_snapshot=task.to_dict(),
        pending_action=pending_action,
        artifact_refs=list(task.artifact_ids),
        created_at=_now(),
    )
    save_checkpoint(cp)

    # Write event
    append_event(RuntimeEvent(
        event_id=_next_id("evt-cp"),
        task_id=task_id, workspace_id=ws_id,
        session_id=task.session_id, run_id=task.run_id,
        step_id=cp.step_id,
        type="checkpoint_created", status="ok",
        title=f"Checkpoint: {reason}" if reason else "Checkpoint created",
        summary=reason,
    ))
    return cp


# ── Cancel ──

def cancel_task(task_id: str, ws_id: str) -> dict:
    """Reject execution control until these records have an executor bridge."""
    task = get_task(ws_id, task_id)
    if not task or task.workspace_id != ws_id:
        return {"ok": False, "error": "task not found in workspace", "status": "not_found"}

    cancellable = {"pending", "running", "interrupting"}
    if task.status not in cancellable:
        # Already terminal — idempotent return
        return {"ok": True, "status": task.status, "message": f"task already {task.status}"}

    return _unsupported("cancel", task_id)


# ── Retry Step ──

def retry_step(task_id: str, step_id: str, ws_id: str) -> dict:
    """Validate the old attempt, then reject unsupported execution control."""
    task = get_task(ws_id, task_id)
    if not task or task.workspace_id != ws_id:
        return {"ok": False, "error": "task not found in workspace"}

    # Find the step
    target = None
    for s in task.steps:
        if s.step_id == step_id:
            target = s
            break
    if not target:
        return {"ok": False, "error": "step not found"}

    if target.status not in ("failed", "cancelled"):
        return {"ok": False, "error": f"step status is {target.status}, can only retry failed/cancelled"}

    # Safety: disallow destructive/non-idempotent retry (from manifest)
    if not _is_retryable(target):
        return {
            "ok": False,
            "error": f"Cannot retry non-idempotent/destructive step: {target.kind}",
            "retry_not_supported": True,
        }

    return _unsupported("retry", task_id)


# ── Resume ──

def resume_task(task_id: str, ws_id: str) -> dict:
    """Reject record-only resume; a checkpoint cannot dispatch an executor."""
    task = get_task(ws_id, task_id)
    if not task or task.workspace_id != ws_id:
        return {"ok": False, "error": "task not found in workspace"}

    resumable = {"interrupted", "failed"}
    if task.status not in resumable:
        return {"ok": False, "error": f"task status {task.status} not resumable"}

    return _unsupported("resume", task_id)


def _unsupported(operation: str, task_id: str) -> dict:
    return {"ok": False, "status": "unsupported", "task_id": task_id,
            "error": "durable_execution_control_unsupported",
            f"{operation}_not_supported": True}
