# storage/reference_index.py
"""Cross-reference index linking files to owner entities."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from storage.records import mutate_jsonl, read_jsonl
from storage.schemas import FileReference

_REF_INDEX_PARTS = ("index", "references.jsonl")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def add_reference(
    workspace_id: str,
    file_id: str,
    owner_type: str,
    owner_id: str,
    relation: str = "source",
    metadata: dict[str, Any] | None = None,
) -> FileReference:
    """Add a cross-reference between a file and an owner entity."""
    ref = FileReference(
        ref_id=f"ref_{uuid.uuid4().hex[:12]}",
        workspace_id=workspace_id,
        file_id=file_id,
        owner_type=owner_type,
        owner_id=owner_id,
        relation=relation,
        created_at=_now_iso(),
        metadata=metadata or {},
    )
    def upsert(rows):
        for row in rows:
            if (row.get('file_id'), row.get('owner_type'), row.get('owner_id'), row.get('relation')) == (file_id, owner_type, owner_id, relation):
                row['metadata'] = {**row.get('metadata', {}), **(metadata or {})}
                return rows, FileReference(**row)
        return [*rows, ref.as_dict()], ref
    return mutate_jsonl(workspace_id, _REF_INDEX_PARTS, upsert)


def list_references(workspace_id: str) -> list[dict]:
    return read_jsonl(workspace_id, _REF_INDEX_PARTS)


def replace_owner_references(workspace_id: str, owner_type: str, owner_id: str,
                             files: list[tuple[str, str]], *, metadata: dict | None = None) -> None:
    """Reconcile one owner's dependencies under a single index lock."""
    wanted = set(files)
    def replace(rows):
        kept, found = [], set()
        for row in rows:
            if (row.get('owner_type'), row.get('owner_id')) != (owner_type, owner_id):
                kept.append(row)
                continue
            key = (row.get('file_id'), row.get('relation'))
            if key in wanted and key not in found:
                row['metadata'] = {**row.get('metadata', {}), **(metadata or {})}
                kept.append(row)
                found.add(key)
        for fid, relation in sorted(wanted - found):
            kept.append(FileReference(ref_id=f'ref_{uuid.uuid4().hex[:12]}', workspace_id=workspace_id,
                file_id=fid, owner_type=owner_type, owner_id=owner_id, relation=relation,
                created_at=_now_iso(), metadata=metadata or {}).as_dict())
        return kept, None
    mutate_jsonl(workspace_id, _REF_INDEX_PARTS, replace)


def remove_session_references(workspace_id: str, session_id: str) -> None:
    def remove(rows):
        return [r for r in rows if not (
            r.get('owner_type') in {'message', 'session'} and (
                r.get('metadata', {}).get('session_id') == session_id or
                (r.get('owner_type') == 'session' and r.get('owner_id') == session_id)))], None
    mutate_jsonl(workspace_id, _REF_INDEX_PARTS, remove)


def list_references_for_file(workspace_id: str, file_id: str) -> list[dict]:
    """List all references pointing to a specific file."""
    return _query_refs(workspace_id, "file_id", file_id)


def list_references_for_owner(workspace_id: str, owner_type: str, owner_id: str) -> list[dict]:
    """List all file references owned by a specific entity."""
    return [
        r for r in _query_refs(workspace_id, "owner_id", owner_id)
        if r.get("owner_type") == owner_type
    ]


def remove_reference(workspace_id: str, ref_id: str) -> bool:
    """Remove a reference by ref_id through the storage record adapter."""
    def _remove(rows):
        kept = [row for row in rows if row.get("ref_id") != ref_id]
        return kept, len(kept) != len(rows)

    return bool(mutate_jsonl(workspace_id, _REF_INDEX_PARTS, _remove))


def _query_refs(workspace_id: str, key: str, value: str) -> list[dict]:
    return [rec for rec in read_jsonl(workspace_id, _REF_INDEX_PARTS) if rec.get(key) == value]
