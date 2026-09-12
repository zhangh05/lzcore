"""Regression tests for complete persisted conversation history."""
from types import SimpleNamespace

from agent.runtime.ssot_runtime import _build_history_block, _recent_session_attachments


def _message(role: str, content: str) -> dict[str, str]:
    return {"role": role, "content": content}


def test_short_repair_projects_complete_previous_exchange(monkeypatch):
    messages = [_message("user", "写一篇不少于800字的作文"), _message("assistant", "当前版本只有642字，需要继续补足。")]
    monkeypatch.setattr("agent.runtime.ssot_runtime._load_context_messages", lambda *_a, **_k: messages)
    block = _build_history_block(SimpleNamespace(), user_input="补充")
    assert "不少于800字" in block and "642字" in block


def test_history_is_not_lexically_filtered(monkeypatch):
    messages = [
        _message("user", "分析交换机配置"),
        _message("assistant", "这是设备接口、VRRP 与 OSPF 的详细分析。"),
        _message("user", "查看未来十天长三角天气"),
        _message("assistant", "天气数据已返回。"),
    ]
    monkeypatch.setattr("agent.runtime.ssot_runtime._load_context_messages", lambda *_a, **_k: messages)
    block = _build_history_block(SimpleNamespace(), user_input="继续")
    assert "OSPF" in block and "天气数据" in block


def test_historical_attachment_is_not_injected_after_topic_moved(monkeypatch):
    messages = [
        {"role": "user", "metadata": {"attachments": [{"file_id": "file_config"}]}},
        {"role": "assistant", "content": "配置分析完成"},
        {"role": "user", "content": "查询天气"},
        {"role": "assistant", "content": "想查哪个城市"},
    ]

    class Store:
        def __init__(self, **_kwargs): pass
        def get_messages(self): return messages

    monkeypatch.setattr("storage.message_store.SessionMessageStore", Store)
    session = SimpleNamespace(workspace_id="default", session_id="s1")
    assert _recent_session_attachments(session, user_input="全部") == []


def test_immediate_attachment_followup_is_reused(monkeypatch):
    messages = [
        {"role": "user", "metadata": {"attachments": [{"file_id": "file_config"}]}},
        {"role": "assistant", "content": "配置分析完成"},
    ]

    class Store:
        def __init__(self, **_kwargs): pass
        def get_messages(self): return messages

    monkeypatch.setattr("storage.message_store.SessionMessageStore", Store)
    session = SimpleNamespace(workspace_id="default", session_id="s1")
    assert _recent_session_attachments(session, user_input="再详细一点") == [{"file_id": "file_config"}]
