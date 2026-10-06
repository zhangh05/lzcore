"""Unknown execution can be reconciled explicitly without rewriting its evidence."""
from copy import deepcopy
from dataclasses import asdict
import subprocess

import pytest

from harness.test_coding_team import team as team
from agent.runtime.durable import coding_state as state, subagent
from core.tools.context import ToolRuntimeContext
from core.tools.project_execution import DockerProjectEnvironment, reconcile_environment
from storage import coding_state_store as store
from storage.project_changes import project_path
from storage.records import atomic_save_json, delete_json_record
from scripts.benchmark_team_acceptance import verify_team


def unknown_check(*args, **kwargs):
    return {'ok': False, 'execution_outcome': 'unknown', 'execution_may_continue': True}


def reconcile(team, identity, context=None):
    return team.client.invoke('agent.manage', {'action': 'reconcile', 'subtask_id': identity}, context=context or team.parent)


@pytest.mark.parametrize('producer_unknown', [False, True])
def test_reconcile_then_fresh_qa_integrates_without_replaying_or_erasing_unknown(team, monkeypatch, producer_unknown):
    execute = DockerProjectEnvironment.execute
    if producer_unknown:
        monkeypatch.setattr(DockerProjectEnvironment, 'execute', unknown_check)
    first = team.spawn()
    if not producer_unknown:
        monkeypatch.setattr(DockerProjectEnvironment, 'execute', unknown_check)
        previous = team.spawn('qa_agent', review=first['subtask_id'])
        old_review = store.read('parent-ws', 'reviews', state.review_id(previous['subtask_id']))
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    before = state.candidate(producer)
    assert before['state'] == 'execution_unknown'
    with monkeypatch.context() as patch:
        def no_execute(*a, **kw):
            raise AssertionError('reconciliation executed or replayed a tool')
        patch.setattr(DockerProjectEnvironment, 'execute', no_execute)
        patch.setattr(DockerProjectEnvironment, 'start', no_execute)
        patch.setattr(DockerProjectEnvironment, 'close', no_execute)
        result = reconcile(team, first['subtask_id'])
        assert result.status == 'succeeded' and result.output['requires_new_review'], result.output
    after = state.candidate(producer)
    assert after['state'] == 'review_incomplete'
    assert after['validation'] == before['validation'] and after['resources'] == before['resources']
    assert not subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    monkeypatch.setattr(DockerProjectEnvironment, 'execute', execute)
    current = team.spawn('qa_agent', review=first['subtask_id'])
    assert current['task_status'] == 'succeeded', current
    assert subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    assert verify_team('parent-ws', 'parent-session', 'files/data/app')['status'] == 'PASS'
    if not producer_unknown:
        assert store.read('parent-ws', 'reviews', old_review['id']) == old_review
    assert reconcile(team, first['subtask_id']).output['reconciled'] is False


@pytest.mark.parametrize('obstacle', ['running', 'changed_source', 'scope', 'unresolved_resource'])
def test_reconciliation_does_not_override_live_foreign_or_changed_evidence(team, monkeypatch, obstacle):
    first = team.spawn()
    monkeypatch.setattr(DockerProjectEnvironment, 'execute', unknown_check)
    failed = team.spawn('qa_agent', review=first['subtask_id'])
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    before = state.candidate(producer)
    context = None
    if obstacle == 'running':
        worker = subagent._load_task('parent-ws', failed['subtask_id'])
        worker.status = 'running'
        atomic_save_json('parent-ws', ('subagents', worker.subtask_id + '.json'), asdict(worker))
    elif obstacle == 'changed_source':
        project_path(before['branch_workspace'], before['project_dir']).joinpath('src/value.py').write_text('VALUE = 99\n')
    elif obstacle == 'scope':
        context = ToolRuntimeContext(workspace_id='parent-ws', session_id='parent-session', task_id='other-parent', requested_by='turn_runner')
    else:
        monkeypatch.setattr('core.tools.project_execution.reconcile_environment', lambda *a: (_ for _ in ()).throw(ValueError('unresolved')))
    result = reconcile(team, first['subtask_id'], context)
    assert result.status != 'succeeded' or not result.output.get('ok'), result.output
    assert state.candidate(producer) == before


