"""Startup cannot steal live, foreign, unowned or unprovable workers."""
import json
import os
import socket
import subprocess
import sys
import threading
import time

import pytest

from agent.runtime.durable import subagent
from storage import subagent_store as store
from storage.records import atomic_save_json


def task_record(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    created = subagent.create_subagent_task('parent', 'lease-ws', 'session', 'research_agent', 'test')
    record = store.read_subagent('lease-ws', created['subtask_id'])
    record['status'] = 'running'
    record['started_at'] = '2020-01-01T00:00:00+00:00'
    return record


def persist(record):
    atomic_save_json('lease-ws', ('subagents', record['subtask_id'] + '.json'), record)


@pytest.mark.parametrize('case', ['fresh', 'legacy', 'malformed', 'alive_expired', 'foreign_expired', 'permission_denied'])
def test_startup_preserves_workers_without_death_evidence(monkeypatch, tmp_path, case):
    record = task_record(monkeypatch, tmp_path)
    lease = {'owner': {'host': socket.gethostname(), 'pid': os.getpid(), 'process_id': 'another-process'},
             'token': 'worker', 'heartbeat_at': time.time(), 'expires_at': time.time() + 60}
    if case != 'legacy':
        record['worker_lease'] = lease
    if case not in {'fresh', 'legacy'}:
        lease.update(heartbeat_at=1.0, expires_at=2.0)
    if case == 'malformed':
        lease['expires_at'] = float('inf')
    if case == 'foreign_expired':
        lease['owner']['host'] = 'other-host'
    if case == 'permission_denied':
        def denied(*a):
            raise PermissionError('synthetic denied probe')
        monkeypatch.setattr(store.os, 'kill', denied)
    persist(record)
    assert subagent.reconcile_subagent_tasks() == []
    current = store.read_subagent('lease-ws', record['subtask_id'])
    assert current['status'] == 'running'
    if case != 'fresh':
        assert current['observations']['worker_reconciliation']['status'] == 'pending_confirmation'
    else:
        assert current['worker_lease'] == lease


def test_expired_dead_owner_is_reclaimed_once_without_replay(monkeypatch, tmp_path):
    record = task_record(monkeypatch, tmp_path)
    record['worker_lease'] = {'owner': {'host': socket.gethostname(), 'pid': 999999, 'process_id': 'old'},
                              'token': 'worker', 'heartbeat_at': 1, 'expires_at': 2}
    persist(record)
    def absent(*a):
        raise ProcessLookupError()
    monkeypatch.setattr(store.os, 'kill', absent)
    monkeypatch.setattr(subagent, 'start_subagent_task', lambda *a: pytest.fail('replayed'))
    assert subagent.reconcile_subagent_tasks() == [record['subtask_id']]
    assert subagent.reconcile_subagent_tasks() == []
    assert store.read_subagent('lease-ws', record['subtask_id'])['status'] == 'failed'


def test_heartbeat_is_preserved_by_stale_saves_and_other_claims_are_refused(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    created = subagent.create_subagent_task('parent', 'lease-ws', 'session', 'research_agent', 'test')
    identity = created['subtask_id']
    stale = subagent._load_task('lease-ws', identity)
    monkeypatch.setattr(store, '_WORKER_HEARTBEAT_SECONDS', 0.01)
    renewed = threading.Event()
    original = store.claim_subagent_worker
    calls = []
    def claim(*args):
        token = original(*args)
        calls.append(token)
        if len(calls) >= 2:
            renewed.set()
        return token
    monkeypatch.setattr(store, 'claim_subagent_worker', claim)
    with store.subagent_worker_lease('lease-ws', identity) as lost:
        assert not lost()
        assert renewed.wait(1)
        latest = store.read_subagent('lease-ws', identity)['worker_lease']
        assert latest['owner']['pid'] == os.getpid()
        assert latest['expires_at'] > latest['heartbeat_at']
        assert not original('lease-ws', identity)  # Cannot start a second worker in this process.
        stale.status = 'running'
        subagent._save_task(stale)
        assert store.read_subagent('lease-ws', identity)['worker_lease']['token'] == latest['token']


def test_new_process_startup_does_not_fail_shared_live_worker(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    created = subagent.create_subagent_task('parent', 'lease-ws', 'session', 'research_agent', 'test')
    identity = created['subtask_id']
    token = store.claim_subagent_worker('lease-ws', identity)
    task = subagent._load_task('lease-ws', identity)
    task.status = 'running'
    task.started_at = '2020-01-01T00:00:00+00:00'
    subagent._save_task(task)
    script = '''
import json
from agent.runtime.durable.subagent import reconcile_subagent_tasks
from storage.subagent_store import read_subagent
print(json.dumps({'reconciled': reconcile_subagent_tasks(), 'status': read_subagent('lease-ws', ID)['status']}))
'''.replace('ID', repr(identity))
    result = subprocess.run([sys.executable, '-c', script], env=dict(os.environ), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {'reconciled': [], 'status': 'running'}
    assert store.read_subagent('lease-ws', identity)['worker_lease']['token'] == token


def test_legacy_running_task_cannot_be_claimed_for_replay(monkeypatch, tmp_path):
    record = task_record(monkeypatch, tmp_path)
    persist(record)
    assert not store.claim_subagent_worker('lease-ws', record['subtask_id'])


def test_startup_rechecks_lease_under_claim_lock(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    created = subagent.create_subagent_task('parent', 'lease-ws', 'session', 'research_agent', 'test')
    identity = created['subtask_id']
    token = store.claim_subagent_worker('lease-ws', identity)
    task = subagent._load_task('lease-ws', identity)
    task.status = 'running'
    subagent._save_task(task)
    stale = store.read_subagent('lease-ws', identity)
    stale['worker_lease'].update(heartbeat_at=1, expires_at=2)
    stale['worker_lease']['owner']['pid'] = 999999
    monkeypatch.setattr(store, 'list_subagents', lambda *a: [stale])
    assert subagent.reconcile_subagent_tasks() == []
    assert store.read_subagent('lease-ws', identity)['status'] == 'running'
    assert store.read_subagent('lease-ws', identity)['worker_lease']['token'] == token


def test_failed_heartbeat_sets_cancellation_probe(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    created = subagent.create_subagent_task('parent', 'lease-ws', 'session', 'research_agent', 'test')
    original, failed = store.claim_subagent_worker, threading.Event()
    def claim(*args):
        if len(args) == 3 and args[2]:
            failed.set()
            raise OSError('synthetic lease persistence failure')
        return original(*args)
    monkeypatch.setattr(store, '_WORKER_HEARTBEAT_SECONDS', 0.01)
    monkeypatch.setattr(store, 'claim_subagent_worker', claim)
    with store.subagent_worker_lease('lease-ws', created['subtask_id']) as lost:
        assert failed.wait(1)
        # The heartbeat sets lost immediately after its failed write.
        deadline = time.monotonic() + 1
        while not lost() and time.monotonic() < deadline:
            threading.Event().wait(0.001)
        assert lost()
