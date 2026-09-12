"""Durable, append-only experience journal for memory reflection."""

from __future__ import annotations

import uuid
from typing import Any

from storage.ids import validate_session_id, validate_workspace_id
from storage.memory_event_store import (
    append_event,
    delete_journal,
    read_cursor,
    read_events,
    save_cursor,
)
from storage.redaction import redact_text, redact_value
from storage.time_utils import now_iso


def append_experience(
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
    user_input: str,
    assistant_response: str,
    tool_calls: list[dict[str, Any]],
    task_ok: bool,
) -> dict[str, Any]:
    """Persist a completed turn before any LLM decides what is memorable."""
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    tools = []
    for call in list(tool_calls or []):
        if not isinstance(call, dict):
            continue
        tools.append({
            "tool_id": str(call.get("tool_id") or ""),
            "ok": bool(call.get("ok", False)),
            "summary": redact_text(str(call.get("summary") or "")),
            "artifact_ids": [
                str(item.get("artifact_id") or "")
                for item in list(call.get("artifacts") or [])
                if isinstance(item, dict) and item.get("artifact_id")
            ],
        })
    event = redact_value({
        "event_id": f"mex-{uuid.uuid4().hex[:16]}",
        "workspace_id": ws_id,
        "session_id": sid,
        "task_id": str(task_id or ""),
        "created_at": now_iso(),
        "task_ok": bool(task_ok),
        "user_input": redact_text(str(user_input or "")),
        "assistant_response": redact_text(str(assistant_response or "")),
        "tool_calls": tools,
    })
    append_event(ws_id, sid, event)
    return event


def pending_experiences(workspace_id: str, session_id: str, limit: int = 12) -> list[dict[str, Any]]:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    cursor = read_cursor(ws_id, sid)
    processed = set(str(item) for item in list(cursor.get("processed_event_ids") or []))
    rows = read_events(ws_id, sid)
    return [row for row in rows if str(row.get("event_id") or "") not in processed][:max(1, limit)]


def mark_experiences_processed(workspace_id: str, session_id: str, event_ids: list[str]) -> None:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    cursor = read_cursor(ws_id, sid)
    processed = list(dict.fromkeys([
        *list(cursor.get("processed_event_ids") or []),
        *(str(item) for item in event_ids if item),
    ]))
    # Preserve reflection checkpoints: processing a completed batch must not
    # erase the per-proposal journal for another pending batch.
    cursor = dict(cursor)
    cursor.update({
        "session_id": sid,
        "processed_event_ids": processed,
        "updated_at": now_iso(),
    })
    save_cursor(ws_id, sid, cursor)


def delete_experience_journal(workspace_id: str, session_id: str) -> None:
    """Remove session-owned experience and reflection cursor records."""
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    delete_journal(ws_id, sid)
