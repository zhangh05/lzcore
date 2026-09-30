"""WebSocket handler for real-time agent streaming.

Design:
- WebSocket endpoint: /ws/agent
- Client sends JSON messages, server pushes live StreamEmitter events.
- Business execution still goes through AgentApp.submit_user_message(), so
  HTTP and WebSocket share the same Agent Runtime contract.
- Job lifecycle (create, update runs, progress) is handled here, mirroring
  the HTTP route in agent_routes.py.

Message protocol:
  Client → Server:
    {"type": "message", "user_input": "...", "session_id": "...", "workspace_id": "default"}

  Server → Client:
    {"type": "event", "name": "...", "data": {...}}  — live event
    {"type": "done", "final_response": "...", "session_id": "...", "turn_id": "...", "tool_calls_count": 0}
    {"type": "error", "message": "..."}
"""

import json
import logging
import os
import queue
import threading
import time
from flask import request
from flask_sock import Sock
from simple_websocket.errors import ConnectionClosed
from backend.core.auth import is_allowed_browser_origin

sock = Sock()
_log = logging.getLogger("ws.agent")
_MAX_WS_INPUT_LENGTH = 262144  # 256KB — supports long user inputs
_MAX_WS_METADATA_JSON = 16384
_WS_HEARTBEAT_INTERVAL_SECONDS = 2.0
_WS_FIRST_FRAME_TIMEOUT_SECONDS = max(1.0, float(os.getenv("LZCORE_WS_FIRST_FRAME_TIMEOUT", "5")))
# The bundled synchronous web service has 16 request threads. Keep four free
# for auth, polling and cancellation even under an active-turn surge.
_WS_MAX_CONNECTIONS = max(1, int(os.getenv("LZCORE_WS_MAX_CONNECTIONS", "12")))
_WS_MAX_CONNECTIONS_PER_IP = max(1, int(os.getenv("LZCORE_WS_MAX_CONNECTIONS_PER_IP", "8")))
_WS_MAX_CONNECTIONS_PER_LOOPBACK = max(
    _WS_MAX_CONNECTIONS_PER_IP,
    int(os.getenv("LZCORE_WS_MAX_CONNECTIONS_PER_LOOPBACK", "32")),
)
_ws_connection_counts: dict[str, int] = {}
_ws_connection_total = 0
_ws_connection_lock = threading.Lock()


def _acquire_ws_slot(client_ip: str) -> bool:
    global _ws_connection_total
    key = str(client_ip or "unknown")
    with _ws_connection_lock:
        if _ws_connection_total >= _WS_MAX_CONNECTIONS:
            return False
        per_ip_limit = _WS_MAX_CONNECTIONS_PER_LOOPBACK if key in {"127.0.0.1", "::1", "localhost"} else _WS_MAX_CONNECTIONS_PER_IP
        if _ws_connection_counts.get(key, 0) >= per_ip_limit:
            return False
        _ws_connection_total += 1
        _ws_connection_counts[key] = _ws_connection_counts.get(key, 0) + 1
        return True


def _release_ws_slot(client_ip: str) -> None:
    global _ws_connection_total
    key = str(client_ip or "unknown")
    with _ws_connection_lock:
        current = _ws_connection_counts.get(key, 0)
        if current <= 1:
            _ws_connection_counts.pop(key, None)
        else:
            _ws_connection_counts[key] = current - 1
        _ws_connection_total = max(0, _ws_connection_total - 1)


def _heartbeat_payload(started_at: float, now: float | None = None) -> dict:
    """Build a lightweight liveness event while an agent turn is quiet."""
    current = time.monotonic() if now is None else now
    return {
        "type": "event",
        "name": "heartbeat",
        "data": {
            "type": "heartbeat",
            "elapsed_ms": max(0, int((current - started_at) * 1000)),
        },
    }


def _normalize_ws_attachments(username: str, workspace_id: str, raw):
    """Validate attachments under the authenticated user's storage scope."""
    from backend.core.chat_attachments import normalize_chat_attachments
    from storage.principal import storage_principal

    with storage_principal(username):
        return normalize_chat_attachments(workspace_id, raw)

# v3.16: Global connection registry for broadcasting system events
# (job_updated, run_status) to all active clients.
_active_ws_connections: dict[str, tuple[str, str, object]] = {}  # key → (username, workspace_id, ws)
_active_ws_lock = threading.Lock()
_active_turns: dict[tuple[str, str, str], threading.Event] = {}
_active_turns_lock = threading.Lock()

# Durable job updates are supplementary to the dedicated per-turn message
# WebSocket. Never let a slow dashboard listener synchronously stall the
# runtime callback that is producing tokens and stages.
# Durable lifecycle snapshots are coalesced before recipient fan-out.
_broadcast_pending: dict[str, tuple[str, str, str]] = {}
_broadcast_cv = threading.Condition()
_broadcast_worker_started = False
# Per-socket state isolates slow recipients from their peers.
_broadcast_inflight: set[str] = set()
_broadcast_deferred: dict[str, dict[str, str]] = {}

