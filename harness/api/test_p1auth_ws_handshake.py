"""P1AUTH handshake regressions without sockets, threads or Agent execution."""

import json
from types import SimpleNamespace

import pytest
from flask import Flask


@pytest.fixture
def handshake(monkeypatch):
    from backend.ws import agent_ws
    for key in ("LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true")
    monkeypatch.setenv("LZCORE_API_TOKEN", "synthetic-token")
    for key in ("LZCORE_ALLOWED_HOSTS", "LZCORE_ALLOWED_ORIGINS"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(agent_ws, "_ws_connection_counts", {})
    monkeypatch.setattr(agent_ws, "_ws_connection_total", 0)
    monkeypatch.setattr(agent_ws, "_active_ws_connections", {})
    monkeypatch.setattr(agent_ws, "_ensure_broadcast_listener", lambda: None)
    monkeypatch.setattr("agent.runtime.turn_replay.ensure_replay_listener", lambda: None)
    monkeypatch.setattr(agent_ws, "_SocketOutbox", lambda ws: SimpleNamespace(send=ws.send, close=lambda: None))
    handlers = {}
    def route(path):
        def register(handler):
            handlers[path] = handler
            return handler
        return register
    monkeypatch.setattr(agent_ws, "sock", SimpleNamespace(init_app=lambda _: None, route=route))
    app = Flask(__name__)
    agent_ws.register_ws_routes(app)
    now = [0.0]
    monkeypatch.setattr(agent_ws.time, "monotonic", lambda: now[0])

    def run(frames, *, headers=None, remote="127.0.0.1", delayed=False):
        sent, timeouts = [], []
        source = iter(frames)
        def receive(*, timeout):
            timeouts.append(timeout)
            if delayed:
                now[0] += agent_ws._WS_FIRST_FRAME_TIMEOUT_SECONDS + 1
            return next(source, None)
        ws = SimpleNamespace(send=lambda raw: sent.append(json.loads(raw)), receive=receive)
        with app.test_request_context("/ws/agent", base_url="http://localhost:8011", headers=headers or {},
                                      environ_base={"REMOTE_ADDR": remote}):
            handlers["/ws/agent"](ws)
        assert agent_ws._ws_connection_total == 0
        assert agent_ws._ws_connection_counts == {}
        return sent, timeouts
    return SimpleNamespace(run=run, app=app, module=agent_ws)


@pytest.mark.parametrize("frame", ["{", "[]", "null", '"text"', "42", b"\xff"])
def test_invalid_first_frame_closes_without_extending_auth_wait(handshake, frame):
    sent, timeouts = handshake.run([frame, "{"])
    assert len(timeouts) == 1
    assert 0 < timeouts[0] <= handshake.module._WS_FIRST_FRAME_TIMEOUT_SECONDS
    assert sent[0]["type"] == "error"
    assert sent[0]["message"] in {"Invalid JSON", "JSON object required"}


def test_only_authenticated_connection_gets_long_idle_timeout(handshake):
    sent, timeouts = handshake.run([json.dumps({"type": "ping", "workspace_id": "mine", "auth_token": "synthetic-token"})])
    assert sent == [{"type": "pong", "message": "connected"}]
    assert timeouts == [handshake.module._WS_FIRST_FRAME_TIMEOUT_SECONDS, 300]


def test_expired_auth_deadline_rejects_even_valid_frame(handshake):
    sent, timeouts = handshake.run([json.dumps({"type": "ping", "workspace_id": "mine", "auth_token": "synthetic-token"})], delayed=True)
    assert sent == []
    assert len(timeouts) == 1


def test_raw_frame_limit_applies_before_json_parser(handshake, monkeypatch):
    monkeypatch.setattr(handshake.module, "_MAX_WS_MESSAGE_BYTES", 64)
    sent, timeouts = handshake.run(['{"unrelated":"' + "x" * 128 + '"}'])
    assert sent == [{"type": "error", "message": "frame_too_large"}]
    assert len(timeouts) == 1
    assert handshake.app.config["SOCK_SERVER_OPTIONS"]["max_message_size"] == 4 * 1024 * 1024


def test_maximum_escaped_unicode_input_still_fits_transport_limit(handshake):
    frame = json.dumps({"type": "ping", "workspace_id": "mine", "auth_token": "synthetic-token",
                        "user_input": "😀" * handshake.module._MAX_WS_INPUT_LENGTH})
    sent, _ = handshake.run([frame])
    assert sent == [{"type": "pong", "message": "connected"}]


@pytest.mark.parametrize("origin,remote,forwarded", [
    ("http://192.168.1.66:5273", "127.0.0.1", None),
    ("http://100.64.0.8:5274", "127.0.0.1", None),
    (None, "198.51.100.9", "127.0.0.1"),
    ("http://localhost:5273", "127.0.0.1", "198.51.100.9"),
])
def test_personal_ws_rejects_private_origin_and_nonlocal_client(handshake, monkeypatch, origin, remote, forwarded):
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    headers = {}
    if origin:
        headers["Origin"] = origin
    if forwarded:
        headers["X-Forwarded-For"] = forwarded
    sent, timeouts = handshake.run([json.dumps({"type": "ping", "local_token": "even-a-valid-token"})], headers=headers, remote=remote)
    assert sent == [{"type": "error", "message": "csrf_origin_denied"}]
    assert timeouts == []


def test_personal_loopback_ws_accepts_local_browser_token(handshake, monkeypatch):
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    monkeypatch.setattr("backend.core.local_token.local_browser_token_matches", lambda value: value == "synthetic-local-token")
    sent, timeouts = handshake.run([json.dumps({"type": "ping", "workspace_id": "mine", "local_token": "synthetic-local-token"})],
                                  headers={"Origin": "http://127.0.0.1:5273"})
    assert sent == [{"type": "pong", "message": "connected"}]
    assert timeouts[-1] == 300


def test_personal_ws_accepts_explicit_private_origin(handshake, monkeypatch):
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    monkeypatch.setenv("LZCORE_ALLOWED_ORIGINS", "http://192.168.1.66:5273")
    monkeypatch.setattr("backend.core.local_token.local_browser_token_matches", lambda token: token == "synthetic-local-token")
    sent, _ = handshake.run([json.dumps({"type": "ping", "workspace_id": "mine", "local_token": "synthetic-local-token"})],
                            headers={"Origin": "http://192.168.1.66:5273"})
    assert sent == [{"type": "pong", "message": "connected"}]


def test_transport_receives_frame_limit_before_handler_runs(monkeypatch):
    import flask_sock
    from backend.ws import agent_ws
    captured = []
    monkeypatch.setattr(agent_ws, "sock", flask_sock.Sock())
    monkeypatch.setattr(agent_ws, "_ensure_broadcast_listener", lambda: None)
    monkeypatch.setattr("agent.runtime.turn_replay.ensure_replay_listener", lambda: None)
    monkeypatch.setattr(agent_ws, "_same_origin_ws_request", lambda: False)
    def server(environ, **options):
        captured.append(options)
        return SimpleNamespace(mode="werkzeug", send=lambda _: None, close=lambda: None)
    monkeypatch.setattr(flask_sock, "Server", server)
    app = Flask(__name__)
    app.config["SOCK_SERVER_OPTIONS"] = {"max_message_size": None, "ping_interval": 25}
    agent_ws.register_ws_routes(app)
    with app.test_request_context("/ws/agent"):
        app.view_functions["ws_agent"]()
    assert captured == [{"max_message_size": 4 * 1024 * 1024, "ping_interval": 25}]
