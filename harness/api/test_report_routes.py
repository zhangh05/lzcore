"""Report HTTP adapters use the current governed tool and stored run facts."""

from types import SimpleNamespace

import pytest
from flask import Flask


@pytest.fixture
def reports_client():
    from backend.api.workspace_routes import register_workspace_routes
    app = Flask(__name__)
    app.testing = True
    register_workspace_routes(app)
    return app.test_client()


def _stored_run(workspace="default", response="服务端保存的结论"):
    from storage.run_record_store import write_run_record
    return write_run_record(SimpleNamespace(
        request_id="run-report", session_id="session-report", final_response=response,
        execution_outcome="unknown", tool_execution_outcome="partial", result_ok=False,
    ), workspace)


@pytest.mark.parametrize("path", ["/api/reports/create", "/api/workspaces/default/runs/run-report/report"])
def test_report_generation_uses_real_run_through_governed_runtime(reports_client, monkeypatch, path):
    from artifacts.store import get_artifact, read_artifact_content
    from core.tools.integration import get_default_tool_runtime_client

    _stored_run()
    client = get_default_tool_runtime_client()
    invoke = client.invoke
    invocations = []

    def observe(tool_id, arguments, **kwargs):
        context = kwargs["context"]
        invocations.append((tool_id, arguments["action"], context.workspace_id, context.requested_by))
        return invoke(tool_id, arguments, **kwargs)

    monkeypatch.setattr(client, "invoke", observe)
    response = reports_client.post(path, json={
        "workspace_id": "default", "run_id": "run-report", "title": "Test report",
        "agent_result": {"final_response": "forged complete"},
        **({"content": "forged complete"} if path.endswith("/report") else {}),
    })
    assert response.status_code == 200, response.get_json()
    body = response.get_json()
    assert body["ok"] is True and body["format"] == "markdown"
    assert invocations == [("report.manage", "document", "default", "rest_api"),
                           ("report.manage", "save", "default", "rest_api")]
    artifact = get_artifact("default", body["artifact_id"])
    assert artifact.run_id == "run-report"
    assert artifact.session_id == "session-report"
    content = read_artifact_content("default", body["artifact_id"])
    assert "服务端保存的结论" in content
    assert "execution_outcome: unknown" in content
    assert "forged complete" not in content


def test_manual_report_create_saves_redacted_content(reports_client):
    from artifacts.store import read_artifact_content

    credential = "test-credential-value"
    response = reports_client.post("/api/reports/create", json={
        "workspace_id": "default", "title": "Manual report", "content": f"Observation: password={credential}",
    })
    assert response.status_code == 200, response.get_json()
    content = read_artifact_content("default", response.get_json()["artifact_id"])
    assert credential not in content
    assert "REDACTED" in content


@pytest.mark.parametrize("path", ["/api/reports/create", "/api/workspaces/default/runs/run-report/report"])
def test_report_does_not_accept_run_from_another_workspace(reports_client, path):
    _stored_run("other-workspace")
    response = reports_client.post(path, json={"workspace_id": "default", "run_id": "run-report"})
    assert response.status_code == 404
    assert response.get_json() == {"ok": False, "error": "run_not_found"}


def test_run_report_without_content_is_explicit_conflict(reports_client):
    _stored_run(response="")
    response = reports_client.post("/api/workspaces/default/runs/run-report/report", json={})
    assert response.status_code == 409
    assert response.get_json() == {"ok": False, "error": "run_report_content_unavailable"}


def test_report_preserves_runtime_policy_denial(reports_client, monkeypatch):
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.schemas import PolicyDecision
    client = get_default_tool_runtime_client()
    monkeypatch.setattr(client._policy, "check", lambda *_args: PolicyDecision(allowed=False, reason="denied"))
    response = reports_client.post("/api/reports/create", json={"workspace_id": "default", "content": "Safe summary"})
    assert response.status_code == 403
    assert response.get_json()["ok"] is False
    from artifacts.store import list_artifacts
    assert list_artifacts("default", artifact_type="report") == []
