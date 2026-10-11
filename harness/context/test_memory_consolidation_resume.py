"""Proposal persistence and cursor publication through the real domain store."""
from agent.runtime.memory_write import consolidator, event_log
from storage.memory_event_store import read_cursor
from storage.memory_governance import MemoryStore


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
