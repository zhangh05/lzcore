"""Session Snapshot & Rewind — save and restore session message state.

Snapshots save the current messages/history of a session to a JSON file.
Rewind restores messages from a snapshot, optionally in dry_run mode
that previews what would happen without making changes.
"""

import uuid
import json
import os
import shutil
import tempfile
from pathlib import Path

from storage.ids import validate_session_id, validate_workspace_id
from storage.records import atomic_save_json, list_json_records, read_json_record


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _safe_id(value: str) -> str:
    """Sanitize an ID to prevent path traversal."""
    import re
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", str(value))
    if not safe:
        raise ValueError(f"Invalid id: {value!r}")
    return safe


def create_snapshot(workspace_id: str, session_id: str, reason: str = "") -> dict:
    """Create a snapshot of the current session messages.

    Args:
        workspace_id: Workspace identifier.
        session_id: Session identifier.
        reason: Optional human-readable reason for the snapshot.

    Returns:
        {"ok": True, "snapshot_id": "...", "message_count": N}
    """
    try:
        ws_id = validate_workspace_id(workspace_id)
        sid = validate_session_id(session_id)

        # Read current session messages
        from storage.session_store import get_session
        session = get_session(sid, ws_id)
        if not session:
            return {"ok": False, "error": "session not found"}

        from storage.message_store import SessionMessageStore
        store = SessionMessageStore(session_id=sid, ws_id=ws_id)
        messages = store.get_messages()

        snap_id = uuid.uuid4().hex[:12]
        snapshot = {
            "snapshot_id": snap_id,
            "workspace_id": ws_id,
            "session_id": sid,
            "reason": reason or "",
            "message_count": len(messages),
            "created_at": _now_iso(),
            "messages": messages,
        }

        atomic_save_json(ws_id, ("sessions", sid, "snapshots", f"{snap_id}.json"), snapshot)

        return {
            "ok": True,
            "snapshot_id": snap_id,
            "message_count": len(messages),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def list_snapshots(workspace_id: str, session_id: str) -> list:
    """List all snapshots for a session (without full message content).

    Args:
        workspace_id: Workspace identifier.
        session_id: Session identifier.

    Returns:
        List of snapshot summary dicts.
    """
    try:
        ws_id = validate_workspace_id(workspace_id)
        sid = validate_session_id(session_id)

        results = []
        for data in list_json_records(ws_id, ("sessions", sid, "snapshots"), limit=500):
            try:
                results.append({
                    "snapshot_id": data.get("snapshot_id", ""),
                    "reason": data.get("reason", ""),
                    "message_count": data.get("message_count", 0),
                    "created_at": data.get("created_at", ""),
                })
            except Exception:
                continue

        return results
    except Exception:
        return []


def rewind_session(workspace_id: str, session_id: str,
                   snapshot_id: str, dry_run: bool = True) -> dict:
    """Rewind a session to a previous snapshot state.

    Args:
        workspace_id: Workspace identifier.
        session_id: Session identifier.
        snapshot_id: Snapshot ID to restore from.
        dry_run: If True, only preview what would happen without applying.

    Returns:
        {"ok": True, "message_count": N, "dry_run": bool}
    """
    try:
        ws_id = validate_workspace_id(workspace_id)
        sid = validate_session_id(session_id)
        snap_id = _safe_id(snapshot_id)

        # Load snapshot
        snapshot = read_json_record(ws_id, ("sessions", sid, "snapshots", f"{snap_id}.json"))
        if not snapshot:
            return {"ok": False, "error": f"snapshot not found: {snap_id}"}

        messages = snapshot.get("messages", [])

        if dry_run:
            return {
                "ok": True,
                "message_count": len(messages),
                "dry_run": True,
                "preview": {
                    "snapshot_id": snap_id,
                    "reason": snapshot.get("reason", ""),
                    "created_at": snapshot.get("created_at", ""),
                    "message_count": len(messages),
                    "action": "Would restore session messages to this snapshot state. Set dry_run=False to apply.",
                },
            }

        return _apply_rewind(ws_id, sid, messages, snapshot.get("message_count"))
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


def _message_references(ws_id: str, sid: str, replacement: list[dict]) -> None:
    from storage.records import mutate_jsonl

    def replace(rows):
        kept = [row for row in rows if not (
            row.get("owner_type") == "message" and (
                (row.get("metadata") or {}).get("session_id") == sid
                or str(row.get("owner_id", "")).startswith(sid + "/")))]
        return [*kept, *replacement], None
    mutate_jsonl(ws_id, ("index", "references.jsonl"), replace)


def _recover_rewind(store) -> None:
    """Caller holds workspace_files_lock. An uncommitted switch rolls back."""
    msg_dir = store._messages_dir()
    journal = msg_dir.parent / ".rewind-transaction.json"
    if not journal.exists():
        return
    state = json.loads(journal.read_text(encoding="utf-8"))
    # Never trust recovery paths from a damaged journal.
    for key, prefix in (("stage", ".rewind-stage-"), ("backup", ".rewind-backup-")):
        name = state[key]
        if Path(name).name != name or not name.startswith(prefix):
            raise ValueError("invalid rewind recovery path")
    stage = msg_dir.parent / state["stage"]
    backup = msg_dir.parent / state["backup"]
    _message_references(store.ws_id, store.session_id, state["old_references"])
    if state["had_original"]:
        if backup.exists():
            if msg_dir.exists():
                os.replace(msg_dir, stage)
            os.replace(backup, msg_dir)
        elif not msg_dir.is_dir():
            raise OSError("rewind recovery history is missing")
    elif msg_dir.exists():
        os.replace(msg_dir, stage)
    for artifact in state.get("artifacts", []):
        store._cleanup_artifact(artifact)
    if stage.exists():
        shutil.rmtree(stage)
    journal.unlink()


def _apply_rewind(ws_id: str, sid: str, messages: list, expected_count=None) -> dict:
    from storage.message_store import SessionMessageStore, _atomic_write, _safe_run_id
    from storage.project_changes import workspace_files_lock
    from storage.reference_index import list_references

    if not isinstance(messages, list) or (
        expected_count is not None and expected_count != len(messages)
    ):
        raise ValueError("invalid snapshot message count")
    store = SessionMessageStore(session_id=sid, ws_id=ws_id)
    with workspace_files_lock(ws_id):
        _recover_rewind(store)
        msg_dir = store._messages_dir()
        msg_dir.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".rewind-stage-", dir=msg_dir.parent))
        backup = msg_dir.parent / (".rewind-backup-" + uuid.uuid4().hex)
        journal = msg_dir.parent / ".rewind-transaction.json"
        old_refs = [row for row in list_references(ws_id) if
                    row.get("owner_type") == "message" and (
                        (row.get("metadata") or {}).get("session_id") == sid
                        or str(row.get("owner_id", "")).startswith(sid + "/"))]
        state = {"stage": stage.name, "backup": backup.name,
                 "had_original": msg_dir.exists(), "old_references": old_refs,
                 "artifacts": []}
        staged = SessionMessageStore(session_id=sid, ws_id=ws_id)
        staged._messages_dir = lambda: stage
        staged._defer_references = True
        staged._staged_artifacts = state["artifacts"]
        try:
            _atomic_write(journal, state)
            identities = set()
            for msg in messages:
                run_id = _safe_run_id(msg.get("run_id", ""))
                role = msg.get("role")
                if (role not in {"user", "assistant"} or msg.get("artifact_unavailable")
                        or not isinstance(msg.get("content"), str)
                        or not msg["content"].strip()):
                    raise ValueError("snapshot contains an unrestorable message")
                identity = (run_id, role)
                if identity in identities:
                    raise ValueError("snapshot contains duplicate message IDs")
                identities.add(identity)
                meta = dict(msg.get("metadata") or {})
                if msg.get("created_at"):
                    meta["created_at"] = msg["created_at"]
                if not staged._write_message(run_id, role, msg["content"], meta):
                    raise ValueError("snapshot message could not be restored")
                _atomic_write(journal, state)
            restored = staged._read_full_messages()
            if len(restored) != len(messages) or any(m.get("artifact_unavailable") for m in restored):
                raise OSError("staged snapshot validation failed")
            references = []
            for path in stage.glob("*.json"):
                record = json.loads(path.read_text(encoding="utf-8"))
                meta = record.get("metadata") or {}
                attachments = [*list(meta.get("attachments") or []),
                               *list((meta.get("history_state") or {}).get("attachments") or [])]
                files = {(a["file_id"], "attachment") for a in attachments
                         if isinstance(a, dict) and a.get("file_id")}
                if record.get("artifact_ref"):
                    files.add((record["artifact_ref"]["file_id"], "content"))
                for fid, relation in files:
                    references.append({
                        "ref_id": "ref_" + uuid.uuid4().hex[:12], "workspace_id": ws_id,
                        "file_id": fid, "owner_type": "message",
                        "owner_id": f"{sid}/{record['run_id']}:{record['role']}",
                        "relation": relation, "created_at": _now_iso(),
                        "metadata": {"session_id": sid, "run_id": record["run_id"]},
                    })
            # Every canonical reader/writer holds this same cross-process lock.
            # The journal recovers a process exit between the two renames.
            if msg_dir.exists():
                os.replace(msg_dir, backup)
            os.replace(stage, msg_dir)
            _message_references(ws_id, sid, references)
            journal.unlink()  # commit; before this point recovery restores old history
        except Exception:
            if journal.exists():
                # Include artifacts prepared since the last journal update.
                _atomic_write(journal, state)
                _recover_rewind(store)
            else:
                for artifact in state["artifacts"]:
                    store._cleanup_artifact(artifact)
                shutil.rmtree(stage)
            raise
        if backup.exists():
            # A committed backup is safe to retain if housekeeping fails.
            try:
                shutil.rmtree(backup)
            except OSError:
                import logging
                logging.getLogger(__name__).warning("Committed rewind backup retained")
        return {"ok": True, "message_count": len(messages), "dry_run": False}
