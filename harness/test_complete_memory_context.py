"""Lossless memory, prompt, and explicit file pagination regression contracts."""
from types import SimpleNamespace

from agent.runtime.memory_write.commands import parse_memory_command
from agent.runtime.memory_write.consolidator import _safe_event, _safe_existing, _parse_operations
from agent.runtime.memory_write import event_log
from core.runtime_engine.prompt_contract import trusted_prompt_item, build_runtime_system_prompt
from core.tools.general_tools import memory_tools, file_tools
from core.tools.schemas import ToolInvocation
from storage.memory_governance import MemoryStore, MemoryRecord


def inv(tool, **args):
    return ToolInvocation(tool_id=tool, workspace_id="test_ws", arguments=args)


def test_memory_content_and_reflection_are_complete():
    text = "请记住：\n" + "完整内容\n" * 1500 + "末尾约束"
    assert parse_memory_command(text)["content"] == text
    event = _safe_event({"user_input": text, "assistant_response": text, "tool_calls": [{}] * 30})
    assert event["user_input"] == event["assistant_response"] == text
    assert len(event["tool_calls"]) == 30
    assert _safe_existing({"content": text})["content"] == text
    import json
    proposals = _parse_operations(json.dumps([{"action": "create", "memory_type": "semantic_fact", "content": text}] * 9))
    assert len(proposals) == 9
    assert all(p["content"] == text for p in proposals)


def test_complete_memory_tool_write_read_search(monkeypatch):
    from storage.memory_governance import MemoryWriteGate
    saved = []
    monkeypatch.setattr(MemoryWriteGate, "write", lambda self, rec: saved.append(rec) or {"ok": True, "memory_id": rec.memory_id, "status": "pending"})
    text = "记忆正文" * 2000
    memory_tools.handle_memory_create(inv("memory.manage", content=text))
    assert saved[0].content == text
    store = SimpleNamespace(get=lambda ws, mid: saved[0], search=lambda *args, **kwargs: [saved[0].to_dict()])
    monkeypatch.setattr(memory_tools, "_get_store", lambda ws: store)
    assert text in str(memory_tools.handle_memory_get(inv("memory.manage", memory_id=saved[0].memory_id)))
    assert text in str(memory_tools.handle_memory_search(inv("memory.manage", query="记忆")))
    assert MemoryStore().projection_item(saved[0])["content"] == text


def test_journal_no_reprocessing_after_500_events(monkeypatch):
    cursor = {}
    monkeypatch.setattr(event_log, "read_cursor", lambda *args: cursor)
    monkeypatch.setattr(event_log, "save_cursor", lambda ws, sid, value: cursor.update(value))
    ids = [f"event-{i}" for i in range(700)]
    event_log.mark_experiences_processed("test_ws", "test_session", ids)
    assert cursor["processed_event_ids"] == ids
    monkeypatch.setattr(event_log, "read_events", lambda *args: [{"event_id": x} for x in ids + ["new1", "new2"]])
    assert event_log.pending_experiences("test_ws", "test_session", limit=1) == [{"event_id": "new1"}]


def test_journal_preserves_complete_turn(monkeypatch):
    monkeypatch.setattr(event_log, "append_event", lambda *args: None)
    text = "内容" * 4000
    event = event_log.append_experience(workspace_id="test_ws", session_id="test_session", task_id="task", user_input=text,
                                      assistant_response=text, tool_calls=[{"summary": text}] * 30, task_ok=True)
    assert event["user_input"] == event["assistant_response"] == text
    assert len(event["tool_calls"]) == 30
    assert event["tool_calls"][-1]["summary"] == text


def test_shared_memory_and_exact_transient_scope(monkeypatch):
    from core.context.unified_retriever import UnifiedRetriever
    shared = MemoryRecord(workspace_id="other_ws", scope="workspace", status="active", memory_type="core_rule", content="shared")
    private = MemoryRecord(workspace_id="test_ws", scope="task", task_id="other_task", session_id="same", status="active", content="private")
    monkeypatch.setattr(MemoryStore, "list_all", lambda *args: [shared, private])
    visible = MemoryStore().list_retrievable("test_ws", session_id="same", task_id="current", limit=0)
    assert [r["content"] for r in visible] == ["shared"]
    retriever = object.__new__(UnifiedRetriever)
    retriever.workspace_id = "test_ws"
    assert retriever._memory_scope_visible(shared.to_dict(), session_id="same", task_id="current")
    assert not retriever._memory_scope_visible(private.to_dict(), session_id="same", task_id="current")


