"""Object lifecycle, CAS, concurrency, migration and read-only recovery contracts."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict

import pytest

from agent.runtime.durable import coding_team, subagent
from agent.runtime.durable import coding_state as state
from harness.test_coding_team import team as team
from storage import coding_state_store as store, project_changes
from storage.records import atomic_save_json


def test_task_status_and_metadata_cannot_grant_or_remove_candidate_acceptance(team):
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    before = state.candidate(worker)
    worker.coding.update(phase='validated', qa_subtask_id='sub-12345678')
    subagent._save_task(worker)
    assert not subagent.merge_subagent_result('parent-task', worker.subtask_id, 'parent-ws')['ok']
    assert state.candidate(worker) == before
    # An execution/reporting failure is not evidence that sealed source failed.
    worker.status = 'failed'
    atomic_save_json('parent-ws', ('subagents', worker.subtask_id + '.json'), asdict(worker))
    qa = team.spawn('qa_agent', review=worker.subtask_id)
    assert qa['task_status'] == 'succeeded'
    reviewer = subagent._load_task('parent-ws', qa['subtask_id'])
    reviewer.status = 'failed'
    atomic_save_json('parent-ws', ('subagents', reviewer.subtask_id + '.json'), asdict(reviewer))
    assert subagent.merge_subagent_result('parent-task', worker.subtask_id, 'parent-ws')['ok']
    from scripts.benchmark_team_acceptance import verify_team
    assert verify_team('parent-ws', 'parent-session', 'files/data/app')['status'] == 'PASS'


def test_candidate_snapshot_and_completed_review_are_immutable(team):
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    with pytest.raises(ValueError, match='immutable'):
        store.change('parent-ws', 'candidates', state.candidate_id(worker.subtask_id),
                     lambda r: {**r, 'source_digest': 'forged'})
    qa = team.spawn('qa_agent', review=worker.subtask_id)
    with pytest.raises(ValueError, match='immutable'):
        store.change('parent-ws', 'reviews', state.review_id(qa['subtask_id']),
                     lambda r: {**r, 'judgement': {'verdict': 'fail'}})


def test_concurrent_reviewers_cannot_hide_peer_failure_with_a_pass(team):
    from copy import deepcopy
    first = team.spawn()
    qa = team.spawn('qa_agent', review=first['subtask_id'])
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    prior = store.read('parent-ws', 'reviews', state.review_id(qa['subtask_id']))
    peer1 = deepcopy(subagent._load_task('parent-ws', qa['subtask_id']))
    peer2 = deepcopy(peer1)
    peer1.subtask_id = 'sub-aaaaaaaa'
    peer2.subtask_id = 'sub-bbbbbbbb'
    state.start_review(peer1, state.candidate(producer))
    state.start_review(peer2, state.candidate(producer))
    state.record_judgement(peer1, {**prior['judgement'], 'verdict': 'fail', 'blocking_findings': ['failure']})
    state.record_judgement(peer2, prior['judgement'])
    state.finish_review(peer1, validation=prior['validation'], resources=prior['resources'])
    assert state.candidate(producer)['state'] == state.CandidateState.REVIEWING
    state.finish_review(peer2, validation=prior['validation'], resources=prior['resources'])
    assert state.candidate(producer)['state'] == state.CandidateState.REJECTED
    assert not state.accepted_reviews(state.candidate(producer))
    reassessment = team.spawn('qa_agent', review=first['subtask_id'])
    assert reassessment['task_status'] == 'succeeded'
    assert state.candidate(producer)['state'] == state.CandidateState.ACCEPTED
    assert store.read('parent-ws', 'reviews', state.review_id(peer1.subtask_id))['outcome'] == 'fail'


def test_state_machine_rejects_invalid_transitions_and_stale_writers(team):
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    candidate = state.candidate(worker)
    with pytest.raises(ValueError, match='invalid_candidate_transition'):
        state.transition('parent-ws', candidate['id'], 'publication_started',
                         evidence={'event_id': 'invalid', 'record_id': worker.subtask_id})
    def attempt(index):
        try:
            state.transition('parent-ws', candidate['id'], 'review_started',
                evidence={'event_id': f'race-{index}', 'record_id': f'review-{index}'},
                expected_revision=candidate['revision'])
            return 'committed'
        except ValueError as exc:
            return str(exc)
    with ThreadPoolExecutor(max_workers=6) as pool:
        observed = list(pool.map(attempt, range(6)))
    assert observed.count('committed') == 1
    assert observed.count('coding_record_revision_conflict') == 5


@pytest.mark.parametrize('foreign_edit', [False, True])
def test_uncertain_publication_reconciles_without_replaying_writes(team, monkeypatch, foreign_edit):
    first = team.spawn()
    team.spawn('qa_agent', review=first['subtask_id'])
    original = coding_team.publish_changes
    def lost_ack(*args, **kwargs):
        observed = original(*args, **kwargs)
        assert observed['phase'] == 'integrated'
        return {**observed, 'ok': False, 'phase': 'unknown'}
    monkeypatch.setattr(coding_team, 'publish_changes', lost_ack)
    assert not subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    source = project_changes.project_path('parent-ws', 'files/data/app') / 'src/value.py'
    if foreign_edit:
        source.write_text('VALUE = "foreign edit"\n')
    def forbidden(*args, **kwargs):
        raise AssertionError('Unknown publication replayed a source write')
    monkeypatch.setattr(coding_team, 'publish_changes', forbidden)
    monkeypatch.setattr(project_changes, '_replace', forbidden)
    result = subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')
    if foreign_edit:
        assert not result['ok'] and result['phase'] == 'unknown'
        assert source.read_text() == 'VALUE = "foreign edit"\n'
    else:
        assert result['ok']


def test_missing_review_binding_blocks_publication_and_recovers_only_metadata(team, monkeypatch):
    first = team.spawn()
    original = store.change
    fail_once = [True]
    def fault(workspace, kind, identity, update, **kwargs):
        if kind == 'reviews' and fail_once[0]:
            fail_once[0] = False
            raise OSError('Simulated metadata write interruption')
        return original(workspace, kind, identity, update, **kwargs)
    monkeypatch.setattr(store, 'change', fault)
    qa = team.spawn('qa_agent', review=first['subtask_id'])
    assert qa['task_status'] == 'failed'
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    candidate = state.candidate(worker)
    assert candidate['state'] == state.CandidateState.REVIEWING
    assert not state.accepted_reviews(candidate)
    # Explicitly creating the next review repairs the interrupted record using
    # persisted stopped/cleaned resource facts; it does not restart that worker.
    next_review = team.spawn('qa_agent', review=first['subtask_id'])
    assert next_review['task_status'] == 'succeeded', next_review
    restored = store.read('parent-ws', 'reviews', state.review_id(qa['subtask_id']))
    assert restored['state'] == state.ReviewState.INTERRUPTED and restored['outcome'] == 'unknown'
    assert subagent._load_task('parent-ws', qa['subtask_id']).status == 'failed'
    assert subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']


def test_stopped_legacy_candidate_and_qa_import_exact_evidence_without_running_workers(team):
    first = team.spawn()
    qa = team.spawn('qa_agent', review=first['subtask_id'])
    assert subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    # Keep the previous version's Task.coding contract and publication journal,
    # remove only this test's new records to exercise an upgrade from v3.3.15.
    from storage.records import delete_json_record
    delete_json_record('parent-ws', ('coding-state', 'candidates', state.candidate_id(first['subtask_id']) + '.json'))
    delete_json_record('parent-ws', ('coding-state', 'reviews', state.review_id(qa['subtask_id']) + '.json'))
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    imported = state.ensure_candidate(worker)
    assert imported['state'] == state.CandidateState.INTEGRATED and imported['legacy_import']
    assert state.accepted_reviews(imported)
    assert subagent.merge_subagent_result('parent-task', worker.subtask_id, 'parent-ws')['ok']
