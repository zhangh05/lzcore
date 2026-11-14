"""Reset/export use scoped durable APIs and propagate failure to slash tools."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from agent.app.facade import AgentApp
from agent.runtime.command_system import execute_command, register_default_commands
from storage.message_store import SessionMessageStore
from storage.session_store import ensure_session, get_session


@pytest.fixture
def session_app(monkeypatch):
    app = AgentApp()
    monkeypatch.setattr("agent.app.service.get_default_agent_app", lambda: app)
    monkeypatch.setattr("core.tools.project_execution.environment_for", lambda *a: None)
    register_default_commands()
    ensure_session("session-reset", "reset-ws")
    SessionMessageStore("session-reset", "reset-ws").write_message("old", "user", "old constraint")
    return app


def invoke(command, **kwargs):
    from core.tools.general_tools.command_tools import handle_slash_run
    return handle_slash_run(SimpleNamespace(tool_id="slash.run", session_id="session-reset",
                                           workspace_id="reset-ws", arguments={"command": command, **kwargs}))


def test_reset_archives_evicts_and_rejects_reuse_without_deleting_audit(session_app, monkeypatch):
    sid, session, turn_lock = session_app.session_manager.get_or_create("session-reset", "reset-ws")
    assert session.history
    # Production slash tools run in a worker while the caller holds this lock.
    with turn_lock, ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(invoke, "reset").result(timeout=3)
    assert result["ok"] and "new_session_required: True" in result["result"]
    assert get_session(sid, "reset-ws")["status"] == "archived"
    assert session_app.inspect_sessions()["session_count"] == 0
    assert SessionMessageStore(sid, "reset-ws").get_messages()[0]["content"] == "old constraint"
    monkeypatch.setattr("agent.app.facade.AgentThread.submit", lambda *a: pytest.fail("reset session cannot run"))
    assert session_app.submit_user_message("continue", "reset-ws", sid).error_type == "session_reset_archived"
    # The durable barrier also applies after restart.
    assert AgentApp().submit_user_message("continue", "reset-ws", sid).error_type == "session_reset_archived"


@pytest.mark.parametrize("failure", ["io", "missing"])
def test_reset_failure_reaches_tool_envelope_and_preserves_live_session(session_app, monkeypatch, failure):
    session_app.session_manager.get_or_create("session-reset", "reset-ws")
    def update(*a, **kw):
        if failure == "io":
            raise OSError("synthetic private detail")
        return None
    monkeypatch.setattr("storage.session_store.update_session", update)
    result = invoke("reset")
    assert not result["ok"] and result["errors"] == ["session_reset_failed"]
    assert get_session("session-reset", "reset-ws")["status"] == "active"
    assert session_app.inspect_sessions()["session_count"] == 1


def test_export_preserves_full_ordered_content_and_exact_limit_status(session_app):
    store = SessionMessageStore("session-reset", "reset-ws")
    store.write_message("old", "user", "first" * 500, {"created_at": "2026-01-01T00:00:00Z"})
    store.write_message("old", "assistant", "second" * 500, {"created_at": "2026-01-01T00:00:01Z"})
    SessionMessageStore("session-reset", "other-ws").write_message("other", "user", "OTHER-WORKSPACE")
    result = invoke("export", args="json")
    assert result["ok"]
    text = result["result"]
    assert "first" * 500 in text and "second" * 500 in text
    assert text.index("first" * 500) < text.index("second" * 500)
    assert "OTHER-WORKSPACE" not in text and "truncated: False" in text
    exact = execute_command("export", {"format": "json", "limit": 2}, "session-reset", "reset-ws")
    assert "message_count: 2" in exact and "truncated: False" in exact
    limited = execute_command("export", {"format": "json", "limit": 1}, "session-reset", "reset-ws")
    assert "message_count: 1" in limited and "truncated: True" in limited


def test_export_storage_failure_cannot_be_reported_as_no_messages(session_app, monkeypatch):
    def fail(*a):
        raise OSError("synthetic private detail")
    monkeypatch.setattr(SessionMessageStore, "get_messages", fail)
    result = invoke("export", args="json")
    assert not result["ok"] and result["errors"] == ["session_export_failed"]
    assert "No messages" not in str(result)


@pytest.mark.parametrize("command", ["reset", "export"])
def test_session_commands_require_explicit_workspace_and_session(session_app, command):
    with pytest.raises(RuntimeError, match=f"session_{command}_failed"):
        execute_command(command, "", "session-reset")
    with pytest.raises(RuntimeError, match=f"session_{command}_failed"):
        execute_command(command, "", workspace_id="reset-ws")
