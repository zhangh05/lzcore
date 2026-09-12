"""Proposal-level persistence prevents partial reflection replay."""
from agent.runtime.memory_write import consolidator, event_log
from storage.memory_governance import MemoryStore


def test_partial_consolidation_retries_only_failed_proposal(monkeypatch):
    cursor = {}
    events = [{"event_id": "one", "user_input": "inspect"}]
    monkeypatch.setattr("storage.memory_governance.is_auto_memory_enabled", lambda _ws: True)
    monkeypatch.setattr(event_log, "pending_experiences", lambda *_a, **_k: events)
    monkeypatch.setattr(event_log, "read_cursor", lambda *_a: cursor)
    monkeypatch.setattr(event_log, "save_cursor", lambda *_a, value: cursor.clear() or cursor.update(value))
    monkeypatch.setattr(MemoryStore, "search", lambda *_a, **_k: [])
    proposals = [
        {"action": "ignore", "memory_type": "", "content": "", "summary": ""},
        {"action": "ignore", "memory_type": "", "content": "", "summary": "second"},
    ]
    monkeypatch.setattr(consolidator, "_reflect", lambda *_a: proposals)
    calls = []

    def apply(proposal, *_args):
        calls.append(proposal["proposal_id"])
        return {"ok": len(calls) != 2, "status": "ok"}

    monkeypatch.setattr(consolidator, "_apply", apply)
    marked = []
    monkeypatch.setattr(event_log, "mark_experiences_processed", lambda *_a: marked.append(True))
    first = consolidator._consolidate_locked(workspace_id="ws", session_id="session", task_id="task")
    assert first["status"] == "retry_pending" and not marked
    second = consolidator._consolidate_locked(workspace_id="ws", session_id="session", task_id="task")
    assert second["status"] == "processed" and marked
    assert len(calls) == 3
    assert calls[0] != calls[1] and calls[1] == calls[2]