# One stalled browser must not serialize delivery to unrelated clients.
# At most one sender runs per socket; a newer lifecycle snapshot replaces its
# deferred predecessor while that sender is blocked.
def _drop_broadcast_client(key: str, ws: object | None = None) -> None:
    with _active_ws_lock:
        current = _active_ws_connections.get(key)
        if ws is None or current is None or current[2] is ws:
            _active_ws_connections.pop(key, None)
        _broadcast_inflight.discard(key)
        _broadcast_deferred.pop(key, None)


def _send_broadcast_recipient(key: str, ws: object, payload: str) -> None:
    while True:
        try:
            ws.send(payload)
        except (OSError, RuntimeError, TypeError, ValueError):
            _drop_broadcast_client(key, ws)
            return
        with _active_ws_lock:
            current = _active_ws_connections.get(key)
            deferred = _broadcast_deferred.get(key)
            if current is None or current[2] is not ws or not deferred:
                _broadcast_inflight.discard(key)
                _broadcast_deferred.pop(key, None)
                return
            next_key = next(iter(deferred))
            payload = deferred.pop(next_key)
            if not deferred:
                _broadcast_deferred.pop(key, None)

def _schedule_broadcast_recipient(
    key: str,
    ws: object,
    coalesce_key: str,
    payload: str,
) -> None:
    with _active_ws_lock:
        current = _active_ws_connections.get(key)
        if current is None or current[2] is not ws:
            return
        if key in _broadcast_inflight:
            _broadcast_deferred.setdefault(key, {})[coalesce_key] = payload
            return
        _broadcast_inflight.add(key)
    threading.Thread(
        target=_send_broadcast_recipient,
        args=(key, ws, payload),
        name="lzcore-ws-recipient",
        daemon=True,
    ).start()


def _deliver_broadcast(
    username: str,
    workspace_id: str,
    coalesce_key: str,
    payload: str,
) -> None:
    with _active_ws_lock:
        recipients = [
            (key, ws) for key, (owner, ws_id, ws) in _active_ws_connections.items()
            if ws_id == workspace_id and owner == username
        ]
    for key, ws in recipients:
        _schedule_broadcast_recipient(key, ws, coalesce_key, payload)


def _broadcast_worker() -> None:
    while True:
        with _broadcast_cv:
            while not _broadcast_pending:
                _broadcast_cv.wait()
            coalesce_key = next(iter(_broadcast_pending))
            username, workspace_id, payload = _broadcast_pending.pop(coalesce_key)
        _deliver_broadcast(username, workspace_id, coalesce_key, payload)


def _enqueue_broadcast(username: str, workspace_id: str, coalesce_key: str, payload: str) -> None:
    global _broadcast_worker_started
    with _broadcast_cv:
        # Coalesce repeated lifecycle projections for the same durable object;
        # the newest snapshot is authoritative and prevents an unbounded queue.
        _broadcast_pending[coalesce_key] = (username, workspace_id, payload)
        if not _broadcast_worker_started:
            threading.Thread(target=_broadcast_worker, name="lzcore-ws-broadcast", daemon=True).start()
            _broadcast_worker_started = True
        _broadcast_cv.notify()


_broadcast_listener_started = False


def _ensure_broadcast_listener() -> None:
    global _broadcast_listener_started
    from agent.runtime.turn_replay import _redis_url
    if _broadcast_listener_started:
        return
    url = _redis_url()
    if not url:
        return
    _broadcast_listener_started = True
    threading.Thread(
        target=_listen_broadcasts, args=(url,), name="lzcore-ws-event-bus", daemon=True,
    ).start()


def _listen_broadcasts(url: str) -> None:
    from agent.runtime.turn_replay import PROCESS_ORIGIN
    from storage.principal import storage_principal
    try:
        import redis
        client = redis.Redis.from_url(url, decode_responses=True)
        pubsub = client.pubsub()
        pubsub.subscribe("lzcore:ws_events")
        for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                payload = json.loads(message.get("data") or "{}")
            except json.JSONDecodeError:
                continue
            if payload.get("origin") == PROCESS_ORIGIN:
                continue
            event = payload.get("event")
            if isinstance(event, dict):
                with storage_principal(str(payload.get("username") or "")):
                    broadcast_ws_event(event, remote=True)
    except Exception:
        _log.warning("websocket event listener stopped", exc_info=True)


def _publish_broadcast(event: dict) -> None:
    """Fan a snapshot to other processes. Local delivery already happened."""
    from agent.runtime.turn_replay import PROCESS_ORIGIN, _redis_url
    from storage.principal import current_storage_principal
    url = _redis_url()
    if not url:
        return
    try:
        import redis
        client = redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=1, socket_timeout=1)
        client.publish("lzcore:ws_events", json.dumps({
            "origin": PROCESS_ORIGIN,
            "username": current_storage_principal(),
            "event": event,
        }, ensure_ascii=True, default=str))
    except Exception:
        _log.warning("unable to publish websocket event", exc_info=True)


def request_active_turn_cancel(username: str, workspace_id: str, job_id: str) -> bool:
    """Signal the in-process runtime worker owned by this user/workspace."""
    key = (str(username or ""), str(workspace_id or ""), str(job_id or ""))
    with _active_turns_lock:
        cancel_event = _active_turns.get(key)
    if cancel_event is None:
        return False
    cancel_event.set()
    return True


