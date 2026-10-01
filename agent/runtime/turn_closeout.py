"""Retryable per-request terminal repair. Never re-executes a tool."""
from __future__ import annotations

import hashlib
import json
import logging
from contextlib import nullcontext

_log = logging.getLogger(__name__)
_INTERRUPTED = "本轮在完成前中断，没有可确认的最终结果。"
_FAILURE_STATUSES = {"error", "failed", "cancelled", "interrupted", "unknown"}


def _is_success(message: dict) -> bool:
    meta = message.get("metadata") or {}
    status = str(meta.get("status") or "")
    return bool(str(message.get("content") or "").strip()) and status not in _FAILURE_STATUSES and not meta.get("error")


def _assistant_for_request(workspace_id: str, session_id: str, request_id: str, run_id: str) -> dict | None:
    from storage.message_store import SessionMessageStore
    for message in reversed(SessionMessageStore(session_id, workspace_id).get_messages()):
        if message.get("role") == "assistant" and (
            (message.get("metadata") or {}).get("client_request_id") == request_id
            or (run_id and message.get("run_id") == run_id)
        ):
            return message
        if message.get("role") == "assistant" and message.get("run_id") and not (message.get("metadata") or {}).get("client_request_id"):
            from storage.run_record_store import get_run
            record = get_run(str(message["run_id"]), workspace_id)
            if record.get("client_request_id") == request_id:
                return message
    return None


def ensure_turn_terminal(*, workspace_id: str, session_id: str, client_request_id: str,
                         username: str = "", outcome: str = "interrupted", error: str = "", run_id: str = "") -> dict | None:
    request_id = str(client_request_id or "").strip()
    if not workspace_id or not session_id or not request_id:
        return None
    from storage.principal import storage_principal
    from storage.session_store import _session_lock
    from storage.locking import FileLock
    from storage.message_store import SessionMessageStore
    from agent.runtime.turn_replay import _log_path, frames_after, append_frame
    # Same lock order as request acceptance: session, then turn log.
    with storage_principal(username), _session_lock(session_id, workspace_id):
        path = _log_path(workspace_id, session_id, request_id)
        with FileLock(path.with_suffix(".closeout.lock")):
            existing = _assistant_for_request(workspace_id, session_id, request_id, run_id)
            frames = frames_after(workspace_id, session_id, request_id, 0, username=username)
            terminal = frames[-1] if frames and frames[-1].get("type") in {"done", "error"} else None
            stable_run = run_id or (terminal or {}).get("turn_id") or "interrupt_" + hashlib.sha256(request_id.encode()).hexdigest()[:24]
            if not existing:
                text = str((terminal or {}).get("final_response") or (terminal or {}).get("message") or _INTERRUPTED)
                success = bool(terminal and terminal.get("type") == "done" and not terminal.get("errors") and terminal.get("final_response"))
                SessionMessageStore(session_id, workspace_id).write_message(stable_run, "assistant", text, metadata={
                    "client_request_id": request_id,
                    "status": "succeeded" if success else "cancelled" if outcome == "cancelled" else "interrupted",
                    "error": "" if success else str(error or (terminal or {}).get("message") or "turn_interrupted")[:240],
                    "reconciliation": True,
                })
                existing = _assistant_for_request(workspace_id, session_id, request_id, stable_run)
            assert existing is not None
            if terminal:
                return terminal
            success = _is_success(existing)
            meta = existing.get("metadata") or {}
            frame = {
                "type": "done" if success else "error",
                "turn_id": existing.get("run_id") or stable_run,
                "trace_id": meta.get("trace_id") or "",
                "metadata": {"reconciliation": True},
            }
            if success:
                frame["final_response"] = str(existing.get("content") or "")
            else:
                frame.update(message=str(existing.get("content") or error or _INTERRUPTED),
                             error_code="turn_cancelled" if outcome == "cancelled" else "turn_interrupted")
            return append_frame(workspace_id, session_id, request_id, frame, username=username)


def close_restarted_turns(username: str = "") -> int:
    """Repair all terminal requests, including earlier turns in a reusable job."""
    from jobs.store import list_jobs, get_job, update_job
    from jobs.lifecycle import _request_registry_path, _read_request_record, _write_request_record, _reconcile_running_request_record, finish_session_turn_snapshot
    from storage.principal import known_storage_principals, storage_principal
    from storage.workspace_store import list_workspace_ids
    from storage.records import workspace_record_dir
    from storage.session_store import _session_lock, get_session
    from storage.time_utils import now_iso

    repaired = 0
    for principal in [username] if username else ["", *known_storage_principals()]:
        with storage_principal(principal) if principal else nullcontext():
            for ws_id in list_workspace_ids():
                candidates = {}
                for job in list_jobs(ws_id, limit=10000):
                    active = dict((job.metadata or {}).get("active_turn") or {})
                    sid, request_id = active.get("session_id"), active.get("client_request_id")
                    if sid and request_id:
                        candidates[(sid, request_id)] = {**active, "status": job.status, "job_id": job.job_id, "error": job.error or active.get("error") or ""}
                for path in workspace_record_dir(ws_id, "sys", "request_registry").glob("*/*.json"):
                    try:
                        record = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        continue
                    if not isinstance(record, dict):
                        continue
                    sid, request_id = record.get("session_id"), record.get("client_request_id")
                    if sid and request_id:
                        candidates[(sid, request_id)] = record
                for (sid, request_id), candidate in candidates.items():
                    try:
                        with _session_lock(sid, ws_id):
                            if not get_session(sid, ws_id):
                                continue
                            path = _request_registry_path(ws_id, sid, request_id)
                            record = _read_request_record(path) or candidate
                            if record.get("replay_expired"):
                                continue
                            if _reconcile_running_request_record(ws_id, request_id, record):
                                _write_request_record(path, record)
                            if record.get("status") not in {"failed", "cancelled", "succeeded"}:
                                continue
                            frame = ensure_turn_terminal(workspace_id=ws_id, session_id=sid, client_request_id=request_id,
                                username=principal, outcome=record["status"], error=str(record.get("error") or ""), run_id=str(record.get("run_id") or ""))
                            if not frame:
                                continue
                            success = frame.get("type") == "done" and not frame.get("errors")
                            status = "cancelled" if record["status"] == "cancelled" else "succeeded" if success else "failed"
                            terminal_error = "" if success else str(frame.get("message") or (frame.get("errors") or ["turn_interrupted"])[0])
                            if path.is_file() and record.get("status") != status:
                                record.update(status=status, error=terminal_error, updated_at=now_iso())
                                _write_request_record(path, record)
                            job = get_job(ws_id, str(record.get("job_id") or ""))
                            active = dict((job.metadata or {}).get("active_turn") or {}) if job else {}
                            if job and active.get("client_request_id") == request_id and (job.status != status or active.get("status") != status):
                                finish_session_turn_snapshot(ws_id, job.job_id, sid, client_request_id=request_id,
                                    run_id=str(frame.get("turn_id") or record.get("run_id") or ""), ok=success, error=terminal_error)
                                update_job(ws_id, job.job_id, {"status": status, "error": terminal_error, "finished_at": now_iso()})
                            repaired += 1
                    except Exception:
                        _log.warning("turn closeout deferred session=%s", sid, exc_info=True)
    return repaired
