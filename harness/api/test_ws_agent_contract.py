import queue
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("trusted_proxy", ["false", "true"])
@pytest.mark.parametrize("remote,forwarded,client_ip,local", [
    ("127.0.0.1", None, "127.0.0.1", True),
    ("127.0.0.1", "192.168.1.20", "192.168.1.20", False),
    ("127.0.0.1", "127.0.0.1, 192.168.1.20", "192.168.1.20", False),
    ("127.0.0.1", "127.0.0.1", "127.0.0.1", True),
    ("192.168.1.20", "127.0.0.1", "192.168.1.20", False),
    ("::1", "192.168.1.20", "192.168.1.20", False),
])
def test_ws_handshake_connection_allowance_uses_effective_client(
    monkeypatch, trusted_proxy, remote, forwarded, client_ip, local,
):
    """Run the registered handler without opening a socket or an agent turn."""
    import json
    from flask import Flask
    from backend.ws import agent_ws

    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    monkeypatch.setenv("TRUSTED_PROXY", trusted_proxy)
    # This test isolates connection quotas; remote personal clients now need
    # individual authorization before the slot check can be reached.
    monkeypatch.setenv("LZCORE_ALLOWED_HOSTS", "192.168.1.20")
    monkeypatch.setattr(agent_ws, "_WS_MAX_CONNECTIONS", 10)
    monkeypatch.setattr(agent_ws, "_WS_MAX_CONNECTIONS_PER_IP", 1)
    monkeypatch.setattr(agent_ws, "_WS_MAX_CONNECTIONS_PER_LOOPBACK", 2)
    counts = {client_ip: 1}
    monkeypatch.setattr(agent_ws, "_ws_connection_counts", counts)
    monkeypatch.setattr(agent_ws, "_ws_connection_total", 1)
    handlers = {}

    def route(path):
        def register(handler):
            handlers[path] = handler
            return handler
        return register

    monkeypatch.setattr(agent_ws, "sock", SimpleNamespace(init_app=lambda app: None, route=route))
    monkeypatch.setattr(agent_ws, "_ensure_broadcast_listener", lambda: None)
    monkeypatch.setattr("agent.runtime.turn_replay.ensure_replay_listener", lambda: None)
    app = Flask(__name__)
    agent_ws.register_ws_routes(app)
    sent = []
    received = []
    socket = SimpleNamespace(
        send=lambda raw: sent.append(json.loads(raw)),
        receive=lambda **kwargs: received.append(kwargs) or None,
    )
    headers = {"X-Forwarded-For": forwarded} if forwarded is not None else {}
    with app.test_request_context(
        "/ws/agent", base_url="http://127.0.0.1:8011", headers=headers,
        environ_base={"REMOTE_ADDR": remote},
    ):
        handlers["/ws/agent"](socket)

    if local:
        assert received
        assert sent == []
    else:
        assert received == []
        assert sent == [{"type": "error", "message": "connection_limit_exceeded"}]
    assert counts == {client_ip: 1}
    assert agent_ws._ws_connection_total == 1


def test_ws_auth_stays_open_for_personal_use_and_closes_when_enabled():
    from backend.ws.agent_ws import ws_unauthenticated_frame_allowed

    assert ws_unauthenticated_frame_allowed(
        login_enabled=False, identity_enabled=False, auth_enabled=False,
        api_token="", frame_token="",
    ) is True
    assert ws_unauthenticated_frame_allowed(
        login_enabled=False, identity_enabled=False, auth_enabled=True,
        api_token="", frame_token="",
    ) is False
    assert ws_unauthenticated_frame_allowed(
        login_enabled=False, identity_enabled=False, auth_enabled=True,
        api_token="secret-token", frame_token="secret-token",
    ) is True
    assert ws_unauthenticated_frame_allowed(
        login_enabled=True, identity_enabled=False, auth_enabled=False,
        api_token="secret-token", frame_token="wrong-length",
    ) is False


def test_ws_heartbeat_payload_reports_monotonic_elapsed_time():
    from backend.ws.agent_ws import _heartbeat_payload

    payload = _heartbeat_payload(10.0, 12.75)

    assert payload == {
        "type": "event",
        "name": "heartbeat",
        "data": {"type": "heartbeat", "elapsed_ms": 2750},
    }