def broadcast_coalesce_key(username: str, workspace_id: str, event: dict) -> str:
    """Snapshots collapse to the latest object. Turn frames never share a key."""
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    name = str(event.get("name") or "event")
    if name == "turn_frame":
        request_id = str(data.get("client_request_id") or "")
        seq = str(data.get("seq") or data.get("stream_seq") or "")
        return f"{username}:{workspace_id}:turn:{request_id}:{seq}"
    if name == "topology_updated":
        topology_id = str(data.get("topology_id") or "")
        return f"{username}:{workspace_id}:topology:{topology_id}"
    durable_id = str(data.get("job_id") or data.get("session_id") or name or "event")
    return f"{username}:{workspace_id}:{durable_id}"


def broadcast_ws_event(event: dict, *, remote: bool = False) -> None:
    """Push a system event only to clients in the owning workspace."""
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    workspace_id = str(data.get("workspace_id") or "").strip()
    if not workspace_id:
        _log.warning("Dropped WebSocket broadcast without workspace_id: %s", event.get("name"))
        return
    from storage.principal import current_storage_principal
    username = current_storage_principal()
    payload = json.dumps({"type": "event", "name": event["name"], "data": event.get("data", {})}, ensure_ascii=True, default=str)
    _enqueue_broadcast(username, workspace_id, broadcast_coalesce_key(username, workspace_id, event), payload)
    if not remote:
        _publish_broadcast(event)


class _SocketOutbox:
    """One sender owns the socket so control frames and turn frames stay ordered."""

    def __init__(self, ws):
        self.ws = ws
        self.queue: queue.Queue[str | None] = queue.Queue(maxsize=1000)
        self.closed = threading.Event()
        self.turn_count = 0
        self.turn_started_at: float | None = None
        self.next_heartbeat_at = 0.0
        self.thread = threading.Thread(target=self._run, name="lzcore-ws-sender", daemon=True)
        self.thread.start()

    def send(self, payload: str) -> bool:
        if self.closed.is_set():
            return False
        try:
            self.queue.put(payload, timeout=30)
            return True
        except queue.Full:
            return False

    def attach_turn(self) -> None:
        self.turn_count += 1
        if self.turn_started_at is None:
            self.turn_started_at = time.monotonic()
            self.next_heartbeat_at = self.turn_started_at + _WS_HEARTBEAT_INTERVAL_SECONDS

    def detach_turn(self) -> None:
        self.turn_count = max(0, self.turn_count - 1)
        if self.turn_count == 0:
            self.turn_started_at = None

    def close(self) -> None:
        self.closed.set()
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass

    def _run(self) -> None:
        while not self.closed.is_set():
            try:
                item = self.queue.get(timeout=0.25)
            except queue.Empty:
                self._heartbeat()
                continue
            if item is None:
                break
            try:
                self.ws.send(item)
            except Exception:
                self.closed.set()
                return
            if self.turn_started_at is not None:
                self.next_heartbeat_at = time.monotonic() + _WS_HEARTBEAT_INTERVAL_SECONDS

    def _heartbeat(self) -> None:
        if self.turn_started_at is None or self.closed.is_set():
            return
        now = time.monotonic()
        if now < self.next_heartbeat_at:
            return
        payload = json.dumps(_heartbeat_payload(self.turn_started_at, now), ensure_ascii=True)
        try:
            self.ws.send(payload)
        except Exception:
            self.closed.set()
            return
        self.next_heartbeat_at = now + _WS_HEARTBEAT_INTERVAL_SECONDS


