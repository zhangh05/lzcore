"""Persisted subagent task repository."""

from __future__ import annotations

from typing import Any
import threading
import time
import weakref

from storage.records import atomic_save_json, list_json_records, read_json_record, workspace_record_file
from storage.locking import FileLock

# A wake-up hint only. Records remain authoritative across principals,
# processes and restarts; bounded rechecks cover notifications we cannot see.
_CONDITIONS_LOCK = threading.RLock()
_CONDITIONS = weakref.WeakValueDictionary()


def _observation_condition(workspace_id: str):
    key = str(workspace_record_file(workspace_id, "subagents", "observation").parent.resolve())
    with _CONDITIONS_LOCK:
        condition = _CONDITIONS.get(key)
        if condition is None:
            condition = threading.Condition()
            _CONDITIONS[key] = condition
        return condition
_TERMINAL = {"succeeded", "failed", "cancelled"}


def task_control_lock(workspace_id: str, subtask_id: str) -> FileLock:
    """Serialize task claims and status transitions across worker processes."""
    return FileLock(workspace_record_file(workspace_id, "subagent-controls", f"{subtask_id}.lock"))


def save_subagent(workspace_id: str, subtask_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """Save metadata while retaining the first durable terminal result."""
    with task_control_lock(workspace_id, subtask_id):
        previous = read_subagent(workspace_id, subtask_id)
        payload = dict(record)
        if previous:
            observations = {**previous.get("observations", {}), **payload.get("observations", {})}
            if "activity" in previous.get("observations", {}):
                observations["activity"] = previous["observations"]["activity"]
            payload["observations"] = observations
            for field in ("subtask_id", "workspace_id", "parent_task_id", "session_id", "profile_id"):
                if previous.get(field) != payload.get(field):
                    raise ValueError("subagent_identity_is_immutable")
            if previous.get("status") in {"succeeded", "failed", "cancelled"}:
                for field in ("status", "summary", "finished_at", "errors", "warnings", "result_artifact_id", "result_total_chars"):
                    payload[field] = previous.get(field)
        payload["observation_revision"] = int((previous or {}).get("observation_revision", 0))
        if payload != previous:
            payload["observation_revision"] += 1
            atomic_save_json(workspace_id, ("subagents", f"{subtask_id}.json"), payload)
    condition = _observation_condition(workspace_id)
    with condition:
        condition.notify_all()
    return payload


def record_subagent_activity(workspace_id: str, subtask_id: str, event: str, tool: str = "", action: str = "") -> None:
    """Persist runtime facts, never provider text, arguments or guessed percent."""
    from datetime import datetime, timezone
    with task_control_lock(workspace_id, subtask_id):
        record = read_subagent(workspace_id, subtask_id)
        if not record or record.get("status") in _TERMINAL:
            return
        observations = dict(record.get("observations") or {})
        activity = dict(observations.get("activity") or {})
        activity.update(event=event, tool=tool, action=action,
                        updated_at=datetime.now(timezone.utc).isoformat())
        if event == "model_completed":
            activity["model_responses"] = int(activity.get("model_responses", 0)) + 1
        if event == "tool_result":
            activity["tool_results"] = int(activity.get("tool_results", 0)) + 1
        observations["activity"] = activity
        record["observations"] = observations
        record["observation_revision"] = int(record.get("observation_revision", 0)) + 1
        atomic_save_json(workspace_id, ("subagents", f"{subtask_id}.json"), record)
    condition = _observation_condition(workspace_id)
    with condition:
        condition.notify_all()


def wait_subagent_observations(workspace_id: str, subtask_ids: list[str], *, after_revision: dict,
                              wait_for: str, until: str, seconds: float, cancel_check=None) -> dict:
    """Wait any/all for changes or terminal facts; timeout never changes tasks."""
    deadline = time.monotonic() + seconds
    condition = _observation_condition(workspace_id)
    refresh_at, notified, records = 0.0, True, None
    with condition:
        while True:
            if notified or time.monotonic() >= min(refresh_at, deadline):
                records = [read_subagent(workspace_id, identity) for identity in subtask_ids]
                refresh_at = time.monotonic() + 1.0
            if any(record is None for record in records):
                raise ValueError("subtask not found")
            ready = [record["status"] in _TERMINAL or (until == "change" and
                     int(record.get("observation_revision", 0)) > int(after_revision.get(record["subtask_id"], -1)))
                     for record in records]
            cancelled = bool(cancel_check and cancel_check())
            timed_out = time.monotonic() >= deadline
            satisfied = all(ready) if wait_for == "all" else any(ready)
            if satisfied or cancelled or timed_out:
                return {"records": records, "changed_ids": [record["subtask_id"] for record, changed in zip(records, ready) if changed],
                        "timed_out": timed_out and not satisfied, "observation_cancelled": cancelled}
            notified = condition.wait(min(0.25, max(0, deadline - time.monotonic())))


def read_subagent(workspace_id: str, subtask_id: str) -> dict[str, Any] | None:
    return read_json_record(workspace_id, ("subagents", f"{subtask_id}.json"))


def list_subagents(workspace_id: str, limit: int) -> list[dict[str, Any]]:
    return list_json_records(workspace_id, ("subagents",), limit=limit)
