# agent/app/session_manager.py
"""Thread-safe AgentSession lifecycle boundary."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable

from agent.core.session import AgentSession

logger = logging.getLogger(__name__)


class _TurnLease:
    """Pin the session before waiting for its lock, through the whole turn."""

    def __init__(self, manager, key, lock):
        self.manager, self.key, self.lock = manager, key, lock

    def __enter__(self):
        try:
            self.lock.acquire()
        except BaseException:
            self._release()
            raise
        return self

    def _release(self):
        with self.manager._sessions_lock:
            self.manager._turn_leases[self.key] -= 1
            if not self.manager._turn_leases[self.key]:
                del self.manager._turn_leases[self.key]
            session = self.manager._sessions.get(self.key)
            if session is not None:
                session._last_access = time.monotonic()

    def __exit__(self, *exc):
        try:
            self.lock.release()
        finally:
            self._release()


class SessionManager:
    def __init__(
        self,
        *,
        ttl_seconds: int = 3600,
        max_sessions: int = 1000,
        restore_callback: Callable[[AgentSession, str, str], None] | None = None,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self.restore_callback = restore_callback
        # A logical workspace has separate user-scoped storage roots.  Keep
        # the live session and its turn lock scoped the same way, otherwise a
        # guessed/reused session_id could expose another user's in-memory
        # history before persistence is consulted.
        self._sessions: dict[tuple[str, str, str], AgentSession] = {}
        self._sessions_lock = threading.RLock()
        self._session_turn_locks: dict[tuple[str, str, str], threading.RLock] = {}
        self._turn_leases: dict[tuple[str, str, str], int] = {}

    def new_session_id(self) -> str:
        return f"session_{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _principal_key() -> str:
        from storage.principal import current_storage_principal, principal_storage_key
        principal = current_storage_principal()
        # Request paths always bind a real user or the explicit API-token
        # principal. Direct maintenance/test invocations use a named internal
        # scope rather than falling into a legacy user namespace.
        return principal_storage_key(principal) if principal else "system-internal"

    def _key(self, session_id: str, workspace_id: str) -> tuple[str, str, str]:
        return (self._principal_key(), str(workspace_id), str(session_id))

    def get_or_create(self, session_id: str | None, workspace_id: str, *, reserve_turn=False):
        with self._sessions_lock:
            self._evict_expired_locked()
            sid = session_id or self.new_session_id()
            key = self._key(sid, workspace_id)
            if key not in self._sessions:
                if len(self._sessions) >= self.max_sessions:
                    idle = [key for key in self._sessions if not self._turn_leases.get(key)]
                    if not idle:
                        raise RuntimeError("session_capacity_busy")
                    oldest = min(idle, key=lambda key: self._sessions[key]._last_access)
                    self._sessions.pop(oldest)
                    self._session_turn_locks.pop(oldest, None)
                session = AgentSession(session_id=sid, workspace_id=workspace_id)
                self._restore(session, sid, workspace_id)
                self._sessions[key] = session
                self._session_turn_locks.setdefault(key, threading.RLock())
            else:
                session = self._sessions[key]
                self._session_turn_locks.setdefault(key, threading.RLock())
            session._last_access = time.monotonic()
            turn_lock = self._session_turn_locks[key]
            if reserve_turn:
                self._turn_leases[key] = self._turn_leases.get(key, 0) + 1
                turn_lock = _TurnLease(self, key, turn_lock)
            return sid, session, turn_lock

    def snapshot(self) -> dict[str, Any]:
        with self._sessions_lock:
            return {
                "session_count": len(self._sessions),
                "ttl_seconds": self.ttl_seconds,
                "max_sessions": self.max_sessions,
                "sessions": [
                    {
                        "session_id": sid[2],
                        "workspace_id": getattr(sess, "workspace_id", ""),
                        "last_access": getattr(sess, "_last_access", 0),
                        "history_len": len(getattr(sess, "history", []) or []),
                    }
                    for sid, sess in self._sessions.items()
                ],
            }

    def _restore(self, session: AgentSession, sid: str, workspace_id: str) -> None:
        if not self.restore_callback:
            return
        self.restore_callback(session, sid, workspace_id)

    def archive_for_reset(self, session_id: str, workspace_id: str) -> None:
        from storage.ids import validate_session_id, validate_workspace_id
        from storage.session_store import update_session

        validate_session_id(session_id)
        validate_workspace_id(workspace_id)
        key = self._key(session_id, workspace_id)
        # A slash tool runs in a worker while its parent owns the turn lock.
        # Taking that lock here would deadlock. Publish the durable barrier
        # first; queued submissions check it under their existing turn lock.
        archived = update_session(session_id, workspace_id, status="archived", metadata={"reset_archived": True})
        if not archived or archived.get("status") != "archived":
            raise RuntimeError("session_reset_failed")
        with self._sessions_lock:
            self._sessions.pop(key, None)
            # Keep the lock: already queued submissions may still own it.

    def _evict_expired_locked(self) -> None:
        now = time.monotonic()
        expired = [
            sid for sid, s in self._sessions.items()
            if not self._turn_leases.get(sid)
            and now - getattr(s, "_last_access", 0) > self.ttl_seconds
        ]
        for sid in expired:
            self._sessions.pop(sid, None)
            self._session_turn_locks.pop(sid, None)

        if len(self._sessions) <= self.max_sessions:
            return
        overflow = len(self._sessions) - self.max_sessions
        oldest = sorted(
            (sid for sid in self._sessions if not self._turn_leases.get(sid)),
            key=lambda sid: getattr(self._sessions[sid], "_last_access", 0),
        )
        for sid in oldest[:overflow]:
            self._sessions.pop(sid, None)
            self._session_turn_locks.pop(sid, None)
