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
from .network_records import _store, get_inspection, _connection_transaction


@_connection_transaction
def retry_inspection(workspace_id: str, task_id: str) -> dict[str, Any]:
    task = get_inspection(workspace_id, task_id)
    if not task or task.get("status") not in {"failed", "cancelled", "partial"}:
        raise ValueError("retryable inspection task is required")
    followup_id = str(task.get("retry_task_id") or "")
    if followup_id:
        followup = get_inspection(workspace_id, followup_id)
        if not followup:
            raise ValueError("inspection_retry_record_unavailable")
        return followup
    commands, script, facts = _restore_command_plan(task)
    is_connection_task = bool(task.get("connection_ids"))
    original_targets = list(task.get("connection_ids" if is_connection_task else "asset_ids") or [])
    results = task.get("results") or {}
    recollect_evidence = task.get("error") == "inspection_evidence_persist_failed"
    retry_targets = [target for target in original_targets
                     if recollect_evidence or (results.get(target) or {}).get("status") != "succeeded"]
    if not retry_targets:
        raise ValueError("inspection_has_no_retryable_targets")
    assets = (
        _inspection_connections(workspace_id, retry_targets)
        if is_connection_task
        else _inspection_assets(workspace_id, retry_targets)
    )
    next_task = _build_inspection_task(assets, commands, script, facts=facts)
    next_task["retry_of_task_id"] = task_id
    next_task["retry_scope"] = "evidence_recollection" if recollect_evidence else "unsuccessful_targets"
    # Persist the relation before dispatch. A lost HTTP response or a second
    # click reads the same follow-up; retrying that follow-up is a new step.
    _store(workspace_id).save("inspections", next_task["task_id"], next_task)
    task["retry_task_id"] = next_task["task_id"]
    _store(workspace_id).save("inspections", task_id, task)
    try:
        retried = _enqueue_prepared_inspection(workspace_id, next_task, created_by="retry")
    except Exception:
        current = get_inspection(workspace_id, next_task["task_id"])
        if current and not current.get("job_id"):
            current.update(status="failed", error="inspection_job_create_failed", finished_at=now_iso(), updated_at=now_iso())
            _store(workspace_id).save("inspections", current["task_id"], current)
        raise
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
