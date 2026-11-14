"""Audit reports built from durable task state."""
import uuid

import pytest

from agent.runtime.durable.delivery import build_audit_report


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
