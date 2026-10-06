"""Cancellation stops owned execution while a worker waits for a model reply."""
import threading

import pytest

from agent.runtime.durable import subagent
from core.tools.project_execution import environment_for
from harness.test_coding_team import team as team_fixture


@pytest.fixture
def team(monkeypatch, tmp_path):
    return team_fixture.__wrapped__(monkeypatch, tmp_path)


@pytest.mark.parametrize('persisted_cancel', [False, True])
def test_cancel_closes_branch_without_waiting_for_model_reply(team, monkeypatch, persisted_cancel):
    entered, release = threading.Event(), threading.Event()

    def waiting(session, turn, **kwargs):
        entered.set()
        assert release.wait(10)
        from types import SimpleNamespace
        return SimpleNamespace(ok=True, final_response='Late model reply', tool_calls=[])

    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', waiting)
    task_id = team.spawn(background=True)['subtask_id']
    try:
        assert entered.wait(3)
        task = subagent._load_task('parent-ws', task_id)
        environment = environment_for(task.coding['branch_workspace'])
        assert environment.started and not environment.closed
        assert not subagent.cancel_subagent_task(task_id, 'another-ws')['ok']
        assert not environment.closed
        if persisted_cancel:
            task.status = 'cancelled'
            subagent._save_task(task)
        subagent.cancel_subagent_task(task_id, 'parent-ws')
        assert subagent.subagent_worker_alive('parent-ws', task_id)
        assert environment.closed and environment.cleanup_confirmed
        persisted = subagent._load_task('parent-ws', task_id)
        assert persisted.status == 'cancelled'
        assert persisted.coding['environment']['cleanup_confirmed']
        assert not subagent.merge_subagent_result('parent-task', task_id, 'parent-ws')['ok']
    finally:
        release.set()
        subagent.wait_subagent_task(task_id, 'parent-ws', timeout=3)


def test_cancel_does_not_claim_failed_resource_cleanup_succeeded(team, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def waiting(session, turn, **kwargs):
        entered.set()
        assert release.wait(10)
        from types import SimpleNamespace
        return SimpleNamespace(ok=True, final_response='Late model reply', tool_calls=[])

    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', waiting)
    task_id = team.spawn(background=True)['subtask_id']
    try:
        assert entered.wait(3)
        task = subagent._load_task('parent-ws', task_id)
        environment = environment_for(task.coding['branch_workspace'])
        close = environment.close

        def unavailable():
            environment.closed = True
            environment.cleanup_errors = ['controlled unavailable Docker']
            return False

        monkeypatch.setattr(environment, 'close', unavailable)
        cancelled = subagent.cancel_subagent_task(task_id, 'parent-ws')
        assert cancelled['ok'] and cancelled['cleanup_confirmed'] is False
        persisted = subagent._load_task('parent-ws', task_id)
        assert persisted.status == 'cancelled'
        assert persisted.coding['environment']['closed']
        assert not persisted.coding['environment']['cleanup_confirmed']
        monkeypatch.setattr(environment, 'close', close)
        reconciled = subagent.cancel_subagent_task(task_id, 'parent-ws')
        assert not reconciled['ok'] and reconciled['cleanup_confirmed']
    finally:
        release.set()
        subagent.wait_subagent_task(task_id, 'parent-ws', timeout=3)
