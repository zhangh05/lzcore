"""Ordered, durable frames for one agent turn.

The session job snapshot is a progress projection. This log is the replay
source: every token, tool card, done and error gets its own sequence. A
reconnect reads ``seq > cursor`` and then follows newly appended frames
without a gap or a duplicate. Heartbeats are not stored.
"""

from __future__ import annotations

import json
import hashlib
import uuid
import logging
import os
import threading
from pathlib import Path
from typing import Callable

_log = logging.getLogger(__name__)
_logs: dict[tuple[str, str, str], "TurnLog"] = {}
_logs_lock = threading.Lock()
_CHANNEL = "lzcore:turn_replay"
_listener_started = False
PROCESS_ORIGIN = uuid.uuid4().hex


def _safe_id(value: str) -> str:
    request = str(value or "").strip()
    if not request or len(request) > 256:
        raise ValueError("invalid client_request_id")
    return hashlib.sha256(request.encode("utf-8")).hexdigest()


def _log_path(workspace_id: str, session_id: str, client_request_id: str) -> Path:
    from storage.ids import validate_session_id, validate_workspace_id
    from storage.paths import workspace_root

    root = workspace_root(validate_workspace_id(workspace_id))
    session = validate_session_id(session_id)
    request = _safe_id(client_request_id)
    if not request:
        raise ValueError("client_request_id is required")
    return root / "sessions" / session / "turn_logs" / f"{request}.jsonl"


def _principal(username: str):
    from storage.principal import storage_principal
    return storage_principal(username or "")


def _get_log(workspace_id: str, session_id: str, client_request_id: str, username: str) -> "TurnLog":
    with _principal(username):
        path = _log_path(workspace_id, session_id, client_request_id)
        key = (str(path.parent.parent.parent), session_id, _safe_id(client_request_id))
    with _logs_lock:
        existing = _logs.get(key)
        if existing is None:
            existing = TurnLog(path)
            _logs[key] = existing
        return existing


def turn_exists(workspace_id: str, session_id: str, client_request_id: str, *, username: str = "") -> bool:
    """A resume may follow accepted work, but must not create an unknown turn."""
    with _principal(username):
        path = _log_path(workspace_id, session_id, client_request_id)
        if path.is_file():
            return True
        from jobs.lifecycle import _request_registry_path
        return _request_registry_path(workspace_id, session_id, client_request_id).is_file()


def append_frame(
    workspace_id: str,
    session_id: str,
    client_request_id: str,
    frame: dict,
    *,
    username: str = "",
) -> dict:
    """Append one replayable frame and return it with a fresh sequence."""
    log = _get_log(workspace_id, session_id, client_request_id, username)
    stored = log.append(frame, session_id=session_id, client_request_id=client_request_id)
    _publish_wake(workspace_id, session_id, client_request_id, username)
    return stored


def frames_after(
    workspace_id: str,
    session_id: str,
    client_request_id: str,
    cursor: int,
    *,
    username: str = "",
) -> list[dict]:
    log = _get_log(workspace_id, session_id, client_request_id, username)
    return log.after(cursor)


def subscribe_turn(
    workspace_id: str,
    session_id: str,
    client_request_id: str,
    *,
    send: Callable[[str], bool],
    cursor: int,
    username: str = "",
    on_terminal: Callable[[], None] | None = None,
) -> Callable[[], None]:
    """Replay ``seq > cursor``, then follow later frames. Returns unsubscribe."""
    log = _get_log(workspace_id, session_id, client_request_id, username)
    return log.subscribe(send, int(cursor or 0), on_terminal=on_terminal)


def reload_turn(
    workspace_id: str,
    session_id: str,
    client_request_id: str,
    *,
    username: str = "",
) -> None:
    log = _get_log(workspace_id, session_id, client_request_id, username)
    log.reload()


class _Subscriber:
    def __init__(self, send: Callable[[str], bool], cursor: int, on_terminal: Callable[[], None] | None):
        self.send = send
        self.cursor = cursor
        self.on_terminal = on_terminal
        self.closed = False
        self.wake = threading.Event()


