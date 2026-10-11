"""A frame that was not persisted must not be sent with an invented sequence."""

import queue

import pytest

from backend.ws.agent_ws import ReplayPersistError, _stamp_replay_frame


def test_persist_failure_does_not_invent_a_sequence(monkeypatch):
    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("agent.runtime.turn_replay.append_frame", fail)
    with pytest.raises(ReplayPersistError):
        _stamp_replay_frame(
            "default", "sess1", "req-1", "", {"event_seq": 0}, __import__("threading").Lock(),
            {"type": "token", "content": "hello"},
        )


def test_live_callback_stops_after_persist_failure(monkeypatch, temp_dirs):
    from backend.ws import agent_ws
    import agent.app.service as service
    from agent.runtime.stream_emitter import StreamEmitter

    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("agent.runtime.turn_replay.append_frame", fail)

    class FakeResult:
        def to_dict(self):
            return {
                "ok": True, "final_response": "answer", "session_id": "sess1",
                "turn_id": "t-1", "trace_id": "trace-1", "events": [], "tool_calls": [],
                "metadata": {}, "warnings": [], "errors": [],
            }

    class FakeApp:
        def submit_user_message(self, **_kwargs):
            StreamEmitter().emit("token", {"content": "one"})
            StreamEmitter().emit("token", {"content": "two"})
            return FakeResult()

    monkeypatch.setattr(service, "get_default_agent_app", lambda: FakeApp())
    event_queue = queue.Queue()
    agent_ws._run_agent_thread(
        "q", "sess1", "default", {"client_request_id": "req-fault"},
        event_queue, {"error": None}, {"live_events": 0},
    )
    frames = []
    while not event_queue.empty():
        item = event_queue.get()
        if isinstance(item, dict):
            frames.append(item)
    assert not any(item.get("type") == "token" and item.get("seq") for item in frames)
    assert any(item.get("error_code") == "replay_persist_failed" for item in frames)
    assert sum(1 for item in frames if item.get("error_code") == "replay_persist_failed") == 1