def test_ws_done_payload_includes_full_inspector_fields(monkeypatch):
    from backend.ws import agent_ws
    import agent.app.service as service

    class FakeResult:
        def to_dict(self):
            return {
                "ok": True,
                "final_response": "answer",
                "session_id": "s-1",
                "turn_id": "t-1",
                "trace_id": "trace-1",
                "events": [
                    {"event_id": "ev-1", "type": "tool_call", "timestamp": 1.0},
                    {"event_id": "ev-2", "type": "final", "timestamp": 2.0},
                ],
                "tool_calls": [
                    {"call_id": "call-1", "tool_id": "knowledge.manage", "ok": True},
                ],
                "metadata": {"source_count": 1},
                "warnings": [],
                "errors": [],
                "tool_decision": {"needed": True, "selected_tools": ["knowledge.manage"]},
                "no_tool_reason": "",
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())

    event_queue = queue.Queue()
    error_holder = {"error": None}
    stats = {"live_events": 0}
    agent_ws._run_agent_thread("q", "s-1", "default", {}, event_queue, error_holder, stats)

    messages = []
    while not event_queue.empty():
        messages.append(event_queue.get())
    done = next(item for item in messages if isinstance(item, dict) and item.get("type") == "done")

    assert done["trace_id"] == "trace-1"
    assert len(done["events"]) == 2
    assert done["tool_decision"]["selected_tools"] == ["knowledge.manage"]
    assert done["tool_calls"][0]["tool_id"] == "knowledge.manage"
    assert done["metadata"]["stream_mode"] == "event_replay_fallback"
    assert done["metadata"]["transport"] == "websocket"
    assert error_holder["error"] is None


def test_ws_done_sequence_is_after_the_last_live_token(monkeypatch, temp_dirs):
    from backend.ws import agent_ws
    import agent.app.service as service
    from agent.runtime.stream_emitter import StreamEmitter

    class FakeResult:
        def to_dict(self):
            return {
                "ok": True,
                "final_response": "answer",
                "session_id": "sess1",
                "turn_id": "t-1",
                "trace_id": "trace-1",
                "events": [],
                "tool_calls": [],
                "metadata": {},
                "warnings": [],
                "errors": [],
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            StreamEmitter().emit("token", {"content": "answer"})
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    event_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "q", "sess1", "default",
        {"client_request_id": "req-seq"},
        event_queue, {"error": None}, {"live_events": 0},
    )
    messages = []
    while not event_queue.empty():
        item = event_queue.get()
        if isinstance(item, dict):
            messages.append(item)
    token = next(item for item in messages if item.get("type") == "token")
    done = next(item for item in messages if item.get("type") == "done")
    assert done["stream_seq"] > token["seq"]
    assert done["seq"] == done["stream_seq"]


def test_ws_worker_injects_cooperative_cancel_check(monkeypatch):
    import threading
    from backend.ws import agent_ws
    import agent.app.service as service

    captured = {}

    class FakeResult:
        def to_dict(self):
            return {"ok": True, "final_response": "done", "events": [], "tool_calls": [], "metadata": {}}

    class FakeApp:
        def submit_user_message(self, **kwargs):
            captured.update(kwargs)
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    cancel_event = threading.Event()
    event_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "q", "s-1", "default", {}, event_queue,
        {"error": None}, {"live_events": 0}, cancel_event,
    )
    from core.runtime_engine.models import MainAgentRuntimeControl

    assert "cancel_check" not in captured["metadata"]
    control = captured["runtime_control"]
    assert isinstance(control, MainAgentRuntimeControl)
    check = control.cancel_check
    assert check() is False
    cancel_event.set()
    assert check() is True


@pytest.mark.parametrize("duration", [0, 12.5, -1, True, "12", None, float("inf"), float("nan")])
def test_ws_live_tool_summary_preserves_complete_output(monkeypatch, duration):
    from backend.ws import agent_ws
    import agent.app.service as service
    from agent.runtime.stream_emitter import StreamEmitter

    long_summary = "x" * 20_000

    class FakeResult:
        def to_dict(self):
            return {
                "ok": True,
                "final_response": long_summary,
                "events": [],
                "tool_calls": [],
                "metadata": {},
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            for event_type in ("tool_call", "tool_result"):
                StreamEmitter().emit(event_type, {
                    "tool_id": "knowledge.manage",
                    "ok": True,
                    "summary": long_summary,
                    "duration_ms": duration,
                })
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    event_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "q", "s-1", "default", {}, event_queue,
        {"error": None}, {"live_events": 0},
    )
    messages = []
    while not event_queue.empty():
        messages.append(event_queue.get())
    live_events = [item for item in messages if isinstance(item, dict) and item.get("name") in ("tool_call", "tool_result")]
    done = next(item for item in messages if item.get("type") == "done")
    assert len(live_events) == 2
    for live in live_events:
        assert live["data"]["summary"] == long_summary
        if type(duration) in (int, float) and 0 <= duration < float("inf"):
            assert live["data"]["duration_ms"] == duration
        else:
            assert "duration_ms" not in live["data"]
    assert done["final_response"] == long_summary


