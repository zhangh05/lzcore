"""Persisted subagent task repository."""

from __future__ import annotations

from typing import Any

from storage.records import atomic_save_json, list_json_records, read_json_record, workspace_record_file
from storage.locking import FileLock


def task_control_lock(workspace_id: str, subtask_id: str) -> FileLock:
    """Serialize task claims and status transitions across worker processes."""
    return FileLock(workspace_record_file(workspace_id, "subagent-controls", f"{subtask_id}.lock"))


def save_subagent(workspace_id: str, subtask_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """Save metadata while retaining the first durable terminal result."""
    with task_control_lock(workspace_id, subtask_id):
        previous = read_subagent(workspace_id, subtask_id)
        payload = dict(record)
        if previous:
            for field in ("subtask_id", "workspace_id", "parent_task_id", "session_id", "profile_id"):
                if previous.get(field) != payload.get(field):
                    raise ValueError("subagent_identity_is_immutable")
            if previous.get("status") in {"succeeded", "failed", "cancelled"}:
                for field in ("status", "summary", "finished_at", "errors", "warnings"):
                    payload[field] = previous.get(field)
        atomic_save_json(workspace_id, ("subagents", f"{subtask_id}.json"), payload)
        return payload


def read_subagent(workspace_id: str, subtask_id: str) -> dict[str, Any] | None:
    return read_json_record(workspace_id, ("subagents", f"{subtask_id}.json"))


def list_subagents(workspace_id: str, limit: int) -> list[dict[str, Any]]:
    return list_json_records(workspace_id, ("subagents",), limit=limit)