def register_ws_routes(app):
    """Register WebSocket routes on the Flask app."""
    sock.init_app(app)
    try:
        from agent.runtime.turn_replay import ensure_replay_listener
        ensure_replay_listener()
    except Exception:
        _log.warning("turn replay listener was not started", exc_info=True)
    _ensure_broadcast_listener()

    @sock.route("/ws/agent")
    def ws_agent(ws):
        """WebSocket endpoint for agent message streaming."""
        if not _same_origin_ws_request():
            ws.send(json.dumps({"type": "error", "message": "csrf_origin_denied"}))
            return

        from backend.core.rate_limit import get_client_ip
        client_ip = get_client_ip()
        if not _acquire_ws_slot(client_ip):
            ws.send(json.dumps({"type": "error", "message": "connection_limit_exceeded"}))
            return

        # When auth is enabled, enforce token on the first message
        _auth_checked = False
        authenticated_username = ""
        authenticated_role = ""
        authenticated_workspaces: list[str] = []
        ws_key = ""
        active_cancel_event = None
        outbox = _SocketOutbox(ws)
        unsubscribers: dict[tuple[str, str, str], object] = {}

        def emit(payload: dict) -> None:
            outbox.send(json.dumps(payload, ensure_ascii=True, default=str))

        try:
            first_frame = True
            while True:
                raw = ws.receive(timeout=_WS_FIRST_FRAME_TIMEOUT_SECONDS if first_frame else 300)
                if raw is None:
                    break
                first_frame = False

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    ws.send(json.dumps({"type": "error", "message": "Invalid JSON"}, ensure_ascii=True))
                    continue

                # WebSocket routes are outside /api, so the Flask auth
                # middleware does not protect them. Authenticate the first
                # frame regardless of whether it is a ping or an agent turn.
                if not _auth_checked:
                    from backend.core.auth import _is_auth_enabled, _is_identity_enabled, _is_login_enabled, _get_api_token, is_current_session_authenticated
                    if not is_current_session_authenticated():
                        api_token = _get_api_token()
                        frame_token = str(msg.get("auth_token", ""))
                        has_valid_token = _api_token_matches(api_token, frame_token)
                        if not ws_unauthenticated_frame_allowed(
                            login_enabled=_is_login_enabled(),
                            identity_enabled=_is_identity_enabled(),
                            auth_enabled=_is_auth_enabled(),
                            api_token=api_token,
                            frame_token=frame_token,
                        ):
                            ws.send(json.dumps({"type": "error", "message": "unauthorized"}))
                            return
                        if has_valid_token:
                            authenticated_username = "api-token"
                            authenticated_role = "owner"
                        elif (
                            not _is_auth_enabled()
                            and not _is_login_enabled()
                            and not _is_identity_enabled()
                            and request.headers.get("Origin")
                        ):
                            from backend.core.local_token import local_browser_token_matches
                            if not local_browser_token_matches(str(msg.get("local_token") or "")):
                                ws.send(json.dumps({"type": "error", "message": "local_token_required"}))
                                return
                    else:
                        from flask import session
                        authenticated_username = str(session.get("lzcore_user") or "")
                        authenticated_role = str(session.get("lzcore_role") or "viewer")
                        authenticated_workspaces = list(session.get("lzcore_workspaces") or [])
                    _auth_checked = True

                # System WebSocket — register for broadcasts, skip agent turn
                if msg.get("type") == "ping":
                    workspace_id = str(msg.get("workspace_id") or "").strip()
                    try:
                        from storage.ids import validate_workspace_id
                        workspace_id = validate_workspace_id(workspace_id)
                    except ValueError:
                        ws.send(json.dumps({"type": "error", "message": "invalid_workspace_id"}))
                        continue
                    if not _ws_workspace_allowed(
                        authenticated_username,
                        authenticated_role,
                        authenticated_workspaces,
                        workspace_id,
                        write=False,
                    ):
                        ws.send(json.dumps({"type": "error", "message": "workspace_forbidden"}))
                        continue
                    ws_key = f"{id(ws)}_{threading.current_thread().ident}"
                    with _active_ws_lock:
                        _active_ws_connections[ws_key] = (authenticated_username, workspace_id, outbox)
                    emit({"type": "pong", "message": "connected"})
                    continue

                if msg.get("type") == "resume":
                    resumed = _attach_turn_replay(
                        msg, authenticated_username, authenticated_role,
                        authenticated_workspaces, outbox, unsubscribers, emit,
                    )
                    if not resumed:
                        continue
                    continue

                if msg.get("type") != "message":
                    ws.send(json.dumps({"type": "error", "message": f"Unknown type: {msg.get('type')}"}, ensure_ascii=True))
                    continue

                user_input = msg.get("user_input", msg.get("message", ""))
                if not user_input:
                    ws.send(json.dumps({"type": "error", "message": "Empty user_input"}, ensure_ascii=True))
                    continue
                if len(str(user_input)) > _MAX_WS_INPUT_LENGTH:
                    ws.send(json.dumps({"type": "error", "message": "message too long (max 64KB)"}, ensure_ascii=True))
                    continue

                session_id = msg.get("session_id", "") or ""
                workspace_id = msg.get("workspace_id", "") or ""
                if not workspace_id:
                    ws.send(json.dumps({"type": "error", "message": "workspace_id is required"}, ensure_ascii=True))
                    continue
                try:
                    from storage.ids import validate_workspace_id, validate_session_id
                    workspace_id = validate_workspace_id(workspace_id)
                    if session_id:
                        session_id = validate_session_id(session_id)
                except ValueError:
                    ws.send(json.dumps({
                        "type": "error",
                        "message": "Invalid session_id or workspace_id",
                    }, ensure_ascii=True))
                    continue
                if not _ws_workspace_allowed(
                    authenticated_username,
                    authenticated_role,
                    authenticated_workspaces,
                    workspace_id,
                    write=True,
                ):
                    ws.send(json.dumps({"type": "error", "message": "workspace_forbidden"}))
                    continue

                metadata = msg.get("metadata", {})
                if not isinstance(metadata, dict):
                    metadata = {}
                try:
                    metadata["attachments"] = _normalize_ws_attachments(
                        authenticated_username, workspace_id, metadata.get("attachments"),
                    )
                except ValueError as exc:
                    ws.send(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=True))
                    continue
                try:
                    from backend.core.agent_contract import metadata_size, normalize_metadata
                    if metadata_size(metadata) > _MAX_WS_METADATA_JSON:
                        ws.send(json.dumps({"type": "error", "message": "metadata too large (max 16KB)"}, ensure_ascii=True))
                        continue
                except Exception:
                    _log.warning("WS metadata normalize failed, resetting to {}", exc_info=True)
                    metadata = {}
                from backend.core.agent_contract import normalize_metadata
                metadata = normalize_metadata(metadata, transport="websocket", stream_mode="live")
                try:
                    from backend.core.agent_contract import resolve_workbench_metadata
                    from storage.principal import storage_principal
                    with storage_principal(authenticated_username):
                        metadata = resolve_workbench_metadata(metadata, workspace_id, session_id=session_id)
                except ValueError as exc:
                    ws.send(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=True))
                    continue
                if session_id and not str(metadata.get("client_request_id") or "").strip():
                    ws.send(json.dumps({"type": "error", "message": "client_request_id_required"}, ensure_ascii=True))
                    continue

                # Event queue for thread-safe communication
                event_queue = queue.Queue(maxsize=1000)
                error_holder = {"error": None}
                stats = {"live_events": 0}
                # A detached browser must not block the durable turn, while an
                # attached slow browser receives every frame through backpressure.
                transport_closed = threading.Event()

                active_cancel_event = threading.Event()
                thread = threading.Thread(
                    target=_run_agent_thread,
                    args=(
                        user_input, session_id, workspace_id, metadata,
                        event_queue, error_holder, stats, active_cancel_event,
                        authenticated_username, transport_closed,
                    ),
                    daemon=True,
                )
                outbox.attach_turn()
                thread.start()
                # Drain on a side thread so this socket can still receive
                # resume, ping and later messages. The log, not this queue,
                # is what a reconnect reads.
                threading.Thread(
                    target=_drain_turn_queue,
                    args=(event_queue, outbox, transport_closed),
                    name="lzcore-ws-turn-drain",
                    daemon=True,
                ).start()

        except (ConnectionClosed, TimeoutError):
            # Normal browser close/refresh or an idle unauthenticated handshake.
            return
        except Exception:  # noqa: BLE001 - WebSocket boundary converts transport failures into a stable client error
            _log.warning("WebSocket transport failed", exc_info=True)
            try:
                ws.send(json.dumps({"type": "error", "message": "websocket_transport_error"}, ensure_ascii=True))
            except Exception:
                pass
        finally:
            for unsubscribe in list(unsubscribers.values()):
                try:
                    unsubscribe()
                except Exception:
                    pass
            outbox.close()
            if ws_key:
                _drop_broadcast_client(ws_key, outbox)
            _release_ws_slot(client_ip)

    return app


