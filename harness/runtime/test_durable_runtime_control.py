# Durable checkpoint, cancel, retry, and resume contracts.
"""Phase 3: Runtime control — checkpoint, cancel, retry, resume."""

import uuid
import pytest
from agent.runtime.durable.models import (
    TaskState, RuntimeStep,
)
from agent.runtime.durable.control import (
    checkpoint_task, cancel_task, retry_step, resume_task,
)
from agent.runtime.durable.store import (
    save_task, get_task, get_events, get_checkpoints,
)


@pytest.mark.parametrize('operation', ['cancel', 'resume', 'retry'])
def test_control_api_reports_unsupported_and_preserves_the_record(operation):
    from flask import Flask
    from backend.api.state_routes import register_state_routes

    app = Flask(__name__)
    register_state_routes(app)
    ws = f'ws_api_{uuid.uuid4().hex[:8]}'
    task = TaskState.new(workspace_id=ws, session_id='s1')
    task.add_step(RuntimeStep(step_id='step1', task_id=task.task_id,
                              kind='model', status='failed'))
    task.update_status('running' if operation == 'cancel' else 'failed')
    save_task(task)
    checkpoint_task(task.task_id, ws)
    before = get_task(ws, task.task_id).to_dict()
    events = get_events(ws, task.task_id)
    checkpoints = get_checkpoints(ws, task.task_id)
    suffix = 'steps/step1/retry' if operation == 'retry' else operation
    response = app.test_client().post(f'/api/runtime/tasks/{task.task_id}/{suffix}?workspace_id={ws}')
    assert response.status_code == 400
    assert response.json['ok'] is False and response.json['status'] == 'unsupported'
    assert response.json[f'{operation}_not_supported'] is True
    assert get_task(ws, task.task_id).to_dict() == before
    assert get_events(ws, task.task_id) == events
    assert get_checkpoints(ws, task.task_id) == checkpoints


class TestCheckpoint:
    """Checkpoint at critical execution points."""

    def test_checkpoint_after_task_start(self):
        ws = f"ws_cp_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1", run_id="r1")
        task.update_status("running"); save_task(task)

        cp = checkpoint_task(task.task_id, ws, reason="task_started")
        assert cp is not None
        assert cp.task_id == task.task_id
        assert cp.workspace_id == ws

        cps = get_checkpoints(ws, task.task_id)
        assert len(cps) >= 1
        assert cps[-1]["checkpoint_id"] == cp.checkpoint_id

    def test_checkpoint_before_tool(self):
        ws = f"ws_cpt_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s-tool", task_id=task.task_id,
                                   kind="tool", title="Run command"))
        task.update_status("running"); save_task(task)

        cp = checkpoint_task(task.task_id, ws, reason="tool_start",
                             step_id="s-tool")
        assert cp is not None
        loaded = get_checkpoints(ws, task.task_id)
        assert loaded[-1]["step_id"] == "s-tool"

    def test_checkpoint_on_failed_task(self):
        ws = f"ws_cpf_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("failed")
        task.errors.append("connection refused"); save_task(task)

        cp = checkpoint_task(task.task_id, ws, reason="failure")
        assert cp is not None
        events = get_events(ws, task.task_id)
        assert any(e["type"] == "checkpoint_created" for e in events)

    def test_checkpoint_payload_no_secrets(self):
        ws = f"ws_cps_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("running"); save_task(task)

        # Use a pending_action with secret keys (these get redacted)
        from agent.runtime.durable.control import checkpoint_task as cp_with_action
        cp = cp_with_action(task.task_id, ws,
                           pending_action={"tool": "exec.run", "api_key": "sk-secret", "cmd": "ls"})
        # pending_action.api_key should be redacted in stored payload
        pa = cp.pending_action
        assert pa is not None
        assert pa.get("api_key") in (None, "[REDACTED]")
        assert pa.get("cmd") == "ls"


class TestCancel:
    """Cancel semantics."""

    def test_cancel_running_task_is_unsupported_without_executor(self):
        ws = f"ws_can_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s1", task_id=task.task_id,
                                   kind="model", status="running"))
        task.current_step_id = "s1"
        task.update_status("running"); save_task(task)

        result = cancel_task(task.task_id, ws)
        assert result["ok"] is False
        assert result["status"] == "unsupported"
        assert result["cancel_not_supported"] is True
        loaded = get_task(ws, task.task_id)
        assert loaded.to_dict() == task.to_dict()
        assert not get_checkpoints(ws, task.task_id)

    def test_unsupported_cancel_does_not_claim_execution_was_stopped(self):
        ws = f"ws_cev_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("running"); save_task(task)

        cancel_task(task.task_id, ws)
        events = get_events(ws, task.task_id)
        assert not events

    def test_cancel_idempotent(self):
        ws = f"ws_cid_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("succeeded"); save_task(task)

        r1 = cancel_task(task.task_id, ws)  # already succeeded
        r2 = cancel_task(task.task_id, ws)  # repeat
        assert r1["ok"] is True
        assert r1["status"] == "succeeded"
        assert r2["ok"] is True

    def test_cross_workspace_cancel_rejected(self):
        ws_a = f"ws_ca_{uuid.uuid4().hex[:8]}"
        ws_b = f"ws_cb_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws_a, session_id="s1")
        save_task(task)

        result = cancel_task(task.task_id, ws_b)
        assert result["ok"] is False


