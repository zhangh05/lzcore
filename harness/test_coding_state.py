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
    state.start_review(peer1, state.candidate(producer), baseline=prior["baseline"], resources=prior["resources"])
    state.start_review(peer2, state.candidate(producer), baseline=prior["baseline"], resources=prior["resources"])
    state.record_judgement(peer1, {**prior['judgement'], 'verdict': 'fail', 'blocking_findings': ['failure']})
    state.record_judgement(peer2, prior['judgement'])
    state.record_review_validation(peer1, prior['validation'])
    state.finish_review(peer1, resources=prior['resources'])
    assert state.candidate(producer)['state'] == state.CandidateState.REVIEWING
    state.record_review_validation(peer2, prior['validation'])
    state.finish_review(peer2, resources=prior['resources'])
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
    from copy import deepcopy
    from storage.records import delete_json_record
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    reviewer = subagent._load_task('parent-ws', qa['subtask_id'])
    proposal, evidence = state.candidate(producer), state.review(reviewer)
    producer.coding.update(schema='coding.assignment.v1', phase='integrated',
        baseline=deepcopy(proposal['baseline']), change=deepcopy(proposal['change']),
        candidate_digest=proposal['source_digest'], completion_validation=deepcopy(proposal['validation']),
        environment=deepcopy(proposal['resources']), qa_subtask_id=reviewer.subtask_id)
    reviewer.coding.update(schema='coding.assignment.v1', baseline=deepcopy(evidence['baseline']),
        review_digest=evidence['change_digest'], review_candidate_digest=evidence['candidate_digest'],
        qa_review=deepcopy(evidence['judgement']), qa_validation=deepcopy(evidence['validation']),
        environment=deepcopy(evidence['resources']), qa_final_report=evidence['final_report'])
    for task in (producer, reviewer):
        atomic_save_json('parent-ws', ('subagents', task.subtask_id + '.json'), asdict(task))
    delete_json_record('parent-ws', ('coding-state', 'candidates', proposal['id'] + '.json'))
    delete_json_record('parent-ws', ('coding-state', 'reviews', evidence['id'] + '.json'))
    from agent.runtime.durable.coding_migration import migrate_workspace
    assert len(migrate_workspace('parent-ws')) == 2
    imported = state.candidate(producer)
    assert imported['state'] == state.CandidateState.INTEGRATED and imported['legacy_import']
    assert state.accepted_reviews(imported)
    assert subagent.merge_subagent_result('parent-task', producer.subtask_id, 'parent-ws')['ok']
    from storage.subagent_store import read_subagent
    from agent.runtime.durable.coding_assignment import FIELDS
    assert all(set(read_subagent('parent-ws', task.subtask_id)['coding']) <= FIELDS for task in (producer, reviewer))
    assert migrate_workspace('parent-ws') == []