def test_ws_duplicate_client_request_skips_second_agent_execution(monkeypatch):
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle

    calls = {"count": 0}

    class FakeResult:
        def to_dict(self):
            return {
                "ok": True,
                "final_response": "first answer",
                "session_id": "s-idempotent",
                "turn_id": "run-idempotent",
                "trace_id": "trace-idempotent",
                "events": [],
                "tool_calls": [],
                "metadata": {},
                "warnings": [],
                "errors": [],
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            calls["count"] += 1
            return FakeResult()

    claims = iter((
        lifecycle.SessionTurnClaim(job_id="job-idempotent"),
        lifecycle.SessionTurnClaim(
            job_id="job-idempotent",
            should_execute=False,
            status="running",
        ),
    ))
    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    monkeypatch.setattr(lifecycle, "claim_session_turn", lambda *_args, **_kwargs: next(claims))

    first_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "same request", "s-idempotent", "default",
        {"client_request_id": "request-idempotent"},
        first_queue, {"error": None}, {"live_events": 0},
    )
    second_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "same request", "s-idempotent", "default",
        {"client_request_id": "request-idempotent"},
        second_queue, {"error": None}, {"live_events": 0},
    )

    assert calls["count"] == 1
    duplicate_done = next(item for item in list(second_queue.queue) if item.get("type") == "done")
    assert duplicate_done["metadata"]["idempotent"] is True
    assert duplicate_done["metadata"]["idempotent_redirect"] == {
        "job_id": "job-idempotent", "status": "running",
        "client_request_id": "request-idempotent",
    }


