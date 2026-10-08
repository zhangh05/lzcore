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


def _container_tool_call(call: dict) -> bool:
    function = call.get("function") or {}
    name = str(function.get("name") or "").replace("__", ".")
    if name == "exec.run":
        return True
    if name != "system.manage":
        return False
    try:
        arguments = json.loads(function.get("arguments") or "{}")
    except (TypeError, ValueError):
        return False
    return isinstance(arguments, dict) and arguments.get("action") in {"context_index", "context_read", "context_search"}


def _redact_json_text(value, container_paths: bool):
    if not isinstance(value, str):
        return redact_value(value, container_paths=container_paths)
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return redact_value(value, container_paths=container_paths)
    safe = redact_value(parsed, container_paths=container_paths)
    return value if safe == parsed else json.dumps(safe, ensure_ascii=False)


def _redact_messages(messages: list[dict], container_paths: bool) -> list[dict]:
    safe = redact_value(messages)
    public_calls = set()
    for original, projected in zip(messages, safe):
        if original.get("role") == "assistant":
            calls = original.get("tool_calls") or []
            public_calls.update(call.get("id") for call in calls if container_paths and _container_tool_call(call))
            for call, safe_call in zip(calls, projected.get("tool_calls") or []):
                safe_call["function"]["arguments"] = _redact_json_text(
                    call["function"].get("arguments", ""),
                    container_paths and _container_tool_call(call),
                )
            native = (original.get("protocol") or {}).get("openai", {}).get("tool_calls") or []
            safe_native = (projected.get("protocol") or {}).get("openai", {}).get("tool_calls") or []
            for call, safe_call in zip(native, safe_native):
                safe_call["function"]["arguments"] = _redact_json_text(
                    call["function"].get("arguments", ""),
                    container_paths and _container_tool_call(call),
                )
            native_blocks = (original.get("protocol") or {}).get("anthropic") or []
            safe_blocks = (projected.get("protocol") or {}).get("anthropic") or []
            for block, safe_block in zip(native_blocks, safe_blocks):
                if block.get("type") != "tool_use":
                    continue
                call = {"function": {"name": block.get("name"),
                    "arguments": json.dumps(block.get("input") or {})}}
                safe_block["input"] = redact_value(block.get("input"),
                    container_paths=container_paths and _container_tool_call(call))
        elif original.get("role") == "tool":
            projected["content"] = _redact_json_text(original.get("content"),
                original.get("tool_call_id") in public_calls)
    return safe


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _path(
    workspace_id: str, session_id: str, checkpoint_id: str, *, create: bool = False
):
    if not re.fullmatch(r"ctx_[0-9a-f]{32}", str(checkpoint_id)):
        raise ValueError("invalid_context_checkpoint_id")
    return workspace_record_file(
        workspace_id,
        "sessions",
        session_id,
        "context_epochs",
        checkpoint_id + ".json",
        create_parent=create,
    )


def save_epoch(
    workspace_id: str,
    session_id: str,
    request_id: str,
    messages: list[dict],
    state: dict,
    parent_id: str = "",
    *,
    container_paths: bool = False,
) -> dict:
    if parent_id:
        read_epoch(workspace_id, session_id, parent_id)
    payload = redact_value(
        {
            "schema": SCHEMA,
            "workspace_id": workspace_id,
            "session_id": session_id,
            "request_id": request_id,
            "parent_id": parent_id,
            "messages": messages,
            "state": state,
        }
    )
    payload["messages"] = _redact_messages(messages, container_paths)
    digest = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()
    checkpoint_id = "ctx_" + digest[:32]
    record = {"checkpoint_id": checkpoint_id, "sha256": digest, "payload": payload}
    path = _path(workspace_id, session_id, checkpoint_id, create=True)
    with FileLock(path.with_suffix(".lock")):
        if path.exists():
            existing = read_epoch(workspace_id, session_id, checkpoint_id)
            if existing != record:
                raise ValueError("context_checkpoint_conflict")
        else:
            atomic_write_json(path, record)
    return record