def test_second_unknown_review_requires_another_explicit_reconciliation(team, monkeypatch):
    first = team.spawn()
    monkeypatch.setattr(DockerProjectEnvironment, 'execute', unknown_check)
    team.spawn('qa_agent', review=first['subtask_id'])
    assert reconcile(team, first['subtask_id']).output['ok']
    second = team.spawn('qa_agent', review=first['subtask_id'])
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    current = state.candidate(producer)
    assert current['state'] == 'execution_unknown'
    assert state.review_id(second['subtask_id']) not in current['execution_recovery']['resolved_review_ids']
    assert not state.accepted_reviews(current)


@pytest.mark.parametrize('mode', ['absent', 'live', 'daemon_changed', 'unavailable'])
def test_restart_readback_uses_original_daemon_and_inspect_only(monkeypatch, mode):
    name = 'lzcore-project-' + '1' * 32
    descriptor = {'closed': True, 'cleanup_confirmed': False, 'daemon_id': 'original-daemon',
                  'runtime_resources': {'project': name, 'broker': name+'-packages', 'network': name+'-network'}}
    calls = []
    monkeypatch.setenv('LZCORE_CODING_DOCKER_COMMAND', '["docker"]')
    def run(args, **kwargs):
        calls.append(args)
        if args[1] == 'info':
            return subprocess.CompletedProcess(args, 0, 'other-daemon' if mode == 'daemon_changed' else 'original-daemon', '')
        assert args[2] == 'inspect'
        if mode == 'live':
            return subprocess.CompletedProcess(args, 0, '[{"State":{"Running":true}}]', '')
        if mode == 'unavailable':
            return subprocess.CompletedProcess(args, 1, '', 'Cannot connect to Docker daemon')
        missing = 'No such container: '+args[3] if args[1] == 'container' else 'network '+args[3]+' not found'
        return subprocess.CompletedProcess(args, 1, '[]\n', 'Error response from daemon: '+missing)
    monkeypatch.setattr('core.tools.project_execution.subprocess.run', run)
    if mode == 'absent':
        result = reconcile_environment(descriptor)
        assert result['cleanup_confirmed'] and result['observed_via'] == 'docker_readback'
        assert len(calls) == 4
    else:
        with pytest.raises(ValueError):
            reconcile_environment(descriptor)
    assert all(args[1] == 'info' or args[2] == 'inspect' for args in calls)


def test_missing_new_candidate_is_not_recreated_from_task_projection(team):
    first = team.spawn()
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    delete_json_record('parent-ws', ('coding-state', 'candidates', state.candidate_id(first['subtask_id'])+'.json'))
    assert state.candidate(producer) is None
    assert not subagent.merge_subagent_result('parent-task',producer.subtask_id,'parent-ws')['ok']
    assert state.candidate(producer) is None


def test_task_check_cache_cannot_fill_missing_review_evidence(team, monkeypatch):
    first = team.spawn()
    reviewed = team.spawn('qa_agent', review=first['subtask_id'])
    qa = subagent._load_task('parent-ws', reviewed['subtask_id'])
    record = state.review(qa)
    # Exercise a still-running review with no check evidence. The Task cache
    # deliberately contains a fabricated PASS; only new actual checks may fill it.
    from harness.coding_record_fixtures import corrupt_record
    corrupt_record('parent-ws', 'reviews', record['id'], lambda r: r.update(state='running', validation={}))
    qa.status = 'running'
    qa.coding['qa_validation'] = deepcopy(record['validation'])
    atomic_save_json('parent-ws', ('subagents', qa.subtask_id+'.json'), asdict(qa))
    monkeypatch.setattr('core.tools.integration.get_default_tool_runtime_client', lambda: type('Client', (), {
        'invoke': lambda *a, **kw: type('Result', (), {'status':'failed', 'output':{'ok':False,'exit_code':1}})()})())
    from agent.runtime.durable.coding_reviews import check_qa
    assert check_qa(qa)['status'] == 'failed'
    assert state.review(qa)['validation']['status'] == 'failed'


