"""Proposal persistence and cursor publication through the real domain store."""
from agent.runtime.memory_write import consolidator, event_log
from storage.memory_event_store import read_cursor
from storage.memory_governance import MemoryRecord, MemoryStore, MemoryWriteGate
import pytest


def test_partial_consolidation_retries_only_failed_proposal(monkeypatch):
    event_log.append_experience(workspace_id='resume-ws', session_id='resume-session', task_id='task',
        user_input='inspect', assistant_response='', tool_calls=[], task_ok=True)
    monkeypatch.setattr('storage.memory_governance.is_auto_memory_enabled', lambda _ws: True)
    monkeypatch.setattr(MemoryStore, 'search', lambda *_a, **_k: [])
    proposals = [{'action': 'ignore', 'summary': ''}, {'action': 'ignore', 'summary': 'second'}]
    reflections = []
    monkeypatch.setattr(consolidator, '_reflect', lambda *_a: reflections.append(True) or proposals)
    calls = []
    def apply(proposal, *_args):
        calls.append(proposal['proposal_id'])
        return {'ok': len(calls) != 2, 'status': 'ok'}
    monkeypatch.setattr(consolidator, '_apply', apply)
    args = dict(workspace_id='resume-ws', session_id='resume-session', task_id='task')
    first = consolidator._consolidate_locked(**args)
    assert first['status'] == 'retry_pending'
    assert event_log.pending_experiences('resume-ws', 'resume-session')
    second = consolidator._consolidate_locked(**args)
    assert second['status'] == 'processed'
    assert not event_log.pending_experiences('resume-ws', 'resume-session')
    assert not read_cursor('resume-ws', 'resume-session')['consolidation_batches']
    assert len(calls) == 3 and len(reflections) == 1
    assert calls[0] != calls[1] and calls[1] == calls[2]


@pytest.mark.parametrize("rejection", ["missing_target", "private_key", "stale_target"])
def test_terminal_rejection_finishes_batch_and_allows_new_experiences(monkeypatch, rejection):
    args = dict(workspace_id="terminal-ws", session_id="terminal-session", task_id="task")
    event_log.append_experience(**args, user_input="inspect", assistant_response="",
                               tool_calls=[], task_ok=True)
    monkeypatch.setattr("storage.memory_governance.is_auto_memory_enabled", lambda _ws: True)
    proposal = {"action": "create" if rejection == "private_key" else "supersede",
        "target_memory_id": "" if rejection == "private_key" else "mem-000000000001",
        "memory_type": "semantic_fact", "scope": "workspace", "summary": "Candidate",
        "content": ("The synthetic service supports offline inspection." if rejection != "private_key"
            else "-----BEGIN " + "RSA PRIVATE KEY-----\nSYNTHETIC_INVALID_PAYLOAD\n"),
        "score": 4, "confidence": 0.9}
    if rejection == "stale_target":
        store = MemoryStore()
        store._save(MemoryRecord(workspace_id=args["workspace_id"], memory_id="mem-000000000001",
            memory_type="semantic_fact", content="Original synthetic record.", status="active"))
        store._save(MemoryRecord(workspace_id=args["workspace_id"], memory_id="mem-000000000002",
            memory_type="semantic_fact", content="Published replacement record.", status="active",
            metadata={"supersedes_memory_id": "mem-000000000001"}))
    reflections = []
    monkeypatch.setattr(consolidator, "_reflect", lambda *_a:
        reflections.append(True) or ([proposal] if len(reflections) == 1 else [{"action": "ignore"}]))
    first = consolidator.consolidate_experiences(**args)
    assert first["status"] == "processed" and first["processed"] == 1
    assert first["rejected"] == 1 and first["results"][0]["ok"] is False
    if rejection == "missing_target":
        assert first["results"][0]["error"] == "invalid_memory_revision_target"
    elif rejection == "stale_target":
        assert first["results"][0]["error"] == "memory_revision_stale"
    cursor = read_cursor(args["workspace_id"], args["session_id"])
    assert not cursor["consolidation_batches"]
    assert list(cursor["consolidation_rejections"].values())[0]["rejected"] is True
    assert not event_log.pending_experiences(args["workspace_id"], args["session_id"])
    event_log.append_experience(**args, user_input="new experience", assistant_response="",
                               tool_calls=[], task_ok=True)
    second = consolidator.consolidate_experiences(**args)
    assert second["status"] == "processed" and second["processed"] == 1
    assert second["rejected"] == 0 and len(reflections) == 2


def test_saved_rejection_is_not_replayed_after_another_proposal_retries(monkeypatch):
    args = dict(workspace_id="reject-resume-ws", session_id="reject-resume-session", task_id="task")
    event_log.append_experience(**args, user_input="inspect", assistant_response="",
                               tool_calls=[], task_ok=True)
    monkeypatch.setattr("storage.memory_governance.is_auto_memory_enabled", lambda _ws: True)
    monkeypatch.setattr(consolidator, "_reflect", lambda *_a:
        [{"action": "ignore", "summary": "reject"}, {"action": "ignore", "summary": "retry"}])
    calls = []
    def apply(proposal, *_args):
        calls.append(proposal["summary"])
        if proposal["summary"] == "reject":
            return {"ok": False, "status": "rejected", "rejected": True, "error": "invalid_memory_scope"}
        return {"ok": calls.count("retry") > 1, "status": "ok"}
    monkeypatch.setattr(consolidator, "_apply", apply)
    assert consolidator._consolidate_locked(**args)["status"] == "retry_pending"
    assert consolidator._consolidate_locked(**args)["status"] == "processed"
    assert calls == ["reject", "retry", "retry"]


def test_unknown_write_only_reconciles_and_never_replays(monkeypatch):
    args = dict(workspace_id="unknown-ws", session_id="unknown-session", task_id="task")
    event_log.append_experience(**args, user_input="inspect", assistant_response="",
                               tool_calls=[], task_ok=True)
    monkeypatch.setattr("storage.memory_governance.is_auto_memory_enabled", lambda _ws: True)
    monkeypatch.setattr(consolidator, "_reflect", lambda *_a: [{"action": "ignore"}])
    calls = []
    def apply(*_args):
        calls.append(True)
        raise OSError("synthetic uncertain write")
    monkeypatch.setattr(consolidator, "_apply", apply)
    for _ in range(2):
        result = consolidator._consolidate_locked(**args)
        assert result["status"] == "retry_pending"
        assert result["results"][0]["status"] == "execution_unknown"
    assert calls == [True]
    assert event_log.pending_experiences(args["workspace_id"], args["session_id"])


@pytest.mark.parametrize("error", ["invalid_memory_id", "memory_identity_conflict"])
def test_permanent_identity_rejections_are_explicit_and_do_not_write(error):
    store = MemoryStore()
    record = MemoryRecord(workspace_id="identity-rejection-ws", source="user",
                          memory_type="semantic_fact", content="New synthetic fact.")
    if error == "invalid_memory_id":
        record.memory_id = "invalid-identity"
    else:
        store._save(MemoryRecord(workspace_id=record.workspace_id, memory_id=record.memory_id,
            memory_type=record.memory_type, content="Existing synthetic fact."))
    result = MemoryWriteGate(store).write(record)
    assert result["error"] == error and result["ok"] is False
    assert result["status"] == "rejected" and result["rejected"] is True
    existing = store.get(record.workspace_id, record.memory_id)
    if error == "invalid_memory_id":
        assert existing is None
    else:
        assert existing.content == "Existing synthetic fact."
