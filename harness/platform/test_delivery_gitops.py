# Delivery and GitOps contracts.
"""Phase 12: Delivery / GitOps / Change Closure tests."""

import uuid
import subprocess
import pytest
from agent.runtime.durable.delivery import (
    validate_delivery, requires_rollback,
    save_rollback_plan, get_rollback_plan,
    build_audit_report, git_status_check, git_commit, git_push,
    RollbackPlan,
)


class TestValidationGate:
    def test_code_mode_requires_validation(self):
        ok, missing = validate_delivery("code", {})
        assert not ok
        assert len(missing) >= 1

    def test_code_mode_passes_with_validation(self):
        ok, missing = validate_delivery("code", {
            "test_passed": True, "build_passed": True, "lint_passed": True,
        })
        assert ok
        assert len(missing) == 0

    def test_network_change_requires_rollback(self):
        ok, missing = validate_delivery("network_change", {})
        assert not ok
        assert "rollback_plan" in missing

    def test_network_change_with_all_checks_passes(self):
        ok, missing = validate_delivery("network_change", {
            "precheck": True, "authorization": True, "rollback_plan": True, "postcheck": True,
        })
        assert ok

    def test_diagnosis_requires_evidence(self):
        ok, missing = validate_delivery("diagnosis", {})
        assert not ok
        assert "evidence_collected" in missing

    def test_report_requires_artifact(self):
        ok, missing = validate_delivery("report", {})
        assert not ok
        assert "artifact_generated" in missing

    def test_destructive_modes_require_rollback(self):
        assert requires_rollback("network_change")
        assert requires_rollback("code")
        assert not requires_rollback("report")


class TestRollbackPlan:
    def test_save_and_load(self):
        ws = f"ws_rb_{uuid.uuid4().hex[:8]}"
        plan = RollbackPlan(
            task_id="t1", workspace_id=ws,
            strategy="Rollback to snapshot", steps=["restore artifact"],
            risk="medium",
        )
        save_rollback_plan(plan)
        loaded = get_rollback_plan(ws, plan.rollback_id)
        assert loaded is not None
        assert loaded["strategy"] == "Rollback to snapshot"

    def test_rollback_plan_binds_workspace(self):
        ws_a = f"ws_rba_{uuid.uuid4().hex[:8]}"
        ws_b = f"ws_rbb_{uuid.uuid4().hex[:8]}"
        plan = RollbackPlan(task_id="t1", workspace_id=ws_a)
        save_rollback_plan(plan)
        assert get_rollback_plan(ws_b, plan.rollback_id) is None


class TestAuditReport:
    @pytest.mark.parametrize('status', ['failed', 'succeeded', 'verified'])
    def test_markdown_renders_structured_diagnostics(self, status):
        from agent.runtime.durable.delivery import export_audit_report_markdown
        from agent.runtime.durable.store import save_task, append_event
        from agent.runtime.durable.models import TaskState, RuntimeEvent
        ws = f'ws_ar_{uuid.uuid4().hex[:8]}'
        task = TaskState.new(workspace_id=ws, session_id='s1')
        task.update_status('succeeded' if status == 'verified' else status)
        save_task(task)
        if status == 'verified':
            append_event(RuntimeEvent(event_id='validation1', task_id=task.task_id,
                                      workspace_id=ws, session_id=task.session_id,
                                      run_id=task.run_id, type='validation_completed'))
        text = export_audit_report_markdown(task.task_id, ws)
        if status == 'verified':
            assert 'Status: succeeded' in text and 'Issues:\nnone' in text
            assert 'Score: 10/10' in text
            return
        assert f'Status: {status}' in text
        rule = 'task_failed' if status == 'failed' else 'unverified_completion'
        assert rule in text
        assert ('Task did not succeed' if status == 'failed' else 'no verification') in text

    def test_markdown_missing_task_is_explicit(self):
        from agent.runtime.durable.delivery import export_audit_report_markdown
        text = export_audit_report_markdown('missing', 'ws_x')
        assert 'Status: not_found' in text
        assert 'Score: N/A' in text

    def test_build_report(self):
        from agent.runtime.durable.store import save_task
        from agent.runtime.durable.models import TaskState
        ws = f"ws_ar_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1", user_goal="test audit")
        task.update_status("succeeded"); save_task(task)

        report = build_audit_report(task.task_id, ws)
        assert report["task_id"] == task.task_id
        meta = report.get("task_metadata", {})
        assert meta.get("status") == "succeeded"

class TestGitOps:
    @pytest.mark.parametrize('operation', ['status', 'commit', 'push'])
    def test_every_git_process_receives_only_allowed_environment(self, monkeypatch, tmp_path, operation):
        from agent.runtime.durable import delivery
        monkeypatch.setattr('storage.paths.workspace_root', lambda _: tmp_path)
        for name in ['LZCORE_TEST_SECRET', 'OPENAI_API_KEY', 'CUSTOM_TOKEN', 'DATABASE_URL', 'GIT_TEST_PASSWORD']:
            monkeypatch.setenv(name, 'synthetic-value')
        for name, value in {'HOME': str(tmp_path), 'GIT_AUTHOR_NAME': 'Test',
                            'SSH_AUTH_SOCK': '/tmp/synthetic-agent', 'LC_ALL': 'C'}.items():
            monkeypatch.setenv(name, value)
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            stdout = str(tmp_path) if args[1:3] == ['rev-parse', '--show-toplevel'] else (
                'main' if args[1] == 'rev-parse' else 'origin' if args[1] == 'remote' else '')
            return subprocess.CompletedProcess(args, 0, stdout, '')
        monkeypatch.setattr(subprocess, 'run', run)
        monkeypatch.setattr('storage.events.publish', lambda *a: None)
        result = (delivery.git_status_check('ws_x') if operation == 'status' else
                  delivery.git_commit('ws_x', 'test', confirm=True) if operation == 'commit' else
                  delivery.git_push('ws_x', confirm=True))
        assert result['ok'], result
        assert len(calls) >= 3
        for args, kwargs in calls:
            env = kwargs['env']
            assert not {'LZCORE_TEST_SECRET', 'OPENAI_API_KEY', 'CUSTOM_TOKEN',
                        'DATABASE_URL', 'GIT_TEST_PASSWORD'} & env.keys()
            assert env['HOME'] == str(tmp_path)
            assert env['SSH_AUTH_SOCK'] == '/tmp/synthetic-agent'
            assert env['GIT_AUTHOR_NAME'] == 'Test' and env['LC_ALL'] == 'C'
            if args[1] == 'push':
                assert env['GIT_TERMINAL_PROMPT'] == '0'

    def test_commit_no_confirm_rejected(self):
        result = git_commit("ws_x", "fix bug", confirm=False)
        assert result["ok"] is False

    def test_push_no_confirm_rejected(self):
        result = git_push("ws_x", confirm=False)
        assert result["ok"] is False

    def test_commit_no_message_rejected(self):
        result = git_commit("ws_x", "", confirm=True)
        assert result["ok"] is False

    def test_git_status_missing_workspace_rejected(self, monkeypatch, tmp_path):
        monkeypatch.setattr("storage.paths.workspace_root", lambda _: tmp_path / "missing")
        result = git_status_check("ws_x")
        assert result["ok"] is False
        assert result["error"]