def test_disposable_validation_resources_are_read_back_before_recovery(team, monkeypatch):
    execute = DockerProjectEnvironment.execute
    name = 'lzcore-project-' + '2' * 32
    descriptor = {'closed': True, 'cleanup_confirmed': False, 'daemon_id': 'test-daemon',
                  'runtime_resources': {'project': name, 'broker': name+'-packages', 'network': name+'-network'}}
    def unknown_stage(*a, **kw):
        return {**unknown_check(), 'validation_environment': descriptor}
    monkeypatch.setattr(DockerProjectEnvironment, 'execute', unknown_stage)
    first = team.spawn()
    calls = []
    def readback(args, **kwargs):
        calls.append(args)
        if args[1] == 'info':
            return subprocess.CompletedProcess(args, 0, 'test-daemon', '')
        missing = ('No such container: '+args[3]) if args[1] == 'container' else ('network '+args[3]+' not found')
        return subprocess.CompletedProcess(args, 1, '[]\n', 'Error response from daemon: '+missing)
    with monkeypatch.context() as patch:
        patch.setattr('core.tools.project_execution.subprocess.run', readback)
        assert reconcile(team, first['subtask_id']).output['ok']
    assert len(calls) == 4 and all(args[1] == 'info' or args[2] == 'inspect' for args in calls)
    monkeypatch.setattr(DockerProjectEnvironment, 'execute', execute)
    assert team.spawn('qa_agent', review=first['subtask_id'])['task_status'] == 'succeeded'
    assert subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    assert verify_team('parent-ws', 'parent-session', 'files/data/app')['status'] == 'PASS'
    # Independent acceptance checks the original descriptor, not a free PASS flag.
    from harness.coding_record_fixtures import corrupt_record
    identity = state.candidate_id(first['subtask_id'])
    corrupt_record('parent-ws', 'candidates', identity, lambda r:
        r['execution_recovery']['observations'][0]['checks'][0]['resources'].update(daemon_id='forged'))
    with pytest.raises(AssertionError):
        verify_team('parent-ws', 'parent-session', 'files/data/app')


def test_stopped_unsealed_candidate_is_sealed_only_after_explicit_resource_readback(team, monkeypatch):
    first = team.spawn()
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    before = state.candidate(producer)
    from harness.coding_record_fixtures import corrupt_record
    corrupt_record('parent-ws', 'candidates', before['id'], lambda r:r.update(state='building', source_digest='', validation={}))
    producer.status = 'failed'
    atomic_save_json('parent-ws', ('subagents', producer.subtask_id + '.json'), asdict(producer))
    with monkeypatch.context() as patch:
        def forbidden(*a, **kw):
            raise AssertionError('Interrupted candidate recovery must not execute or restart')
        patch.setattr(DockerProjectEnvironment, 'execute', forbidden)
        patch.setattr(DockerProjectEnvironment, 'start', forbidden)
        patch.setattr(DockerProjectEnvironment, 'close', forbidden)
        result = reconcile(team, producer.subtask_id)
        assert result.status == 'succeeded' and result.output['requires_new_review'], result.output
    after = state.candidate(producer)
    assert after['state'] == 'review_incomplete' and after['source_digest'] == before['source_digest']
    assert after['validation'] == {} and not state.accepted_reviews(after)
    assert not subagent.merge_subagent_result('parent-task', producer.subtask_id, 'parent-ws')['ok']
    assert team.spawn('qa_agent', review=producer.subtask_id)['task_status'] == 'succeeded'
    assert subagent.merge_subagent_result('parent-task', producer.subtask_id, 'parent-ws')['ok']
    assert verify_team('parent-ws', 'parent-session', 'files/data/app')['status'] == 'PASS'


def test_unsealed_candidate_readback_cannot_interrupt_active_worker(team):
    first = team.spawn()
    producer = subagent._load_task('parent-ws', first['subtask_id'])
    from harness.coding_record_fixtures import corrupt_record
    corrupt_record('parent-ws', 'candidates', state.candidate_id(producer.subtask_id),
                   lambda r:r.update(state='building', source_digest=''))
    producer.status = 'running'
    atomic_save_json('parent-ws', ('subagents', producer.subtask_id + '.json'), asdict(producer))
    before = state.candidate(producer)
    result = reconcile(team, producer.subtask_id)
    assert result.status != 'succeeded' and 'not_stopped' in str(result.output)
    assert state.candidate(producer) == before
