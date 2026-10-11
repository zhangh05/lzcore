"""Interrupted-turn closeout is per request and idempotent."""

from agent.runtime.turn_closeout import ensure_turn_terminal
from agent.runtime.turn_replay import append_frame, frames_after
from storage.message_store import SessionMessageStore


def _messages(workspace, session):
    return SessionMessageStore(session, workspace).get_messages()


def test_interrupted_closeout_writes_one_message_and_one_terminal(temp_dirs):
    ensure_turn_terminal(
        workspace_id="default", session_id="sess1", client_request_id="req-down",
        username="", outcome="interrupted", error="backend_restart_during_job",
    )
    ensure_turn_terminal(
        workspace_id="default", session_id="sess1", client_request_id="req-down",
        username="", outcome="interrupted", error="backend_restart_during_job",
    )
    assistants = [item for item in _messages("default", "sess1") if item["role"] == "assistant"]
    assert len(assistants) == 1
    assert "中断" in assistants[0]["content"]
    frames = frames_after("default", "sess1", "req-down", 0, username="")
    assert [item["type"] for item in frames].count("error") == 1


def test_existing_success_is_not_rewritten_as_interrupted(temp_dirs):
    store = SessionMessageStore("sess1", "default")
    store.write_message("run-ok", "assistant", "已经完成。", metadata={
        "client_request_id": "req-ok", "status": "succeeded",
    })
    append_frame("default", "sess1", "req-ok", {"type": "done", "final_response": "已经完成。"}, username="")
    ensure_turn_terminal(
        workspace_id="default", session_id="sess1", client_request_id="req-ok",
        username="", outcome="interrupted", error="backend_restart_during_job",
    )
    assistants = [item for item in _messages("default", "sess1") if item["role"] == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["content"] == "已经完成。"
    frames = frames_after("default", "sess1", "req-ok", 0, username="")
    assert [item["type"] for item in frames] == ["done"]


def test_failed_message_does_not_become_success(temp_dirs):
    SessionMessageStore("sess1", "default").write_message("run-fail", "assistant", "执行失败。", metadata={"client_request_id": "req-fail", "status": "error"})
    ensure_turn_terminal(workspace_id="default", session_id="sess1", client_request_id="req-fail", run_id="run-fail")
    assert frames_after("default", "sess1", "req-fail", 0)[-1]["type"] == "error"


def test_successful_job_with_missing_terminal_is_repaired(temp_dirs, monkeypatch):
    from types import SimpleNamespace
    from agent.runtime.turn_closeout import close_restarted_turns
    from storage.session_store import ensure_session
    ensure_session("sess1", "default")
    store = SessionMessageStore("sess1", "default")
    store.write_message("run-ok", "assistant", "已经完成。", metadata={"client_request_id": "req-ok"})
    append_frame("default", "sess1", "req-ok", {"type": "token", "content": "partial"})
    job = SimpleNamespace(job_id="job-ok", status="succeeded", error="", metadata={"active_turn": {"session_id": "sess1", "client_request_id": "req-ok", "status": "succeeded", "run_id": "run-ok"}})
    monkeypatch.setattr("jobs.store.list_jobs", lambda ws, **kw: [vars(job)])
    monkeypatch.setattr("jobs.store.get_job", lambda *a: job)
    monkeypatch.setattr("storage.workspace_store.list_workspace_ids", lambda: ["default"])
    monkeypatch.setattr("storage.principal.known_storage_principals", lambda: [])
    close_restarted_turns()
    assert frames_after("default", "sess1", "req-ok", 0)[-1]["type"] == "done"


def test_concurrent_closeout_writes_one_terminal(temp_dirs):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(ensure_turn_terminal, workspace_id="default", session_id="sess1", client_request_id="req-race") for _ in range(2)]
        for task in tasks:
            task.result(timeout=10)
    assert [f["type"] for f in frames_after("default", "sess1", "req-race", 0)] == ["error"]
    assert len(_messages("default", "sess1")) == 1


def test_terminal_frame_repairs_a_missing_assistant(temp_dirs):
    append_frame("default", "sess1", "req-ok", {"type": "done", "final_response": "完整答复。", "turn_id": "run-ok"})
    ensure_turn_terminal(workspace_id="default", session_id="sess1", client_request_id="req-ok", outcome="succeeded")
    assert _messages("default", "sess1")[0]["content"] == "完整答复。"
    assert len(frames_after("default", "sess1", "req-ok", 0)) == 1


def test_legacy_message_correlates_through_its_run_record(temp_dirs, monkeypatch):
    store = SessionMessageStore("sess1", "default")
    store.write_message("run-legacy", "assistant", "原始成功答复。")
    monkeypatch.setattr("storage.run_record_store.get_run", lambda *a: {"client_request_id": "req-legacy"})
    frame = ensure_turn_terminal(workspace_id="default", session_id="sess1", client_request_id="req-legacy")
    assert frame["type"] == "done" and frame["final_response"] == "原始成功答复。"
    assert len(_messages("default", "sess1")) == 1