class TurnLog:
    def __init__(self, path: Path):
        self.path = path
        self.frames: list[dict] = []
        self.subscribers: list[_Subscriber] = []
        self.lock = threading.Lock()
        self._offset = 0

    def append(self, frame: dict, *, session_id: str, client_request_id: str) -> dict:
        from storage.locking import FileLock

        stamped = {
            **frame,
            "session_id": session_id,
            "client_request_id": client_request_id,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(self.path.with_suffix(".lock")):
            self._load_locked()
            seq = int(self.frames[-1]["seq"]) + 1 if self.frames else 1
            stamped["seq"] = seq
            stamped["stream_seq"] = seq
            # Recover an interrupted last write before appending another frame.
            with self.path.open("a+b") as tail:
                tail.truncate(self._offset)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(stamped, ensure_ascii=False, default=str) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            self._load_locked()
        self._wake()
        return stamped

    def after(self, cursor: int) -> list[dict]:
        from storage.locking import FileLock

        with FileLock(self.path.with_suffix(".lock")):
            self._load_locked()
            return [frame for frame in self.frames if int(frame.get("seq") or 0) > int(cursor or 0)]

    def reload(self) -> None:
        from storage.locking import FileLock

        with FileLock(self.path.with_suffix(".lock")):
            self._load_locked()
        self._wake()

    def subscribe(
        self,
        send: Callable[[str], bool],
        cursor: int,
        *,
        on_terminal: Callable[[], None] | None = None,
    ) -> Callable[[], None]:
        sub = _Subscriber(send, cursor, on_terminal)
        with self.lock:
            self.subscribers.append(sub)
        thread = threading.Thread(
            target=self._pump,
            args=(sub,),
            name="lzcore-turn-replay",
            daemon=True,
        )
        thread.start()

        def unsubscribe() -> None:
            sub.closed = True
            sub.wake.set()
            with self.lock:
                self.subscribers = [item for item in self.subscribers if item is not sub]

        return unsubscribe

    def _pump(self, sub: _Subscriber) -> None:
        try:
            while not sub.closed:
                pending = self.after(sub.cursor)
                for frame in pending:
                    if sub.closed:
                        return
                    try:
                        ok = sub.send(json.dumps(frame, ensure_ascii=False, default=str))
                    except Exception:
                        _log.warning("turn replay subscriber failed", exc_info=True)
                        ok = False
                    if not ok:
                        return
                    sub.cursor = int(frame["seq"])
                    if frame.get("type") in {"done", "error"}:
                        return
                # A cursor at the terminal frame is already caught up.
                if self.frames and self.frames[-1].get("type") in {"done", "error"}:
                    return
                sub.wake.wait(0.25)
                sub.wake.clear()
        finally:
            sub.closed = True
            with self.lock:
                self.subscribers = [item for item in self.subscribers if item is not sub]
            if sub.on_terminal:
                try:
                    sub.on_terminal()
                except Exception:
                    _log.warning("turn replay terminal hook failed", exc_info=True)

    def _load_locked(self) -> None:
        # Every reader/writer refreshes the shared tail under FileLock. Cached
        # frames never allocate a sequence until other processes' writes load.
        if not self.path.exists():
            self.frames = []
            self._offset = 0
            return
        if self.path.stat().st_size < self._offset:
            self.frames = []
            self._offset = 0
        with self.path.open("rb") as handle:
            handle.seek(self._offset)
            for line in handle:
                if not line.endswith(b"\n"):
                    break
                self._offset = handle.tell()
                try:
                    frame = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if isinstance(frame, dict) and frame.get("seq"):
                    self.frames.append(frame)

    def _wake(self) -> None:
        with self.lock:
            subscribers = list(self.subscribers)
        for sub in subscribers:
            sub.wake.set()


def _redis_url() -> str:
    mode = os.getenv("LZCORE_EVENT_BUS_MODE", os.getenv("LZCORE_QUEUE_MODE", "inprocess"))
    if mode.strip().lower() != "redis":
        return ""
    return (os.environ.get("LZCORE_EVENT_BUS_URL") or os.environ.get("LZCORE_QUEUE_URL")
            or os.environ.get("LZCORE_REDIS_URL", ""))


def _publish_wake(workspace_id: str, session_id: str, client_request_id: str, username: str) -> None:
    url = _redis_url()
    if not url:
        return
    try:
        import redis
        client = redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=1, socket_timeout=1)
        client.publish(_CHANNEL, json.dumps({
            "origin": PROCESS_ORIGIN,
            "username": username,
            "workspace_id": workspace_id,
            "session_id": session_id,
            "client_request_id": client_request_id,
        }, ensure_ascii=True))
    except Exception:
        _log.warning("unable to publish turn replay wake", exc_info=True)


def ensure_replay_listener() -> None:
    """Wake local subscribers when another process appends a shared log."""
    global _listener_started
    url = _redis_url()
    if not url or _listener_started:
        return
    _listener_started = True
    threading.Thread(target=_listen, args=(url,), name="lzcore-turn-replay-bus", daemon=True).start()


def _listen(url: str) -> None:
    try:
        import redis
        client = redis.Redis.from_url(url, decode_responses=True)
        pubsub = client.pubsub()
        pubsub.subscribe(_CHANNEL)
        for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                payload = json.loads(message.get("data") or "{}")
            except json.JSONDecodeError:
                continue
            if payload.get("origin") == PROCESS_ORIGIN:
                continue
            try:
                reload_turn(
                    str(payload.get("workspace_id") or ""),
                    str(payload.get("session_id") or ""),
                    str(payload.get("client_request_id") or ""),
                    username=str(payload.get("username") or ""),
                )
            except Exception:
                _log.warning("unable to reload remote turn replay", exc_info=True)
    except Exception:
        _log.warning("turn replay listener stopped", exc_info=True)
