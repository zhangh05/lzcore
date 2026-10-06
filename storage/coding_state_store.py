"""Principal/workspace-scoped records for coding objects, with revision CAS."""
from __future__ import annotations

from copy import deepcopy
import re

from storage.records import mutate_json_record, read_json_record, workspace_record_dir
from storage.records import workspace_record_file
from storage.locking import FileLock

_KINDS = frozenset({"candidates", "reviews", "projects"})
_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_IMMUTABLE = {
    "candidates": ("producer_task_id", "project_dir", "branch_workspace", "source_digest", "baseline",
                   "change", "validation", "resources", "responsibilities", "generated_paths",
                   "validation_commands", "revision_of", "required_review_kinds", "failure_attributions"),
    "reviews": ("reviewer_task_id", "candidate_id", "candidate_digest", "change_digest", "kind", "review_round",
                "branch_workspace", "project_dir", "baseline", "validation_commands", "generated_paths"),
    "projects": ("project_dir",),
}


def _parts(kind: str, identity: str) -> tuple[str, ...]:
    if kind not in _KINDS or not _ID.fullmatch(identity):
        raise ValueError("invalid_coding_record_identity")
    return ("coding-state", kind, identity + ".json")


def read(workspace_id: str, kind: str, identity: str) -> dict | None:
    return read_json_record(workspace_id, _parts(kind, identity))


def publication_lock(workspace_id: str, identity: str):
    _parts("candidates", identity)
    return FileLock(workspace_record_file(workspace_id, "coding-publications", identity + ".lock"), timeout=300)


def list_records(workspace_id: str, kind: str, *, limit=None) -> list[dict]:
    if kind not in _KINDS:
        raise ValueError("invalid_coding_record_kind")
    records = []
    for path in workspace_record_dir(workspace_id, "coding-state", kind, create=False).glob("*.json"):
        record = read(workspace_id, kind, path.stem)
        if record is None:
            raise ValueError("coding_record_unavailable")
        records.append(record)
    records.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
    return records if limit is None else records[:max(0, int(limit))]


def change(workspace_id: str, kind: str, identity: str, update, *, expected_revision=None, session_id=None) -> dict:
    """The updater owns domain invariants; the adapter owns atomicity and CAS."""
    from storage.session_store import session_is_deleted, session_record_lock
    scope = session_id or (read(workspace_id, kind, identity) or {}).get("session_id")
    if not scope:
        raise ValueError("coding_record_session_required")
    def mutate(previous):
        revision = int((previous or {}).get("revision", 0))
        if expected_revision is not None and revision != expected_revision:
            raise ValueError("coding_record_revision_conflict")
        result = update(deepcopy(previous))
        if result["session_id"] != scope or session_is_deleted(scope, workspace_id):
            raise ValueError("coding_session_deleted")
        if result == previous:
            return previous, deepcopy(previous)
        if result.get("workspace_id") != workspace_id or result.get("id") != identity:
            raise ValueError("coding_record_identity_mismatch")
        if previous:
            for key in ("schema", "id", "workspace_id", "session_id", "parent_task_id", *_IMMUTABLE[kind]):
                sealing = kind == "candidates" and previous.get("state") == "building" and key in {
                    "source_digest", "change", "validation", "resources", "failure_attributions"}
                if not sealing and previous.get(key) != result.get(key):
                    raise ValueError("coding_record_identity_is_immutable")
            if kind == "reviews" and previous.get("state") in {"completed", "interrupted", "execution_unknown"}:
                if any(previous.get(key) != result.get(key) for key in
                       ("state", "judgement", "validation", "resources", "outcome", "final_report", "invalid_proposal", "failure_attributions")):
                    raise ValueError("coding_completed_review_is_immutable")
        result["revision"] = revision + 1
        return result, deepcopy(result)
    with session_record_lock(scope, workspace_id):
        if session_is_deleted(scope, workspace_id):
            raise ValueError("coding_session_deleted")
        return mutate_json_record(workspace_id, _parts(kind, identity), mutate)


def delete_session_records(workspace_id: str, session_id: str) -> None:
    from storage.records import delete_json_record, workspace_record_dir
    from storage.session_store import session_is_deleted
    if not session_is_deleted(session_id, workspace_id):
        raise ValueError("coding_delete_requires_session_tombstone")
    for kind in _KINDS:
        directory = workspace_record_dir(workspace_id, "coding-state", kind, create=False)
        for path in directory.glob("*.json"):
            record = read(workspace_id, kind, path.stem)
            if record is None:
                raise ValueError("coding_record_unavailable")
            if record and record.get("session_id") == session_id:
                delete_json_record(workspace_id, _parts(kind, path.stem))