def test_live_and_terminal_tasks_never_persist_domain_mirrors(team, monkeypatch):
    import threading
    from types import SimpleNamespace
    from storage.subagent_store import read_subagent
    from agent.runtime.durable.coding_assignment import FIELDS
    entered, release = threading.Event(), threading.Event()
    def runtime(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return SimpleNamespace(ok=True, final_response='Stopped without source', tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', runtime)
    first = team.spawn(background=True)
    try:
        assert entered.wait(2)
        worker = subagent._load_task('parent-ws', first['subtask_id'])
        assert state.candidate(worker)['state'] == state.CandidateState.BUILDING
        assert state.candidate(worker)['resources']
        worker.coding.update(phase='validated', qa_review={'verdict': 'pass'}, publication={'ok': True},
                            baseline={'forged': True}, completion_validation={'status': 'passed'})
        subagent._save_task(worker)
        raw = read_subagent('parent-ws', worker.subtask_id)
        assert set(raw['coding']) <= FIELDS and raw['coding']['schema'] == 'coding.assignment.v2'
        assert not state.candidate(worker)['validation']
        assert not subagent.merge_subagent_result('parent-task', worker.subtask_id, 'parent-ws')['ok']
    finally:
        release.set()
        subagent.wait_subagent_task(first['subtask_id'], 'parent-ws', timeout=3)
    assert set(read_subagent('parent-ws', first['subtask_id'])['coding']) <= FIELDS


def test_startup_migrates_task_mirrors_without_mutating_existing_store(team):
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    proposal = state.candidate(worker)
    worker.coding.update(schema='coding.assignment.v1', phase='integrated', candidate_digest='forged',
                        qa_review={'verdict': 'pass'}, publication={'ok': True}, state_store_version=2)
    atomic_save_json('parent-ws', ('subagents', worker.subtask_id + '.json'), asdict(worker))
    subagent.reconcile_subagent_tasks()
    assert state.candidate(worker) == proposal
    from storage.subagent_store import read_subagent
    from agent.runtime.durable.coding_assignment import FIELDS
    assert set(read_subagent('parent-ws', worker.subtask_id)['coding']) <= FIELDS
    assert not subagent.merge_subagent_result('parent-task', worker.subtask_id, 'parent-ws')['ok']


def test_legacy_unknown_migration_preserves_observations_without_replaying(team, monkeypatch):
    from copy import deepcopy
    from storage.records import delete_json_record
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    proposal = state.candidate(worker)
    unknown = {**deepcopy(proposal['validation']), 'status': 'unknown', 'automatic_retry_allowed': False}
    worker.coding.update(schema='coding.assignment.v1', phase='validated', baseline=proposal['baseline'],
                        completion_validation=unknown, environment=proposal['resources'])
    atomic_save_json('parent-ws', ('subagents', worker.subtask_id + '.json'), asdict(worker))
    delete_json_record('parent-ws', ('coding-state', 'candidates', proposal['id'] + '.json'))
    def forbidden(*args, **kwargs):
        raise AssertionError('Migration cannot execute application commands')
    monkeypatch.setattr('core.tools.project_execution.DockerProjectEnvironment.execute', forbidden)
    from agent.runtime.durable.coding_migration import migrate_workspace
    migrate_workspace('parent-ws')
    migrated = state.candidate(worker)
    assert migrated['state'] == state.CandidateState.EXECUTION_UNKNOWN and migrated['validation'] == unknown
    assert not state.accepted_reviews(migrated)
    assert migrate_workspace('parent-ws') == []


def test_upgrade_does_not_recreate_lost_new_store_records(team):
    from storage.records import delete_json_record
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    proposal = state.candidate(worker)
    worker.coding.update(schema='coding.assignment.v1', state_store_version=2,
                        baseline=proposal['baseline'], candidate_digest=proposal['source_digest'],
                        completion_validation=proposal['validation'], environment=proposal['resources'])
    atomic_save_json('parent-ws', ('subagents', worker.subtask_id + '.json'), asdict(worker))
    delete_json_record('parent-ws', ('coding-state', 'candidates', proposal['id'] + '.json'))
    from agent.runtime.durable.coding_migration import migrate_workspace
    with pytest.raises(ValueError, match='coding_candidate_unavailable'):
        migrate_workspace('parent-ws')
    assert state.candidate(worker) is None


def test_missing_review_binding_uses_confirmed_readback_for_cleanup_not_task_cache(team, monkeypatch):
    first = team.spawn()
    original = store.change
    fail_once = [True]
    def fault(workspace, kind, identity, update, **kwargs):
        if kind == 'reviews' and fail_once[0]:
            fail_once[0] = False
            raise OSError('Interrupted review creation')
        return original(workspace, kind, identity, update, **kwargs)
    monkeypatch.setattr(store, 'change', fault)
    failed = team.spawn('qa_agent', review=first['subtask_id'])
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    target = state.candidate(producer)
    from harness.coding_record_fixtures import corrupt_record
    def lost_cleanup_ack(record):
        for event in record['events']:
            if event['event'] == 'review_creation_cleanup':
                event['evidence']['resources']['cleanup_confirmed'] = False
    corrupt_record('parent-ws', 'candidates', target['id'], lost_cleanup_ack)
    readbacks = []
    def confirmed(resources):
        readbacks.append(resources)
        return {**resources, 'closed': True, 'cleanup_confirmed': True, 'observed_via': 'docker_readback'}
    monkeypatch.setattr('core.tools.project_execution.reconcile_environment', confirmed)
    state.recover_review_links('parent-ws', target['id'])
    restored = store.read('parent-ws', 'reviews', state.review_id(failed['subtask_id']))
    assert readbacks and not readbacks[0]['cleanup_confirmed']
    assert restored['resources']['closed'] and restored['resources']['cleanup_confirmed']
    assert restored['judgement'] is None and restored['validation'] == {} and restored['outcome'] == 'unknown'
    assert not state.accepted_reviews(state.candidate(producer))
