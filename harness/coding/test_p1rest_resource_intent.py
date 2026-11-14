"""Allocation intent is persisted before resources can outlive the process."""
import json
import subprocess
from types import SimpleNamespace

import pytest

from core.tools import project_execution as execution
from agent.runtime.durable import coding_recovery, coding_team
from harness.coding.test_project_execution import environment


def test_exact_owner_names_and_daemon_persist_before_first_allocation(environment, monkeypatch):  # noqa: F811 (pytest fixture)
    owner = {'workspace_id': 'parent', 'session_id': 'session', 'parent_task_id': 'task', 'subtask_id': 'sub-12345678'}
    environment.resource_owner = owner
    observed = []
    def docker(*args, **kwargs):
        if args[0] == 'info':
            return subprocess.CompletedProcess(args, 0, 'test-daemon', '')
        if args[:2] == ('image', 'inspect'):
            return subprocess.CompletedProcess(args, 0, 'sha256:' + '1' * 64, '')
        record = execution.read_execution_intent('isolated', owner)
        assert record['resources']['daemon_id'] == 'test-daemon'
        assert record['resources']['runtime_resources'] == environment.descriptor()['runtime_resources']
        observed.append(args)
        # Simulate process loss, bypassing Python's ordinary exception cleanup.
        raise SystemExit('simulated process loss')
    monkeypatch.setattr(environment, '_docker', docker)
    with pytest.raises(SystemExit):
        environment.start()
    record = execution.read_execution_intent('isolated', owner)
    assert record['phase'] == 'allocating' and not record['resources']['cleanup_confirmed']
    assert observed == [('network', 'create', '--internal', environment.network)]
    with pytest.raises(ValueError, match='identity_mismatch'):
        execution.read_execution_intent('isolated', {**owner, 'subtask_id': 'sub-00000000'})


def test_intent_write_failure_performs_no_external_creation_or_deletion(environment, monkeypatch):  # noqa: F811 (pytest fixture)
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        if args[0] == 'info':
            return subprocess.CompletedProcess(args, 0, 'test-daemon', '')
        return subprocess.CompletedProcess(args, 0, 'sha256:' + '1' * 64, '')
    monkeypatch.setattr(environment, '_docker', docker)
    def fail(*a):
        raise OSError('synthetic intent persistence failure')
    monkeypatch.setattr('storage.atomic_io.atomic_write_json', fail)
    with pytest.raises(OSError):
        environment.start()
    assert all(call[0] in {'info', 'image'} for call in calls)


@pytest.mark.parametrize('unresolved', [False, True])
def test_orphan_before_candidate_uses_exact_intent_readback(environment, monkeypatch, unresolved):  # noqa: F811 (pytest fixture)
    task = SimpleNamespace(workspace_id='parent', session_id='session', parent_task_id='task', subtask_id='sub-12345678',
                           profile_id='coding_agent', status='failed', coding={'branch_workspace': 'isolated'}, observations={})
    environment.resource_owner = coding_team.execution_owner(task)
    environment.daemon_id = 'test-daemon'
    environment._record_resources('allocating')
    monkeypatch.setattr('agent.runtime.durable.coding_state.candidate', lambda _: None)
    monkeypatch.setattr('agent.runtime.durable.subagent._save_task', lambda _: None)
    def inspect(descriptor):
        assert descriptor['runtime_resources']['project'] == environment.name
        if unresolved:
            raise ValueError('resources unresolved')
        return {'cleanup_confirmed': True, 'closed': True}
    monkeypatch.setattr(execution, 'reconcile_environment', inspect)
    monkeypatch.setattr(environment, '_docker', lambda *a, **kw: pytest.fail('resource replay or deletion'))
    result = coding_recovery.reconcile_execution(task)
    assert result['ok'] == (not unresolved)
    assert result['state'] == ('unknown' if unresolved else 'interrupted')
    assert not result['automatic_retry_allowed']