def _same_origin_ws_request() -> bool:
    origin = request.headers.get("Origin")
    if not is_allowed_browser_origin(origin, request.host):
        return False
    from backend.core.auth import (
        _hostname_from_host_header,
        _is_auth_enabled,
        _is_identity_enabled,
        _unauthenticated_host_allowed,
        _is_login_enabled,
    )
    if not _is_auth_enabled() and not _is_login_enabled() and not _is_identity_enabled():
        if not _unauthenticated_host_allowed(_hostname_from_host_header(request.host)):
            return False
    return True


def _api_token_matches(api_token: str, frame_token: str) -> bool:
    import hmac
    token = str(api_token or "")
    presented = str(frame_token or "")
    if not token or not presented or len(token) != len(presented):
        return False
    return hmac.compare_digest(presented, token)


def ws_unauthenticated_frame_allowed(
    *,
    login_enabled: bool,
    identity_enabled: bool,
    auth_enabled: bool,
    api_token: str,
    frame_token: str,
) -> bool:
    """Allow a socket only when no auth mode is on, or the frame token matches.

    Local personal use with auth, login, and identity all off stays open.
    Turning any of those on requires a valid token, including the case where
    auth is enabled but the server token is missing.
    """
    has_valid_token = _api_token_matches(api_token, frame_token)
    if login_enabled or identity_enabled or auth_enabled:
        return has_valid_token
    return True


def _ws_workspace_allowed(username: str, role: str, allowed: list[str], workspace_id: str, *, write: bool) -> bool:
    """Mirror HTTP workspace RBAC for the WebSocket transport."""
    if username in {"", "api-token"}:
        return True  # authentication disabled, or the platform API token
    try:
        from backend.core.identity import can_access_workspace, get_user
        current = get_user(username)
        if current is not None:
            if not current.get("enabled", True):
                return False
            current_role = str(current.get("role") or "viewer")
            if current_role == "owner":
                return True
            return can_access_workspace(
                current_role,
                list(current.get("workspace_ids") or []),
                workspace_id,
                write=write,
            )
        from backend.core.auth import _get_login_username
        if _get_login_username() and username == _get_login_username() and role in {"admin", "owner"}:
            return True
        return False
    except Exception:
        return False


def _drain_turn_queue(event_queue: queue.Queue, outbox: _SocketOutbox, transport_closed: threading.Event) -> None:
    """Forward one turn's frames without occupying the socket receive loop."""
    while True:
        try:
            event = event_queue.get(timeout=0.25)
        except queue.Empty:
            if transport_closed.is_set():
                outbox.detach_turn()
                return
            continue
        if event is None:
            outbox.detach_turn()
            return
        payload = json.dumps(event, ensure_ascii=True, default=str)
        if not outbox.send(payload):
            transport_closed.set()
            outbox.detach_turn()
            return