class TestRetry:
    """Retry step safety."""

    def test_retry_readonly_step_is_unsupported_without_executor(self):
        ws = f"ws_rr_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s-read", task_id=task.task_id,
                                   kind="model", status="failed",
                                   title="Search web"))
        save_task(task)

        result = retry_step(task.task_id, "s-read", ws)
        assert result["ok"] is False
        assert result["status"] == "unsupported"
        assert result["retry_not_supported"] is True

    def test_retry_destructive_step_denied(self):
        ws = f"ws_rd_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s-rm", task_id=task.task_id,
                                   kind="tool", status="failed",
                                   tool_id="exec.run",
                                   title="Remove files",
                                   summary="rm -rf /tmp/test"))
        save_task(task)

        result = retry_step(task.task_id, "s-rm", ws)
        assert result["ok"] is False
        assert result.get("retry_not_supported") is True

    def test_retry_merged_tool_is_denied_without_persisted_action(self):
        ws = f"ws_rma_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        # The manifest says safe_to_retry, but this tool also has an import
        # action. RuntimeStep intentionally does not persist arguments.
        task.add_step(RuntimeStep(step_id="s-import", task_id=task.task_id,
                                  kind="tool", status="failed",
                                  tool_id="workspace.filestore",
                                  title="Import file"))
        save_task(task)

        result = retry_step(task.task_id, "s-import", ws)
        assert result["ok"] is False
        assert result.get("retry_not_supported") is True

    def test_unsupported_retry_preserves_attempts_status_and_events(self):
        ws = f"ws_ra_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s-model", task_id=task.task_id,
                                   kind="model", status="failed"))
        save_task(task)

        result = retry_step(task.task_id, "s-model", ws)
        loaded = get_task(ws, task.task_id)
        assert result["ok"] is False and result["status"] == "unsupported"
        assert loaded.to_dict() == task.to_dict()
        assert not get_events(ws, task.task_id)

    def test_retry_can_only_retry_failed(self):
        ws = f"ws_rf_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.add_step(RuntimeStep(step_id="s-ok", task_id=task.task_id,
                                   kind="model", status="succeeded"))
        save_task(task)

        result = retry_step(task.task_id, "s-ok", ws)
        assert result["ok"] is False


class TestResume:
    """Resume from checkpoint."""

    def test_resume_no_checkpoint_returns_error(self):
        ws = f"ws_rnc_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("interrupted"); save_task(task)

        result = resume_task(task.task_id, ws)
        assert result["ok"] is False
        assert result.get("resume_not_supported") is True

    def test_resume_from_checkpoint(self):
        ws = f"ws_res_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1", run_id="r1")
        task.add_step(RuntimeStep(step_id="s-3", task_id=task.task_id,
                                   kind="model", title="Model #3"))
        task.current_step_id = "s-3"
        task.update_status("interrupted"); save_task(task)

        # Create checkpoint first
        cp = checkpoint_task(task.task_id, ws, reason="interrupted_at_step_3")
        assert cp is not None

        result = resume_task(task.task_id, ws)
        assert result["ok"] is False and result["status"] == "unsupported"
        assert result["resume_not_supported"] is True
        loaded = get_task(ws, task.task_id)
        assert loaded.to_dict() == task.to_dict()
        assert get_checkpoints(ws, task.task_id)[-1]["checkpoint_id"] == cp.checkpoint_id

    def test_unsupported_resume_does_not_claim_executor_was_resumed(self):
        ws = f"ws_rwe_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1")
        task.update_status("interrupted"); save_task(task)
        checkpoint_task(task.task_id, ws, reason="test")

        before = get_events(ws, task.task_id)
        result = resume_task(task.task_id, ws)
        assert result["ok"] is False
        assert get_events(ws, task.task_id) == before

    def test_cross_workspace_resume_rejected(self):
        ws_a = f"ws_ra_{uuid.uuid4().hex[:8]}"
        ws_b = f"ws_rb_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws_a, session_id="s1")
        save_task(task)

        result = resume_task(task.task_id, ws_b)
        assert result["ok"] is False


class TestMidExecutionPersistence:
    """Phase 3: mid-execution state persistence."""

    def test_task_saved_mid_execution(self):
        """Simulate mid-execution save — task exists on disk before completion."""
        ws = f"ws_mid_{uuid.uuid4().hex[:8]}"
        task = TaskState.new(workspace_id=ws, session_id="s1", run_id="r1")
        task.update_status("running")
        task.add_step(RuntimeStep(step_id="s-mid", task_id=task.task_id,
                                   kind="model", status="running"))
        save_task(task)  # mid-execution save

        # Verify task is readable mid-flight
        loaded = get_task(ws, task.task_id)
        assert loaded is not None
        assert loaded.status == "running"
        assert len(loaded.steps) == 1
        assert loaded.steps[0].status == "running"
