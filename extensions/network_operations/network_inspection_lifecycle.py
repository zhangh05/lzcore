"""Network inspection lifecycle domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

from typing import Any

from storage.time_utils import now_iso

from .network_inspections import _enqueue_prepared_inspection, finalize_inspection_job
from .network_planning import (
    _build_inspection_task,
    _inspection_assets,
    _inspection_connections,
    _restore_command_plan,
)
from .network_records import _store, get_inspection


def retry_inspection(workspace_id: str, task_id: str) -> dict[str, Any]:
    task = get_inspection(workspace_id, task_id)
    if not task or task.get("status") not in {"failed", "cancelled", "partial"}:
        raise ValueError("retryable inspection task is required")
    commands, script, facts = _restore_command_plan(task)
    is_connection_task = bool(task.get("connection_ids"))
    assets = (
        _inspection_connections(workspace_id, list(task.get("connection_ids") or []))
        if is_connection_task
        else _inspection_assets(workspace_id, list(task.get("asset_ids") or []))
    )
    next_task = _build_inspection_task(assets, commands, script, facts=facts)
    retried = _enqueue_prepared_inspection(
        workspace_id,
        next_task,
        created_by="retry",
    )
    retried["retry_of_task_id"] = task_id
    _store(workspace_id).save("inspections", retried["task_id"], retried)
    return retried


def cancel_inspection(workspace_id: str, task_id: str) -> bool:
    task = get_inspection(workspace_id, task_id)
    if not task or task.get("status") not in {"queued", "running"}:
        return False
    job_id = str(task.get("job_id") or "")
    if job_id:
        try:
            from jobs.manager import cancel_job

            job = cancel_job(workspace_id, job_id)
        except ValueError:
            return False
        task["cancel_requested"] = True
        task["updated_at"] = now_iso()
        if job.status == "cancelled":
            task.update({"status": "cancelled", "finished_at": now_iso()})
        _store(workspace_id).save("inspections", task_id, task)
        if job.status == "cancelled":
            finalize_inspection_job(workspace_id, task_id, job_id)
        return True
    # Historical tasks without a durable job have no live worker to cancel.
    task.update({"status": "cancelled", "finished_at": now_iso()})
    task["cancel_requested"] = True
    task["updated_at"] = now_iso()
    _store(workspace_id).save("inspections", task_id, task)
    return True