def _attach_turn_replay(msg, username, role, workspaces, outbox, unsubscribers, emit) -> bool:
    """Read an existing turn log. This never submits the user message again."""
    session_id = str(msg.get("session_id") or "")
    workspace_id = str(msg.get("workspace_id") or "")
    client_request_id = str(msg.get("client_request_id") or "")
    try:
        cursor = int(msg.get("stream_seq") or 0)
    except (TypeError, ValueError):
        cursor = 0
    if not workspace_id or not session_id or not client_request_id:
        emit({"type": "error", "message": "resume_target_required"})
        return False
    try:
        from storage.ids import validate_session_id, validate_workspace_id
        workspace_id = validate_workspace_id(workspace_id)
        session_id = validate_session_id(session_id)
    except ValueError:
        emit({"type": "error", "message": "Invalid session_id or workspace_id"})
        return False
    if not _ws_workspace_allowed(username, role, workspaces, workspace_id, write=False):
        emit({"type": "error", "message": "workspace_forbidden"})
        return False
    from agent.runtime.turn_replay import subscribe_turn, turn_exists
    try:
        known = turn_exists(workspace_id, session_id, client_request_id, username=username)
    except ValueError:
        known = False
    if not known:
        emit({"type": "error", "message": "resume_not_found", "session_id": session_id, "client_request_id": client_request_id})
        return False
    key = (workspace_id, session_id, client_request_id)
    previous = unsubscribers.pop(key, None)
    if previous:
        previous()
    if len(unsubscribers) >= 128:
        emit({"type": "error", "message": "resume_limit_exceeded", "session_id": session_id, "client_request_id": client_request_id})
        return False
    outbox.attach_turn()
    unsubscribers[key] = subscribe_turn(
        workspace_id, session_id, client_request_id,
        send=outbox.send, cursor=cursor, username=username,
        on_terminal=outbox.detach_turn,
    )
    return True


def _stamp_replay_frame(
    workspace_id: str,
    session_id: str,
    client_request_id: str,
    username: str,
    stats: dict,
    stats_lock: threading.Lock,
    frame: dict,
) -> dict:
    """Give every replayable frame, including done and error, its own sequence."""
    from storage.redaction import redact_value
    stamped = redact_value(dict(frame))
    if session_id and not stamped.get("session_id"):
        stamped["session_id"] = session_id
    if client_request_id:
        stamped["client_request_id"] = client_request_id
    if client_request_id and session_id and workspace_id:
        try:
            from agent.runtime.turn_replay import append_frame
            stored = append_frame(
                workspace_id, session_id, client_request_id, stamped, username=username,
            )
            seq = int(stored.get("seq") or 0)
            if seq:
                with stats_lock:
                    stats["event_seq"] = seq
                return stored
        except Exception:
            _log.exception("turn replay append failed session=%s", session_id)
    with stats_lock:
        seq = int(stats.get("event_seq", 0)) + 1
        stats["event_seq"] = seq
    stamped["seq"] = seq
    stamped["stream_seq"] = seq
    return stamped