def test_memory_search_filters_before_ranking_and_paginates(monkeypatch):
    records = [MemoryRecord(status="rejected", content="match") for _ in range(40)]
    records += [MemoryRecord(status="active", content=f"match {i}") for i in range(12)]
    monkeypatch.setattr(MemoryStore, "list_all", lambda *args: records)
    store = MemoryStore()
    first = store.search("test_ws", "", retrievable_only=True, limit=7)
    second = store.search("test_ws", "", retrievable_only=True, limit=7, offset=7)
    assert len(first) == 7 and len(second) == 5
    assert len({r["memory_id"] for r in first + second}) == 12


def test_trusted_prompts_and_subagent_contract_are_not_cut():
    text = "完整约束" * 12000 + "结尾"
    for source in ["workbench_skill", "task_state", "managed_attachment"]:
        assert trusted_prompt_item(source, text).content == text
    assert text in build_runtime_system_prompt({"subagent_profile": {"role": text, "output_contract": text}})


def test_large_text_read_and_directory_pagination(monkeypatch, tmp_path):
    monkeypatch.setattr(file_tools, "_workspace_path", lambda ws, path: tmp_path / path)
    text = "long line\n" * 120000
    (tmp_path / "large.txt").write_text(text)
    result = file_tools.handle_file_read(inv("workspace.file", filepath="large.txt"))
    assert result["preview"] == text
    # _ok serializes the tool payload under output; find that envelope without
    # relying on a presentation-only summary.
    import json
    def payload(result):
        value = result.get("output", result)
        return json.loads(value) if isinstance(value, str) else value
    first = payload(file_tools.handle_file_read(inv("workspace.file", filepath="large.txt", limit=2)))
    assert first["preview"] == "long line\n" * 2
    assert first["next_offset"] == 2 and first["total_lines"] == 120000
    for i in range(220):
        (tmp_path / f"file-{i:03d}").touch()
    a = payload(file_tools.handle_ws_list_files(inv("workspace.file", limit=200)))
    b = payload(file_tools.handle_ws_list_files(inv("workspace.file", limit=200, offset=a["next_offset"])))
    assert len(a["files"]) + len(b["files"]) == 221
    assert b["next_offset"] is None


def test_core_rules_not_limited_to_eight_and_failure_visible(monkeypatch):
    from core.context import unified_retriever
    from agent.runtime.ssot_runtime import _build_retrieved_context_block
    reader = SimpleNamespace(retrieve_for_context=lambda *args, **kwargs: {"memory_hits": [], "knowledge_hits": []})
    monkeypatch.setattr(unified_retriever, "get_retriever", lambda ws: reader)
    rules = [MemoryRecord(memory_type="core_rule", scope="workspace", status="active", content=f"constraint-{i}") for i in range(15)]
    monkeypatch.setattr(MemoryStore, "list_all", lambda *args: rules)
    args = dict(workspace_id="test_ws", session_id="session", task_id="task", user_input="test")
    assert "constraint-14" in _build_retrieved_context_block(**args)
    def fail(*args):
        raise OSError("private diagnostic detail")
    monkeypatch.setattr(unified_retriever, "get_retriever", fail)
    text = _build_retrieved_context_block(**args)
    assert "context_load_failed" in text and "private diagnostic" not in text


def test_failed_memory_write_does_not_consume_experience(monkeypatch):
    from agent.runtime.memory_write import consolidator
    import storage.memory_governance as governance
    monkeypatch.setattr(governance, "is_auto_memory_enabled", lambda ws: True)
    monkeypatch.setattr(event_log, "pending_experiences", lambda *args, **kwargs: [{"event_id": "one"}])
    monkeypatch.setattr(MemoryStore, "search", lambda *args, **kwargs: [])
    monkeypatch.setattr(consolidator, "_reflect", lambda *args: [{}])
    monkeypatch.setattr(consolidator, "_apply", lambda *args: {"ok": False})
    marked = []
    monkeypatch.setattr(event_log, "mark_experiences_processed", lambda *args: marked.append(args))
    result = consolidator._consolidate_locked(workspace_id="test_ws", session_id="session", task_id="task")
    assert result["status"] == "retry_pending" and not marked


def test_corrupt_memory_is_not_silently_missing(monkeypatch, tmp_path):
    store = MemoryStore()
    monkeypatch.setattr(store, "_dir", lambda ws: tmp_path)
    (tmp_path / "mem-123456abcdef.json").write_text("{broken")
    healthy = MemoryRecord(workspace_id="test_ws", content="healthy", status="active")
    (tmp_path / f"{healthy.memory_id}.json").write_text(__import__("json").dumps(healthy.to_dict()))
    assert [record.content for record in store.list_all("test_ws")] == ["healthy"]
    assert store.load_errors() == [{"path": "mem-123456abcdef.json", "error": "JSONDecodeError"}]
    assert store.get("test_ws", "mem-123456abcdef") is None
    assert store.load_errors()