def list_epochs(
    workspace_id: str, session_id: str, offset: int = 0, limit: int = 30
) -> dict:
    """Discover durable archives after restart, without trusting a mutable head.

    Records are content-addressed. An interrupted publication cannot publish a
    head pointing at absent evidence. Pagination is over stable checkpoint IDs.
    """
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError("invalid_context_index_range")
    from storage.records import workspace_record_dir

    directory = workspace_record_dir(
        workspace_id, "sessions", session_id, "context_epochs", create=False
    )
    paths = sorted(directory.glob("ctx_*.json"))
    rows = []
    for path in paths[offset : offset + limit]:
        record = read_epoch(workspace_id, session_id, path.stem)
        rows.append(
            {
                "checkpoint_id": record["checkpoint_id"],
                "sha256": record["sha256"],
                "parent_id": record["payload"]["parent_id"],
                "request_id": record["payload"]["request_id"],
                "archived_messages": len(record["payload"]["messages"]),
            }
        )
    return {
        "records": rows,
        "total": len(paths),
        "offset": offset,
        "next_offset": offset + len(rows) if offset + len(rows) < len(paths) else None,
        "trust": "untrusted_data",
        "source_kind": "archived_conversation",
    }


def read_epoch(workspace_id: str, session_id: str, checkpoint_id: str) -> dict:
    path = _path(workspace_id, session_id, checkpoint_id)
    record = safe_read_json(path, default=None)
    if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
        raise ValueError("context_checkpoint_not_found")
    payload = record["payload"]
    digest = hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()
    if (
        record.get("sha256") != digest
        or checkpoint_id != "ctx_" + digest[:32]
        or payload.get("workspace_id") != workspace_id
        or payload.get("session_id") != session_id
        or payload.get("schema") != SCHEMA
    ):
        raise ValueError("context_checkpoint_integrity_failed")
    return record


def read_index(
    workspace_id: str,
    session_id: str,
    checkpoint_id: str,
    offset: int = 0,
    limit: int = 30,
) -> dict:
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError("invalid_context_index_range")
    record = read_epoch(workspace_id, session_id, checkpoint_id)
    messages = record["payload"]["messages"]
    rows = []
    for index, message in enumerate(messages[offset : offset + limit], offset):
        rows.append(
            {
                "message_index": index,
                "role": message["role"],
                "tool_call_id": message.get("tool_call_id"),
                "tool_calls": [
                    {
                        "id": call.get("id"),
                        "name": (call.get("function") or {}).get("name"),
                    }
                    for call in message.get("tool_calls") or []
                ],
                "chars": len(_json(message)),
                "excerpt": _json(message)[:240],
            }
        )
    return {
        "checkpoint_id": checkpoint_id,
        "sha256": record["sha256"],
        "parent_id": record["payload"]["parent_id"],
        "total": len(messages),
        "offset": offset,
        "records": rows,
        "next_offset": offset + len(rows)
        if offset + len(rows) < len(messages)
        else None,
        "source_kind": "archived_conversation",
        "trust": "untrusted_data",
    }


def read_message_chunk(
    workspace_id: str,
    session_id: str,
    checkpoint_id: str,
    message_index: int,
    char_offset: int = 0,
    char_limit: int = 8000,
) -> dict:
    if message_index < 0 or char_offset < 0 or not 1 <= char_limit <= 32000:
        raise ValueError("invalid_context_message_range")
    record = read_epoch(workspace_id, session_id, checkpoint_id)
    messages = record["payload"]["messages"]
    if message_index >= len(messages):
        raise ValueError("context_message_not_found")
    text = _json(messages[message_index])
    chunk = text[char_offset : char_offset + char_limit]
    return {
        "checkpoint_id": checkpoint_id,
        "sha256": record["sha256"],
        "message_index": message_index,
        "char_offset": char_offset,
        "total_chars": len(text),
        "text_chunk": chunk,
        "next_char_offset": char_offset + len(chunk)
        if char_offset + len(chunk) < len(text)
        else None,
        "source_kind": "archived_conversation",
        "trust": "untrusted_data",
        "redaction_applied": True,
    }


