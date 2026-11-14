"""A storage outage cannot masquerade as an empty new conversation."""
from types import SimpleNamespace

import pytest

from agent.core.session import AgentSession
from agent.core.turn import AgentTurn
from agent.protocol.op import AgentOp
from agent.runtime.ssot_context import _build_history_block, _load_context_messages
from storage.message_store import MessageHistoryUnavailable, SessionMessageStore


def fail(*a, **kw):
    raise OSError("synthetic private storage detail")


@pytest.mark.parametrize("memory", [[], [SimpleNamespace(role="user", content="partial cached history")]])
@pytest.mark.parametrize("failure", ["construct", "read", "corrupt", "invalid_role", "directory", "artifact"])
def test_history_read_failure_stops_context_even_with_partial_memory(monkeypatch, memory, failure):
    session = AgentSession(session_id="history-failed", workspace_id="history-failed-ws")
    session.history = memory
    store = SessionMessageStore(session.session_id, session.workspace_id)
    if failure == "construct":
        monkeypatch.setattr("storage.message_store.SessionMessageStore", fail)
    elif failure == "read":
        monkeypatch.setattr(SessionMessageStore, "get_messages", fail)
    elif failure == "corrupt":
        store.write_message("r", "user", "original")
        store._msg_path("r", "user").write_text("{broken", encoding="utf-8")
    elif failure == "invalid_role":
        store._messages_dir().mkdir(parents=True, exist_ok=True)
        store._msg_path("r", "user").write_text('{"role":"invalid"}', encoding="utf-8")
    elif failure == "directory":
        from pathlib import Path
        original = Path.iterdir
        def iterdir(path):
            if path == store._messages_dir():
                raise PermissionError("synthetic directory failure")
            return original(path)
        monkeypatch.setattr(Path, "iterdir", iterdir)
    else:
        monkeypatch.setattr(SessionMessageStore, "get_messages", lambda self: [
            {"role": "user", "content": "unreadable placeholder", "artifact_unavailable": True},
        ])
    for load in (_load_context_messages, _build_history_block):
        with pytest.raises(MessageHistoryUnavailable, match="^session_history_unavailable$"):
            load(session)


def test_real_empty_history_remains_valid():
    session = AgentSession(session_id="empty-history", workspace_id="history-failed-ws")
    assert _load_context_messages(session) == []
    assert _build_history_block(session) == ""


def test_runtime_history_failure_returns_typed_failure_before_engine(monkeypatch):
    from agent.runtime import ssot_runtime as runtime
    session = AgentSession(session_id="history-failed", workspace_id="history-failed-ws")
    turn = AgentTurn.from_op(AgentOp.user_message(user_input="按上一轮约束继续", session_id=session.session_id,
                                               workspace_id=session.workspace_id))
    monkeypatch.setattr(SessionMessageStore, "get_messages", fail)
    monkeypatch.setattr(runtime, "_build_ssot_runtime_tool_registry", lambda *a: {})
    monkeypatch.setattr(runtime, "_build_runtime_context_budget", lambda *a: SimpleNamespace(history_tokens=8000))
    monkeypatch.setattr(runtime, "_build_engine", lambda **kw: pytest.fail("engine must not start"))
    result = runtime.run_ssot_turn(session, turn)
    assert not result.ok and result.error_type == "session_history_unavailable"
    assert result.metadata["history_read"]["status"] == "failed"
    assert session.history == []
    assert not SessionMessageStore(session.session_id, session.workspace_id)._messages_dir().exists()


def test_app_restore_failure_is_not_cached_and_can_be_retried(monkeypatch):
    from agent.app.facade import AgentApp
    from agent.protocol.message import UserMessage
    app = AgentApp()
    with monkeypatch.context() as patch:
        patch.setattr(SessionMessageStore, "get_messages", fail)
        result = app.submit_user_message("继续", "history-failed-ws", "history-failed")
    assert not result.ok and result.error_type == "session_history_unavailable"
    assert app.inspect_sessions()["session_count"] == 0
    SessionMessageStore("history-failed", "history-failed-ws").write_message("old", "user", "saved constraint")
    _, restored, _ = app.session_manager.get_or_create("history-failed", "history-failed-ws")
    assert isinstance(restored.history[0], UserMessage)
    assert restored.history[0].content == "saved constraint"
