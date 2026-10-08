"""Domain repository for durable memory experience journals.

The runtime owns experience semantics; this store owns the physical JSON/JSONL
layout, cursors, and deletion.  Control-plane code must not call the generic
record adapter directly.
"""

from __future__ import annotations

from typing import Any, Callable

from storage.locking import FileLock

from storage.ids import validate_session_id, validate_workspace_id
from storage.records import (
    append_jsonl,
    atomic_save_json,
    delete_record_path,
    read_json_record,
    read_jsonl,
    workspace_record_file,
)


def append_event(workspace_id: str, session_id: str, event: dict[str, Any]) -> dict[str, Any]:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    return append_jsonl(ws_id, _journal_parts(sid), event)


def read_events(workspace_id: str, session_id: str) -> list[dict[str, Any]]:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    return read_jsonl(ws_id, _journal_parts(sid))


def read_cursor(workspace_id: str, session_id: str) -> dict[str, Any]:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    return read_json_record(ws_id, _cursor_parts(sid)) or {}


def save_cursor(workspace_id: str, session_id: str, cursor: dict[str, Any]) -> None:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    atomic_save_json(ws_id, _cursor_parts(sid), cursor)


def delete_journal(workspace_id: str, session_id: str) -> None:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    with reflection_lock(ws_id, sid):
        for parts in (_journal_parts(sid), _cursor_parts(sid)):
            path = workspace_record_file(ws_id, *parts, create_parent=False)
            delete_record_path(path)


def _journal_parts(session_id: str) -> tuple[str, ...]:
    return ("memory", "experiences", f"{session_id}.jsonl")


def _cursor_parts(session_id: str) -> tuple[str, ...]:
    return ("memory", "reflection", f"{session_id}.json")


def reflection_lock(workspace_id: str, session_id: str) -> FileLock:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    path = workspace_record_file(ws_id, *_cursor_parts(sid), create_parent=True)
    return FileLock(path.with_suffix('.reflection.lock'))


def update_cursor(workspace_id: str, session_id: str, update: Callable[[dict], dict]) -> dict:
    ws_id = validate_workspace_id(workspace_id)
    sid = validate_session_id(session_id)
    path = workspace_record_file(ws_id, *_cursor_parts(sid), create_parent=True)
    with FileLock(path.with_suffix('.transaction.lock')):
        value = update(dict(read_cursor(ws_id, sid)))
        save_cursor(ws_id, sid, value)
        return value


def finish_batch(workspace_id: str, session_id: str, event_ids: list[str], batch_id: str = '') -> dict:
    from storage.time_utils import now_iso

    def complete(cursor):
        cursor['processed_event_ids'] = list(dict.fromkeys([
            *cursor.get('processed_event_ids', []), *event_ids,
        ]))
        batches = dict(cursor.get('consolidation_batches') or {})
        if batch_id:
            batches.pop(batch_id, None)
        cursor.update(consolidation_batches=batches, session_id=session_id, updated_at=now_iso())
        return cursor
    return update_cursor(workspace_id, session_id, complete)