def search_epochs(workspace_id: str, session_id: str, query: str,
                  checkpoint_id: str = '', offset: int = 0, limit: int = 30) -> dict:
    """Rebuildable lexical index; every result is rechecked against its archive."""
    import sqlite3
    from core.context.unified_retriever import tokenize, expand_query
    from storage.records import workspace_record_dir

    if not query.strip() or offset < 0 or not 1 <= limit <= 200:
        raise ValueError('invalid_context_search_range')
    directory = workspace_record_dir(workspace_id, 'sessions', session_id, 'context_epochs', create=True)
    paths = sorted(directory.glob('ctx_*.json'))
    signature = hashlib.sha256(_json(['index-v3', [(p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in paths]]).encode()).hexdigest()
    database = directory / 'search.sqlite'
    with FileLock(directory / 'search.lock'):
        def open_index():
            connection = sqlite3.connect(database, timeout=5)
            try:
                connection.execute('CREATE TABLE IF NOT EXISTS metadata (signature TEXT)')
                connection.execute('CREATE TABLE IF NOT EXISTS evidence (digest TEXT PRIMARY KEY, checkpoint_id TEXT, message_index INTEGER, role TEXT, text TEXT)')
                connection.execute('CREATE TABLE IF NOT EXISTS occurrences (digest TEXT, checkpoint_id TEXT, message_index INTEGER, PRIMARY KEY(checkpoint_id,message_index))')
                connection.execute('CREATE VIRTUAL TABLE IF NOT EXISTS archive_terms USING fts5(digest UNINDEXED, terms)')
                return connection
            except sqlite3.DatabaseError:
                connection.close()
                raise
        try:
            connection = open_index()
            previous = connection.execute('SELECT signature FROM metadata').fetchone()
        except sqlite3.DatabaseError:
            if 'connection' in locals():
                connection.close()
            # This file contains no facts, only a disposable projection.
            database.unlink(missing_ok=True)
            connection = open_index()
            previous = None
        try:
            if previous != (signature,):
                with connection:
                    connection.execute('DELETE FROM evidence')
                    connection.execute('DELETE FROM occurrences')
                    connection.execute('DELETE FROM archive_terms')
                    for path in paths:
                        record = read_epoch(workspace_id, session_id, path.stem)
                        for index, message in enumerate(record['payload']['messages']):
                            text = _json(message)
                            digest = hashlib.sha256(text.encode()).hexdigest()
                            cursor = connection.execute('INSERT OR IGNORE INTO evidence VALUES (?,?,?,?,?)', (digest, path.stem, index, message['role'], text))
                            connection.execute('INSERT INTO occurrences VALUES (?,?,?)', (digest, path.stem, index))
                            if cursor.rowcount:
                                connection.execute('INSERT INTO archive_terms VALUES (?,?)', (digest, ' '.join(tokenize(text))))
                    connection.execute('DELETE FROM metadata')
                    connection.execute('INSERT INTO metadata VALUES (?)', (signature,))
            terms = list(dict.fromkeys(tokenize(expand_query(query))))
            expression = ' OR '.join('"' + term.replace('"', '""') + '"' for term in terms)
            if checkpoint_id:
                # An explicit checkpoint must exist in the caller's session.
                read_epoch(workspace_id, session_id, checkpoint_id)
            clause = ' AND occurrences.checkpoint_id = ?' if checkpoint_id else ''
            joins = ' JOIN evidence USING(digest)' + (' JOIN occurrences USING(digest)' if checkpoint_id else '')
            pointer = 'occurrences' if checkpoint_id else 'evidence'
            parameters = [expression, checkpoint_id] if checkpoint_id else [expression]
            total = connection.execute('SELECT count(*) FROM archive_terms' + joins + ' WHERE archive_terms MATCH ?' + clause, parameters).fetchone()[0] if expression else 0
            rows = connection.execute(f'SELECT {pointer}.checkpoint_id,{pointer}.message_index,role,text FROM archive_terms' + joins + ' WHERE archive_terms MATCH ?' + clause + ' ORDER BY bm25(archive_terms), evidence.digest LIMIT ? OFFSET ?', [*parameters, limit, offset]).fetchall() if expression else []
            results = []
            for checkpoint, index, role, text in rows:
                original = read_epoch(workspace_id, session_id, checkpoint)
                if _json(original['payload']['messages'][index]) != text:
                    raise ValueError('context_search_projection_stale')
                position = text.lower().find(query.strip().lower())
                if position < 0:
                    positions = [text.lower().find(term) for term in tokenize(query)]
                    position = min((p for p in positions if p >= 0), default=0)
                start = max(0, position - 100)
                results.append({'checkpoint_id': checkpoint, 'sha256': original['sha256'], 'message_index': index, 'role': role, 'char_offset': start, 'char_limit': min(800, len(text) - start), 'excerpt': text[start:start + 800], 'total_chars': len(text)})
            return {'records': results, 'total': total, 'offset': offset, 'next_offset': offset + len(results) if offset + len(results) < total else None, 'source_kind': 'archived_conversation', 'trust': 'untrusted_data', 'coverage': 'lexical_search_of_complete_archived_messages', 'redaction_applied': True}
        finally:
            connection.close()
