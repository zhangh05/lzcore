"""Ordered turn replay: terminal frames have their own sequence."""

from __future__ import annotations

import json
import time

from agent.runtime.turn_replay import append_frame, frames_after, subscribe_turn


def test_done_gets_a_new_sequence_after_the_last_token(temp_dirs):
    append_frame("default", "sess1", "req-1", {"type": "token", "content": "hi"}, username="")
    done = append_frame(
        "default", "sess1", "req-1",
        {"type": "done", "final_response": "hi"},
        username="",
    )
    assert done["seq"] == 2
    assert done["stream_seq"] == 2
    replay = frames_after("default", "sess1", "req-1", 1, username="")
    assert [frame["type"] for frame in replay] == ["done"]


def test_replay_is_isolated_by_request(temp_dirs):
    append_frame("default", "sess1", "req-a", {"type": "token", "content": "a"}, username="")
    append_frame("default", "sess1", "req-b", {"type": "token", "content": "b"}, username="")
    assert frames_after("default", "sess1", "req-a", 0, username="")[0]["content"] == "a"
    assert frames_after("default", "sess1", "req-b", 0, username="")[0]["content"] == "b"


def test_subscribe_replays_then_follows_without_gap_or_duplicate(temp_dirs):
    append_frame("default", "sess1", "req-live", {"type": "token", "content": "one"}, username="")
    sent: list[dict] = []

    def send(payload: str) -> bool:
        sent.append(json.loads(payload))
        return True

    unsubscribe = subscribe_turn(
        "default", "sess1", "req-live", send=send, cursor=0, username="",
    )
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and len(sent) < 1:
        time.sleep(0.01)
    append_frame("default", "sess1", "req-live", {"type": "token", "content": "two"}, username="")
    append_frame("default", "sess1", "req-live", {"type": "done", "final_response": "two"}, username="")
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and len(sent) < 3:
        time.sleep(0.01)
    unsubscribe()
    assert [frame["seq"] for frame in sent] == [1, 2, 3]
    assert sent[-1]["type"] == "done"


def test_late_subscriber_does_not_replay_applied_frames(temp_dirs):
    append_frame("default", "sess1", "req-late", {"type": "token", "content": "one"}, username="")
    append_frame("default", "sess1", "req-late", {"type": "token", "content": "two"}, username="")
    sent: list[dict] = []
    unsubscribe = subscribe_turn(
        "default", "sess1", "req-late",
        send=lambda payload: sent.append(json.loads(payload)) or True,
        cursor=1,
        username="",
    )
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and len(sent) < 1:
        time.sleep(0.01)
    unsubscribe()
    assert [frame["seq"] for frame in sent] == [2]


def test_independent_readers_refresh_before_allocating_sequences(tmp_path):
    from agent.runtime.turn_replay import TurnLog

    path = tmp_path / "turn.jsonl"
    first, second = TurnLog(path), TurnLog(path)
    first.append({"type": "token"}, session_id="s", client_request_id="r")
    assert len(second.after(0)) == 1
    first.append({"type": "token"}, session_id="s", client_request_id="r")
    second.append({"type": "done"}, session_id="s", client_request_id="r")
    assert [item["seq"] for item in first.after(0)] == [1, 2, 3]


def _append_in_process(path):
    from pathlib import Path
    from agent.runtime.turn_replay import TurnLog
    log = TurnLog(Path(path))
    for _ in range(12):
        log.append({"type": "token"}, session_id="s", client_request_id="r")


def test_concurrent_processes_use_one_sequence(tmp_path):
    import multiprocessing
    from agent.runtime.turn_replay import TurnLog
    context = multiprocessing.get_context("spawn")
    path = tmp_path / "turn.jsonl"
    workers = [context.Process(target=_append_in_process, args=(str(path),)) for _ in range(2)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(10)
        assert worker.exitcode == 0
    assert [item["seq"] for item in TurnLog(path).after(0)] == list(range(1, 25))


def test_request_ids_cannot_collide_after_sanitizing_or_truncation(temp_dirs):
    requests = ["req:a", "req/a", "a" * 80 + "1", "a" * 80 + "2"]
    for request in requests:
        append_frame("default", "sess1", request, {"type": "token", "content": request})
    for request in requests:
        frames = frames_after("default", "sess1", request, 0)
        assert len(frames) == 1
        assert frames[0]["content"] == request


def test_terminal_subscriber_releases_ownership_and_subscription(tmp_path):
    import threading
    from agent.runtime.turn_replay import TurnLog
    log = TurnLog(tmp_path / "turn.jsonl")
    log.append({"type": "done"}, session_id="s", client_request_id="r")
    closed = threading.Event()
    log.subscribe(lambda _: True, 1, on_terminal=closed.set)
    assert closed.wait(1)
    assert log.subscribers == []


def test_interrupted_json_line_is_removed_before_next_append(tmp_path):
    from agent.runtime.turn_replay import TurnLog
    path = tmp_path / "turn.jsonl"
    log = TurnLog(path)
    log.append({"type": "token", "content": "one"}, session_id="s", client_request_id="r")
    with path.open("ab") as handle:
        handle.write(b'{"seq": 2, "content":')
    log.append({"type": "done"}, session_id="s", client_request_id="r")
    assert [item["seq"] for item in TurnLog(path).after(0)] == [1, 2]


def test_unknown_resume_target_does_not_create_log_or_registry(temp_dirs):
    from agent.runtime.turn_replay import _log_path, turn_exists
    assert not turn_exists("default", "sess-unknown", "unknown")
    assert not _log_path("default", "sess-unknown", "unknown").parent.exists()