def _run_agent_thread(
    user_input, session_id, workspace_id, metadata, event_queue, error_holder,
    stats, cancel_event=None, username="", transport_closed=None,
):
    """Run agent in background thread through the shared AgentApp contract."""
    from agent.runtime.stream_emitter import StreamEmitter

    stats_lock = threading.Lock()
    # `asyncio.to_thread()` propagates ContextVars. A provider call that has
    # timed out can therefore retain this callback after the turn emits done.
    emission_lock = threading.Lock()
    emissions_open = threading.Event()
    emissions_open.set()
    transport_closed = transport_closed or threading.Event()

    def enqueue_live(event: dict | None) -> bool:
        """Apply transport backpressure without sacrificing durable execution.

        While the browser remains attached, every token, stage and terminal frame
        waits for queue capacity rather than being silently dropped. Once the
        receiver marks the connection detached, producer callbacks return
        immediately and the Agent turn keeps running for durable recovery.
        """
        while not transport_closed.is_set():
            try:
                event_queue.put(event, timeout=0.25)
                return True
            except queue.Full:
                continue
        return False

    def put_terminal(event) -> None:
        # Serialize terminal delivery with provider callbacks and permanently
        # reject callbacks copied into a late `asyncio.to_thread()` worker.
        with emission_lock:
            emissions_open.clear()
            stamped = _stamp_replay_frame(
                workspace_id, session_id, client_request_id, username,
                stats, stats_lock, event if isinstance(event, dict) else {"type": "event"},
            )
            enqueue_live(stamped)

    def realtime_callback(event):
        emission_lock.acquire()
        try:
            if not emissions_open.is_set():
                return
            with stats_lock:
                stats["live_events"] = int(stats.get("live_events", 0)) + 1
            if isinstance(event, dict) and event.get("type") == "token":
                enqueue_live(_stamp_replay_frame(
                    workspace_id, session_id, client_request_id, username,
                    stats, stats_lock,
                    {"type": "token", "content": event.get("content", "")},
                ))
            elif isinstance(event, dict) and event.get("type") == "heartbeat":
                enqueue_live({"type": "event", "name": "heartbeat", "data": event})
            else:
                name = event.get("type", event.get("name", "event")) if isinstance(event, dict) else "event"
                data = event
                # Preserve the complete tool-visible summary. Presentation
                # may collapse it, but transport must not discard it.
                if name in ("tool_call", "tool_result") and isinstance(event, dict):
                    summary = str(event.get("summary") or event.get("message") or "")
                    data = {
                        "type": event.get("type"),
                        "name": event.get("name", event.get("tool",
                                event.get("tool_id", ""))),
                        "tool_id": event.get("tool_id", event.get("name", "")),
                        "ok": event.get("ok", event.get("status") == "ok"),
                        "summary": summary,
                        "call_id": event.get("call_id", ""),
                    }
                if isinstance(data, dict):
                    data = {
                        **data,
                        "job_id": str(stats.get("job_id") or ""),
                        "client_request_id": str((metadata or {}).get("client_request_id") or ""),
                    }
                job_id_for_event = str(stats.get("job_id") or "")
                if job_id_for_event and isinstance(event, dict) and name != "heartbeat":
                    try:
                        from jobs.lifecycle import update_session_turn_stage
                        update_session_turn_stage(
                            workspace_id,
                            job_id_for_event,
                            session_id,
                            event,
                        )
                    except Exception:
                        _log.exception("unable to persist live stage job=%s stage=%s", job_id_for_event, name)
                enqueue_live(_stamp_replay_frame(
                    workspace_id, session_id, client_request_id, username,
                    stats, stats_lock,
                    {"type": "event", "name": name, "data": data},
                ))
        except Exception:
            _log.warning("realtime_callback event push failed seq=%s", stats.get("event_seq"), exc_info=True)
        finally:
            emission_lock.release()

    from storage.principal import storage_principal
    job_id = ""
    principal_scope = None
    client_request_id = str((metadata or {}).get("client_request_id") or "")
    try:
        principal_scope = storage_principal(username)
        principal_scope.__enter__()
        try:
            from jobs.lifecycle import claim_session_turn
            turn_claim = claim_session_turn(
                workspace_id, session_id, user_input,
                client_request_id=client_request_id,
            )
            job_id = str(turn_claim.job_id or "")
            if not turn_claim.should_execute:
                final_response = ""
                errors = [turn_claim.error] if turn_claim.error else []
                if turn_claim.status == "succeeded" and turn_claim.run_id:
                    from storage.run_record_store import get_run
                    final_response = str(
                        get_run(turn_claim.run_id, workspace_id).get(
                            "final_response_summary", "",
                        ) or "",
                    )
                elif turn_claim.status == "failed" and not errors:
                    errors = ["同一请求此前处理失败。"]
                resume_request_id = client_request_id
                if turn_claim.status in {"running", "conflict"}:
                    from jobs.store import get_job
                    existing_job = get_job(workspace_id, job_id)
                    if existing_job:
                        active = (existing_job.metadata or {}).get("active_turn") or {}
                        resume_request_id = str(active.get("client_request_id") or client_request_id)
                enqueue_live({
                    "type": "done",
                    "session_id": session_id,
                    "client_request_id": client_request_id,
                    "turn_id": turn_claim.run_id,
                    "trace_id": turn_claim.trace_id,
                    "final_response": final_response,
                    "events": [],
                    "tool_calls_count": 0,
                    "tool_calls": [],
                    "metadata": {
                        "transport": "websocket",
                        "idempotent": True,
                        "idempotent_redirect": {
                            "job_id": job_id,
                            "status": turn_claim.status or "running",
                            "client_request_id": resume_request_id,
                        },
                    },
                    "errors": errors,
                    "warnings": [],
                    "tool_decision": {},
                    "no_tool_reason": "",
                    "capability": "",
                    "error_type": "",
                })
                return
        except Exception:
            # Runtime execution remains available if the observational job
            # snapshot cannot be written; the failure is logged and never
            # replaced with fabricated progress.
            _log.exception("unable to start durable live turn session=%s", session_id)
            job_id = ""
        stats["job_id"] = job_id
        if job_id and cancel_event is not None:
            with _active_turns_lock:
                _active_turns[(username, workspace_id, job_id)] = cancel_event
            # The HTTP cancellation endpoint persists its intent before it
            # reaches this process-local map.  Replay that durable intent after
            # registration so a stop in the claim/register window is never
            # lost and frontend retries are not required for correctness.
            try:
                from jobs.store import get_job
                durable_job = get_job(workspace_id, job_id)
                if durable_job and bool(getattr(durable_job, "cancel_requested", False)):
                    cancel_event.set()
            except (OSError, RuntimeError, TypeError, ValueError):
                _log.warning(
                    "unable to restore durable cancellation ws=%s job=%s",
                    workspace_id, job_id, exc_info=True,
                )
        # StreamEmitter stores callbacks thread-locally, so it must be set in
        # the same worker thread that runs AgentApp.submit_user_message().
        StreamEmitter.set_realtime_callback(realtime_callback)

        from agent.app.service import get_default_agent_app
        app = get_default_agent_app()

        runtime_metadata = dict(metadata or {})
        workbench_ctx = dict(runtime_metadata.get("workbench_context") or {})
        runtime_control = None
        if cancel_event is not None or workbench_ctx:
            from core.runtime_engine.models import MainAgentRuntimeControl
            runtime_control = MainAgentRuntimeControl(
                cancel_check=cancel_event.is_set if cancel_event is not None else None,
                workbench_context=workbench_ctx,
            )
        result = app.submit_user_message(
            user_input=user_input,
            session_id=session_id,
            workspace_id=workspace_id,
            metadata=runtime_metadata,
            runtime_control=runtime_control,
        )

        result_payload = result.to_dict()

        # ── Job lifecycle (unified via jobs.lifecycle) ──
        effective_session_id = session_id or result_payload.get("session_id", "")
        if effective_session_id:
            try:
                from jobs.lifecycle import attach_run_to_session_job, finish_claimed_session_turn, finish_session_turn_snapshot
                result_metadata = result_payload.get("metadata") if isinstance(result_payload.get("metadata"), dict) else {}
                unknown_outcome = result_metadata.get("unknown_outcome") if isinstance(result_metadata.get("unknown_outcome"), dict) else {}
                finish_session_turn_snapshot(
                    workspace_id,
                    job_id,
                    effective_session_id,
                    client_request_id=client_request_id,
                    run_id=result_payload.get("turn_id", ""),
                    trace_id=result_payload.get("trace_id", ""),
                    ok=bool(result_payload.get("ok", not result_payload.get("errors"))),
                    unknown_outcome=unknown_outcome,
                    error=str((result_payload.get("errors") or [""])[0]),
                )
                finish_claimed_session_turn(
                    workspace_id,
                    effective_session_id,
                    client_request_id=client_request_id,
                    job_id=job_id,
                    run_id=result_payload.get("turn_id", ""),
                    trace_id=result_payload.get("trace_id", ""),
                    ok=bool(result_payload.get("ok", not result_payload.get("errors"))),
                    error=str((result_payload.get("errors") or [""])[0]),
                )
                attach_run_to_session_job(
                    ws_id=workspace_id,
                    session_id=effective_session_id,
                    run_id=result_payload.get("turn_id", ""),
                    tool_call_count=len(result_payload.get("tool_calls", [])),
                    user_input=user_input,
                    run_ok=bool(result_payload.get("ok", not result_payload.get("errors"))),
                    error=str((result_payload.get("errors") or [""])[0]),
                )
            except Exception:
                _log.exception("WS job lifecycle error session=%s ws=%s", effective_session_id, workspace_id)

        if result_payload.get("final_response"):
            from agent.llm.runtime import sanitize_provider_output
            result_payload["final_response"], stripped = sanitize_provider_output(result_payload["final_response"])
            if stripped:
                result_payload.setdefault("metadata", {})["reasoning_stripped"] = True

        # Fallback: if no live events were emitted, replay collected events so
        # older runtime paths still produce observable progress data.
        if int(stats.get("live_events", 0)) == 0:
            for ev in result_payload.get("events", []):
                if not enqueue_live(_stamp_replay_frame(
                    workspace_id, session_id, client_request_id, username, stats, stats_lock,
                    {"type": "event", "name": ev.get("type", "event"), "data": ev},
                )):
                    break

        tool_calls = result_payload.get("tool_calls", [])
        tool_calls_count = len(tool_calls) or len([
            e for e in result_payload.get("events", [])
            if e.get("type") == "tool_call"
        ])
        metadata_out = result_payload.get("metadata", {}) or {}
        metadata_out.setdefault("transport", "websocket")
        metadata_out.setdefault("stream_mode", "live" if int(stats.get("live_events", 0)) else "event_replay_fallback")

        resolved_session_id = result_payload.get("session_id") or session_id or ""

        # Send done event first — so frontend sees it immediately
        put_terminal({
            "type": "done",
            "session_id": resolved_session_id,
            "turn_id": result_payload.get("turn_id", ""),
            "trace_id": result_payload.get("trace_id", ""),
            "final_response": result_payload.get("final_response", ""),
            "events": result_payload.get("events", []),
            "tool_calls_count": tool_calls_count,
            "tool_calls": tool_calls,
            "metadata": metadata_out,
            "errors": result_payload.get("errors", []),
            "warnings": result_payload.get("warnings", []),
            "tool_decision": result_payload.get("tool_decision", {}),
            "no_tool_reason": result_payload.get("no_tool_reason", ""),
            "capability": result_payload.get("capability", ""),
            "error_type": result_payload.get("error_type", ""),
        })

    except Exception as e:
        _log.exception("agent websocket turn failed")
        from storage.redaction import redact_text
        safe_error = redact_text(str(e))[:500] or "agent_runtime_error"
        error_holder["error"] = "agent_runtime_error"
        if job_id:
            try:
                from jobs.lifecycle import finish_claimed_session_turn, finish_session_turn_snapshot
                finish_session_turn_snapshot(
                    workspace_id,
                    job_id,
                    session_id,
                    client_request_id=client_request_id,
                    ok=False,
                    error=safe_error,
                )
                finish_claimed_session_turn(
                    workspace_id,
                    session_id,
                    client_request_id=client_request_id,
                    job_id=job_id,
                    ok=False,
                    error=safe_error,
                )
            except Exception:
                _log.exception("unable to persist failed live turn job=%s", job_id)
        put_terminal({
            "type": "error",
            "message": safe_error,
            "error_code": "agent_runtime_error",
        })
    finally:
        if job_id:
            with _active_turns_lock:
                _active_turns.pop((username, workspace_id, job_id), None)
        try:
            StreamEmitter.clear_realtime_callback()
        except Exception:
            pass
        if principal_scope is not None:
            try:
                principal_scope.__exit__(None, None, None)
            except Exception:
                pass
        enqueue_live(None)
