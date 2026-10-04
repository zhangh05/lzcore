"""Immutable, principal/workspace/session scoped model-window archives.

Window replacement is not history deletion. Each archive has a content digest
and a parent reference; callers can retrieve an explicit range without loading
the complete transcript back into the provider window.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from storage.atomic_io import atomic_write_json, safe_read_json
from storage.locking import FileLock
from storage.records import workspace_record_file
from storage.redaction import redact_value

SCHEMA = "runtime.context_epoch.v1"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _path(workspace_id: str, session_id: str, checkpoint_id: str):
    if not re.fullmatch(r"ctx_[0-9a-f]{32}", str(checkpoint_id)):
        raise ValueError("invalid_context_checkpoint_id")
    return workspace_record_file(workspace_id, "sessions", session_id, "context_epochs", checkpoint_id + ".json")


def save_epoch(workspace_id: str, session_id: str, request_id: str,
               messages: list[dict], state: dict, parent_id: str = "") -> dict:
    if parent_id:
        read_epoch(workspace_id, session_id, parent_id)
    payload = redact_value({"schema": SCHEMA, "workspace_id": workspace_id,
        "session_id": session_id, "request_id": request_id, "parent_id": parent_id,
        "messages": messages, "state": state})
    digest = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()
    checkpoint_id = "ctx_" + digest[:32]
    record = {"checkpoint_id": checkpoint_id, "sha256": digest, "payload": payload}
    path = _path(workspace_id, session_id, checkpoint_id)
    with FileLock(path.with_suffix(".lock")):
        if path.exists():
            existing = read_epoch(workspace_id, session_id, checkpoint_id)
            if existing != record:
                raise ValueError("context_checkpoint_conflict")
        else:
            atomic_write_json(path, record)
    return record


def read_epoch(workspace_id: str, session_id: str, checkpoint_id: str) -> dict:
    path = _path(workspace_id, session_id, checkpoint_id)
    record = safe_read_json(path, default=None)
    if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
        raise ValueError("context_checkpoint_not_found")
    payload = record["payload"]
    digest = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()
    if (record.get("sha256") != digest or checkpoint_id != "ctx_" + digest[:32]
        or payload.get("workspace_id") != workspace_id or payload.get("session_id") != session_id
        or payload.get("schema") != SCHEMA):
        raise ValueError("context_checkpoint_integrity_failed")
    return record


def read_index(workspace_id: str, session_id: str, checkpoint_id: str,
               offset: int = 0, limit: int = 30) -> dict:
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError("invalid_context_index_range")
    record = read_epoch(workspace_id, session_id, checkpoint_id)
    messages = record["payload"]["messages"]
    rows = []
    for index, message in enumerate(messages[offset:offset + limit], offset):
        rows.append({"message_index": index, "role": message["role"],
                     "tool_call_id": message.get("tool_call_id"),
                     "tool_calls": [{"id": call.get("id"), "name": (call.get("function") or {}).get("name")}
                                    for call in message.get("tool_calls") or []],
                     "chars": len(_json(message))})
    return {"checkpoint_id": checkpoint_id, "sha256": record["sha256"],
            "parent_id": record["payload"]["parent_id"], "total": len(messages),
            "offset": offset, "records": rows,
            "next_offset": offset + len(rows) if offset + len(rows) < len(messages) else None,
            "source_kind": "archived_conversation", "trust": "untrusted_data"}


def read_message_chunk(workspace_id: str, session_id: str, checkpoint_id: str,
                       message_index: int, char_offset: int = 0, char_limit: int = 8000) -> dict:
    if message_index < 0 or char_offset < 0 or not 1 <= char_limit <= 32000:
        raise ValueError("invalid_context_message_range")
    record = read_epoch(workspace_id, session_id, checkpoint_id)
    messages = record["payload"]["messages"]
    if message_index >= len(messages):
        raise ValueError("context_message_not_found")
    text = _json(messages[message_index])
    chunk = text[char_offset:char_offset + char_limit]
    return {"checkpoint_id": checkpoint_id, "sha256": record["sha256"],
            "message_index": message_index, "char_offset": char_offset,
            "total_chars": len(text), "text_chunk": chunk,
            "next_char_offset": char_offset + len(chunk) if char_offset + len(chunk) < len(text) else None,
            "source_kind": "archived_conversation", "trust": "untrusted_data",
            "redaction_applied": True}
