"""Network inspections domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import as_completed
from typing import Any, Callable

from storage.principal import ContextThreadPoolExecutor
from storage.time_utils import now_iso

from .network_execution import collect_connection, commands_for
from .network_findings import _derive_findings
from .network_observations import record_inspection_observation
from .network_planning import (
    _inspection_assets,
    _inspection_connections,
    _inspection_target_id,
    _new_connection_inspection_task,
    _restore_command_plan,
)
from .network_records import EXTENSION_ID, _store, get_inspection

_INSPECTION_JOB_TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


class _DurableCancellation:
    """Cancellation probe backed by the canonical durable job record."""

    def __init__(self, workspace_id: str, job_id: str):
        self.workspace_id = workspace_id
        self.job_id = job_id

    def is_set(self) -> bool:
        from jobs.store import get_job

        job = get_job(self.workspace_id, self.job_id)
        return bool(job and job.cancel_requested)


def _enqueue_prepared_inspection(
    workspace_id: str, task: dict[str, Any], *, created_by: str
) -> dict[str, Any]:
    from jobs.manager import create_job

    job = create_job(
        workspace_id=workspace_id,
        job_type="network_inspection",
        title=f"网络巡检 · {task['script'].get('name') or task['task_id']}",
        payload={"task_id": task["task_id"]},
        created_by=created_by,
        enqueue=False,
        # The job is a worker implementation detail.  Inspection evidence and
        # progress belong to the network extension/workbench, not the user's
        # task centre alongside independently requested tasks.
        metadata={"task_center_visible": False, "job_role": "internal_inspection"},
    )
    task["job_id"] = job.job_id
    _store(workspace_id).save("inspections", task["task_id"], task)
    try:
        from jobs.manager import enqueue_job

        enqueue_job(workspace_id, job.job_id)
    except Exception:
        task.update(
            {
                "status": "failed",
                "error": "inspection_enqueue_failed",
                "finished_at": now_iso(),
                "updated_at": now_iso(),
            }
        )
        _store(workspace_id).save("inspections", task["task_id"], task)
        raise
    return get_inspection(workspace_id, task["task_id"]) or task


def enqueue_connection_inspection(
    workspace_id: str,
    connection_ids: list[str] | None,
    commands: list[str] | None = None,
    script_id: str = "",
    *,
    facts: list[str] | None = None,
    created_by: str = "user",
) -> dict[str, Any]:
    """Create a durable inspection; each target reconnects and fails independently."""
    task, _targets, _script = _new_connection_inspection_task(
        workspace_id, connection_ids, commands, script_id, facts=facts
    )
    return _enqueue_prepared_inspection(workspace_id, task, created_by=created_by)


def execute_queued_inspection(
    workspace_id: str, task_id: str, job_id: str
) -> dict[str, Any]:
    task = get_inspection(workspace_id, task_id)
    if not task:
        raise ValueError("inspection_not_found")
    assets = (
        _inspection_connections(workspace_id, list(task.get("connection_ids") or []))
        if task.get("connection_ids")
        else _inspection_assets(workspace_id, list(task.get("asset_ids") or []))
    )
    commands, script, facts = _restore_command_plan(task)
    cancel = _DurableCancellation(workspace_id, job_id)
    _execute_inspection(
        workspace_id,
        task_id,
        assets,
        commands,
        collect_connection,
        cancel,
        script,
        facts,
    )
    return get_inspection(workspace_id, task_id) or task


def finalize_inspection_job(workspace_id: str, task_id: str, job_id: str) -> bool:
    """Hard-delete a terminal internal Job while preserving inspection evidence."""
    from jobs.store import delete_job, get_job

    job = get_job(workspace_id, job_id)
    if (
        not job
        or job.job_type != "network_inspection"
        or job.status not in _INSPECTION_JOB_TERMINAL_STATUSES
    ):
        return False
    task = get_inspection(workspace_id, task_id) if task_id else None
    if task and str(task.get("job_id") or "") == job_id:
        task.pop("job_id", None)
        task.pop("cancel_requested", None)
        task["updated_at"] = now_iso()
        _store(workspace_id).save("inspections", task_id, task)
    return delete_job(workspace_id, job_id, soft=False)


def _execute_inspection(
    workspace_id: str,
    task_id: str,
    targets: list[dict[str, Any]],
    commands: list[str] | None,
    collector: Callable,
    cancel: Any,
    script: dict[str, Any] | None = None,
    facts: list[str] | None = None,
) -> None:
    store = _store(workspace_id)
    task = store.get("inspections", task_id) or {}
    if cancel.is_set():
        task.update(
            {"status": "cancelled", "finished_at": now_iso(), "updated_at": now_iso()}
        )
        store.save("inspections", task_id, task)
        return
    task.update({"status": "running", "started_at": now_iso(), "updated_at": now_iso()})
    store.save("inspections", task_id, task)

    def run_one(target: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        from core.tools.context import (
            bind_runtime_cancel_check,
            reset_runtime_cancel_check,
        )

        target_id = _inspection_target_id(target)
        if cancel.is_set():
            return target_id, {"status": "cancelled", "name": target["name"]}
        started = time.monotonic()
        cancel_token = bind_runtime_cancel_check(cancel.is_set)
        try:
            selected = None if facts else commands_for(target, commands, script)
            live = collector(target, selected, facts=facts, session_scope=task_id)
            if not live.get("ok"):
                raise RuntimeError(str(live.get("error") or "device connection failed"))
            raw = {
                str(key): str(value)
                for key, value in (live.get("output") or {}).items()
            }
            selected = [
                str(item.get("command") or "")
                for item in (live.get("command_results") or [])
                if item.get("command")
            ]
            target_status = "succeeded" if live.get("read_ok") else "partial"
            diagnostics = [
                {
                    key: item.get(key)
                    for key in (
                        "command",
                        "fact",
                        "complete",
                        "pages",
                        "encoding",
                        "error_code",
                        "device_error",
                        "truncated",
                        "duration_ms",
                        "dispatch_status",
                    )
                }
                for item in (live.get("command_results") or [])
            ]
            normalized = json.dumps(raw, ensure_ascii=False, sort_keys=True)
            return target_id, {
                "status": target_status,
                "name": target["name"],
                "host": target["host"],
                "commands": selected,
                "output_hash": hashlib.sha256(normalized.encode()).hexdigest(),
                "facts": live.get("facts"),
                "command_results": diagnostics,
                "_raw_output": raw,
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        except Exception as exc:
            return target_id, {
                "status": "failed",
                "name": target["name"],
                "host": target["host"],
                "error": str(exc)[:300],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        finally:
            reset_runtime_cancel_check(cancel_token)

    workers = min(5, max(1, len(targets)))
    raw_outputs: dict[str, dict[str, str]] = {}
    with ContextThreadPoolExecutor(
        max_workers=workers, thread_name_prefix="network-inspection"
    ) as pool:
        futures = [pool.submit(run_one, target) for target in targets]
        for future in as_completed(futures):
            target_id, result = future.result()
            raw = result.pop("_raw_output", None)
            if isinstance(raw, dict):
                raw_outputs[target_id] = raw
            task["results"][target_id] = result
            task["completed"] += 1
            task["succeeded"] += int(result["status"] == "succeeded")
            task["partial"] = int(task.get("partial") or 0) + int(
                result["status"] == "partial"
            )
            task["failed"] += int(result["status"] == "failed")
            task["updated_at"] = now_iso()
            store.save("inspections", task_id, task)
    task["status"] = (
        "cancelled"
        if cancel.is_set()
        else "succeeded"
        if task["failed"] == 0 and int(task.get("partial") or 0) == 0
        else "partial"
        if task["succeeded"] > 0 or int(task.get("partial") or 0) > 0
        else "failed"
    )
    task["finished_at"] = now_iso()
    task["updated_at"] = now_iso()
    try:
        task["artifact_id"] = _save_evidence_artifact(workspace_id, task, raw_outputs)
        task["findings"] = _derive_findings(workspace_id, task, raw_outputs)
        task["finding_count"] = len(task["findings"])
        observation = record_inspection_observation(workspace_id, task)
        task["observation_id"] = observation["observation_id"]
        task["candidate_reference_id"] = str(
            observation.get("candidate_reference_id") or ""
        )
        store.save("inspections", task_id, task)
    except Exception:
        task.update(
            {
                "status": "failed",
                "error": "inspection_evidence_persist_failed",
                "finished_at": now_iso(),
                "updated_at": now_iso(),
            }
        )
        store.save("inspections", task_id, task)
        raise


def _save_evidence_artifact(
    workspace_id: str, task: dict[str, Any], raw_outputs: dict[str, dict[str, str]]
) -> str:
    from artifacts.store import save_artifact
    from core.tools.redaction import redact_tool_output

    # Device observations are the evidence the selected agent must reason over.
    # Store the complete command transcript in an LLM-readable internal
    # artifact, applying only deterministic credential redaction.  Marking the
    # whole transcript ``secret`` made workspace.artifact return a placeholder
    # and silently removed the very evidence needed for diagnosis.
    evidence_payload = redact_tool_output({**task, "raw_outputs": raw_outputs})
    artifact = save_artifact(
        workspace_id=workspace_id,
        content=json.dumps(evidence_payload, ensure_ascii=False, indent=2),
        artifact_type="output_data",
        title=f"网络巡检证据 {task['task_id']}",
        sensitivity="internal",
        module=EXTENSION_ID,
        capability_id="network_inspection",
        metadata={
            "inspection_task_id": task["task_id"],
            "evidence_authority": "status_baseline_inspection",
        },
        tags=["network", "inspection", "evidence"],
        created_by="extension:network.operations",
    )
    return artifact.artifact_id if artifact else ""