def test_ws_worker_replays_durable_cancel_requested_after_active_registration(monkeypatch):
    import queue
    import threading
    from types import SimpleNamespace
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle
    import jobs.store as job_store

    captured = {}

    class FakeResult:
        def to_dict(self):
            return {"ok": False, "final_response": "", "events": [], "tool_calls": [], "metadata": {}, "errors": ["cancelled_by_user"]}

    class FakeApp:
        def submit_user_message(self, **kwargs):
            captured.update(kwargs)
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    monkeypatch.setattr(
        lifecycle,
        "claim_session_turn",
        lambda *_args, **_kwargs: lifecycle.SessionTurnClaim(job_id="job_pre_registered_cancel"),
    )
    monkeypatch.setattr(
        job_store,
        "get_job",
        lambda *_args, **_kwargs: SimpleNamespace(cancel_requested=True),
    )
    monkeypatch.setattr(lifecycle, "finish_session_turn_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lifecycle, "finish_claimed_session_turn", lambda *_args, **_kwargs: None)

    cancel_event = threading.Event()
    agent_ws._run_agent_thread(
        "cancel before registration", "session-pre-cancel", "default",
        {"client_request_id": "request-pre-cancel"}, queue.Queue(),
        {"error": None}, {"live_events": 0}, cancel_event,
    )

    assert cancel_event.is_set() is True
    assert captured["runtime_control"].cancel_check() is True


def test_ws_worker_projects_unknown_outcome_into_durable_job_snapshot(monkeypatch):
    import queue
    from types import SimpleNamespace
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle
    import jobs.store as job_store

    unknown = {
        "tool_id": "workspace.file",
        "call_id": "write-unknown",
        "error_code": "TOOL_TIMEOUT_UNCERTAIN",
        "execution_may_continue": True,
    }
    snapshots = []

    class FakeResult:
        def to_dict(self):
            return {
                "ok": False,
                "final_response": "",
                "events": [],
                "tool_calls": [],
                "metadata": {"unknown_outcome": unknown},
                "errors": ["unknown_outcome"],
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    monkeypatch.setattr(
        lifecycle,
        "claim_session_turn",
        lambda *_args, **_kwargs: lifecycle.SessionTurnClaim(job_id="job_unknown_snapshot"),
    )
    monkeypatch.setattr(
        job_store,
        "get_job",
        lambda *_args, **_kwargs: SimpleNamespace(cancel_requested=False),
    )
    monkeypatch.setattr(
        lifecycle,
        "finish_session_turn_snapshot",
        lambda *_args, **kwargs: snapshots.append(kwargs),
    )
    monkeypatch.setattr(lifecycle, "finish_claimed_session_turn", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lifecycle, "attach_run_to_session_job", lambda *_args, **_kwargs: None)

    agent_ws._run_agent_thread(
        "unknown outcome", "session-unknown", "default",
        {"client_request_id": "request-unknown"}, queue.Queue(),
        {"error": None}, {"live_events": 0},
    )

    assert snapshots[-1]["unknown_outcome"] == unknown


def test_terminal_stamp_is_serialized_with_inflight_token(monkeypatch, temp_dirs):
    import threading
    from backend.ws import agent_ws
    from agent.runtime.stream_emitter import StreamEmitter
    import agent.app.service as service

    token_entered = threading.Event()
    release_token = threading.Event()
    terminal_entered = threading.Event()
    original_stamp = agent_ws._stamp_replay_frame
    callbacks = []

    def stamp(*args):
        if args[-1].get("type") == "token":
            token_entered.set()
            assert release_token.wait(2)
        if args[-1].get("type") == "done":
            terminal_entered.set()
            release_token.set()
        return original_stamp(*args)

    class Result:
        def to_dict(self):
            return {"ok": True, "final_response": "hi", "events": [], "tool_calls": [], "metadata": {}}

    class App:
        def submit_user_message(self, **_kwargs):
            callback = StreamEmitter._get_realtime()
            thread = threading.Thread(target=lambda: callback({"type": "token", "content": "hi"}))
            callbacks.append(thread)
            thread.start()
            assert token_entered.wait(1)
            # Release after the terminal attempts to stamp, or when it correctly
            # waits for the callback's emission lock.
            def release():
                terminal_entered.wait(0.05)
                release_token.set()
            threading.Thread(target=release).start()
            return Result()

    monkeypatch.setattr(agent_ws, "_stamp_replay_frame", stamp)
    monkeypatch.setattr(service, "get_default_agent_app", lambda: App())
    events = queue.Queue()
    agent_ws._run_agent_thread("q", "sess-race", "default", {"client_request_id": "req-race"}, events, {"error": None}, {"live_events": 0})
    for thread in callbacks:
        thread.join(2)
    frames = [item for item in list(events.queue) if isinstance(item, dict)]
    assert [item["seq"] for item in frames] == list(range(1, len(frames) + 1))
    assert frames[-1]["type"] == "done"
    assert all(item["type"] == "token" for item in frames[:-1])
    assert "".join(item["content"] for item in frames[:-1]) == "hi"


def test_running_redirect_does_not_write_a_terminal_to_real_turn_log(monkeypatch, temp_dirs):
    from backend.ws import agent_ws
    from agent.runtime.turn_replay import append_frame, frames_after
    import jobs.lifecycle as lifecycle
    import jobs.store as store
    append_frame("default", "sess-redirect", "req", {"type": "token", "content": "first"})
    monkeypatch.setattr(lifecycle, "claim_session_turn", lambda *a, **kw: lifecycle.SessionTurnClaim(
        job_id="job", should_execute=False, status="running"))
    monkeypatch.setattr(store, "get_job", lambda *a, **kw: None)
    events = queue.Queue()
    agent_ws._run_agent_thread("q", "sess-redirect", "default", {"client_request_id": "req"}, events, {"error": None}, {})
    append_frame("default", "sess-redirect", "req", {"type": "token", "content": "second"})
    assert [item["type"] for item in frames_after("default", "sess-redirect", "req", 0)] == ["token", "token"]
    assert events.get()["metadata"]["idempotent_redirect"]["status"] == "running"


@pytest.mark.parametrize("persist_before_failure", [False, True])
def test_ws_claim_registry_write_failure_never_submits_or_closes_request(monkeypatch, tmp_path, persist_before_failure):
    """Include the uncertain case: the write committed before reporting failure."""
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle
    import jobs.store as store

    path = tmp_path / "claim.json"
    original_write = lifecycle._write_request_record
    submits, finished, stamps = [], [], []
    def fail_write(record_path, record):
        if persist_before_failure:
            original_write(record_path, record)
        raise OSError("synthetic storage write failure")

    monkeypatch.setattr(lifecycle, "_request_registry_path", lambda *a: path)
    monkeypatch.setattr(lifecycle, "_prune_request_registry_unlocked", lambda *a: None)
    monkeypatch.setattr(lifecycle, "_running_session_turn_unlocked", lambda *a: None)
    monkeypatch.setattr(lifecycle, "_begin_session_turn_unlocked", lambda *a, **kw: "job-claim")
    monkeypatch.setattr(lifecycle, "_write_request_record", fail_write)
    monkeypatch.setattr(store, "get_job", lambda *a: None)
    monkeypatch.setattr(lifecycle, "get_job", lambda *a: None)
    monkeypatch.setattr(service, "get_default_agent_app", lambda: submits.append(True))
    monkeypatch.setattr(lifecycle, "finish_claimed_session_turn", lambda *a, **kw: finished.append(kw))
    monkeypatch.setattr(lifecycle, "finish_session_turn_snapshot", lambda *a, **kw: finished.append(kw))
    monkeypatch.setattr(agent_ws, "_stamp_replay_frame", lambda *a: stamps.append(a))

    responses = []
    for _ in range(2):
        events = queue.Queue()
        agent_ws._run_agent_thread(
            "same write request", "session-claim-failure", "default",
            {"client_request_id": "request-claim-failure"}, events, {"error": None}, {},
        )
        responses.append([item for item in list(events.queue) if isinstance(item, dict)])

    assert submits == [] and finished == [] and stamps == []
    assert responses[0][0]["type"] == "error"
    assert responses[0][0]["error_code"] == "session_turn_claim_failed"
    assert responses[0][0]["retryable"] is True
    assert responses[0][0]["client_request_id"] == "request-claim-failure"
    if persist_before_failure:
        assert responses[1][0]["metadata"]["idempotent_redirect"]["status"] == "running"
        assert lifecycle._read_request_record(path)["status"] == "running"
    else:
        assert responses[1][0]["error_code"] == "session_turn_claim_failed"


@pytest.mark.parametrize("status", ["running", "conflict", "succeeded", "failed", "cancelled"])
def test_ws_already_claimed_request_returns_existing_status_or_result(monkeypatch, status):
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle
    import jobs.store as store
    import storage.run_record_store as runs

    submits = []
    active_turn = object()
    monkeypatch.setattr(agent_ws, "_active_turns", {("", "default", "job-existing"): active_turn})
    monkeypatch.setattr(service, "get_default_agent_app", lambda: submits.append(True))
    monkeypatch.setattr(lifecycle, "claim_session_turn", lambda *a, **kw: lifecycle.SessionTurnClaim(
        job_id="job-existing", should_execute=False, status=status,
        run_id="run-existing", trace_id="trace-existing",
    ))
    monkeypatch.setattr(store, "get_job", lambda *a: None)
    monkeypatch.setattr(runs, "get_run", lambda *a: {"final_response_summary": "stored answer"})
    events = queue.Queue()
    agent_ws._run_agent_thread(
        "retry", "session-existing", "default", {"client_request_id": "request-existing"},
        events, {"error": None}, {},
    )
    frame = events.get()
    assert submits == [] and frame["type"] == "done"
    assert frame["metadata"]["idempotent_redirect"]["status"] == status
    assert frame["final_response"] == ("stored answer" if status == "succeeded" else "")
    assert agent_ws._active_turns[("", "default", "job-existing")] is active_turn


def test_ws_duplicate_result_lookup_failure_never_falls_through_to_execution(monkeypatch):
    from backend.ws import agent_ws
    import agent.app.service as service
    import jobs.lifecycle as lifecycle
    import storage.run_record_store as runs

    submits = []
    active_turn = object()
    monkeypatch.setattr(agent_ws, "_active_turns", {("", "default", "job-existing"): active_turn})
    monkeypatch.setattr(service, "get_default_agent_app", lambda: submits.append(True))
    monkeypatch.setattr(lifecycle, "claim_session_turn", lambda *a, **kw: lifecycle.SessionTurnClaim(
        job_id="job-existing", should_execute=False, status="succeeded", run_id="run-existing",
    ))
    def fail_read(*a):
        raise OSError("synthetic read failure")
    monkeypatch.setattr(runs, "get_run", fail_read)
    events = queue.Queue()
    agent_ws._run_agent_thread(
        "retry", "session-existing", "default", {"client_request_id": "request-existing"},
        events, {"error": None}, {},
    )
    assert submits == []
    assert events.get()["error_code"] == "session_turn_claim_failed"
    assert agent_ws._active_turns[("", "default", "job-existing")] is active_turn
