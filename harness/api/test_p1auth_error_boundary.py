"""Dependency failures must not disclose paths or secrets over HTTP or logs."""

import io

import pytest
from flask import Flask


@pytest.fixture
def client(monkeypatch):
    # Search lazily imports this module, which binds managed_data_files at module
    # scope. Load it before patching that dependency so no fake survives undo.
    import storage.file_workspace

    from backend.api.state_routes import register_state_routes
    from backend.api.storage_routes import register_storage_routes
    from backend.api.workspace_status_routes import register_workspace_status_routes
    from backend.core.auth import register_auth_middleware
    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    app = Flask(__name__)
    register_state_routes(app)
    register_storage_routes(app)
    register_workspace_status_routes(app)
    register_auth_middleware(app)
    return app.test_client()


@pytest.mark.parametrize("exception", [PermissionError, ValueError])
def test_search_failure_patch_does_not_leak_into_file_paging(client, monkeypatch, tmp_path, exception):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_WORKSPACE_DIR", str(tmp_path))

    def fail(*args, **kwargs):
        raise exception("synthetic search dependency failure")

    with monkeypatch.context() as patch:
        patch.setattr("storage.data_management.managed_data_files", fail)
        response = client.get("/api/storage/search?workspace_id=mine&q=marker")
        assert response.status_code == 400
        assert response.json["error"] == "storage_operation_failed"

    # A first request must not leave its temporary dependency in an imported
    # module after monkeypatch restores the original function.
    from storage.file_store import import_user_upload, resolve_file_path
    from storage.file_workspace import files_page

    record = import_user_upload("mine", io.BytesIO(b"marker"), "sample.txt")
    assert [row["file_id"] for row in files_page("mine")["files"]] == [record.file_id]
    response = client.get("/api/storage/files?workspace_id=mine")
    assert response.status_code == 200
    assert [row["file_id"] for row in response.json["files"]] == [record.file_id]
    assert resolve_file_path("mine", record.file_id).read_bytes() == b"marker"


@pytest.mark.parametrize("path,target", [
    ("/api/runtime/tasks", "agent.runtime.durable.store.list_tasks"),
    ("/api/runtime/tasks/task", "agent.runtime.durable.store.get_task"),
    ("/api/runtime/tasks/task/events", "agent.runtime.durable.store.get_task"),
    ("/api/runtime/tasks/task/checkpoints", "agent.runtime.durable.store.get_task"),
    ("/api/runtime/trajectories", "agent.runtime.durable.trajectory.list_trajectories"),
    ("/api/runtime/trajectories/trajectory", "agent.runtime.durable.trajectory.get_trajectory"),
    ("/api/storage/search", "storage.data_management.managed_data_files"),
    ("/api/storage/files", "storage.file_workspace.files_page"),
    ("/api/storage/files/file/content", "storage.data_management.text_file_content"),
    ("/api/storage/health", "storage.file_audit.file_health"),
    ("/api/workspaces/mine/storage/health", "storage.doctor.run_doctor"),
])
@pytest.mark.parametrize("exception", [PermissionError, ValueError])
def test_read_failures_have_stable_error_and_opaque_id(client, monkeypatch, caplog, path, target, exception):
    private = "/synthetic-private/users/example/sys/tasks/task.json"
    secret = "synthetic-sensitive-marker"
    def fail(*args, **kwargs):
        raise exception(f"{private}: {secret}")
    monkeypatch.setattr(target, fail)
    response = client.get(path + "?workspace_id=mine")
    assert response.status_code in {400, 500}
    assert response.json["ok"] is False
    assert response.json["error"] in {"internal_error", "storage_operation_failed", "INTERNAL_ERROR"}
    assert len(response.json["error_id"]) == 32
    assert response.json["error_id"] in caplog.text
    assert private not in response.get_data(as_text=True) + caplog.text
    assert secret not in response.get_data(as_text=True) + caplog.text


def test_storage_keeps_public_validation_error_codes(client, monkeypatch):
    def invalid(*args, **kwargs):
        raise ValueError("file_unavailable")
    monkeypatch.setattr("storage.file_workspace.files_page", invalid)
    response = client.get("/api/storage/files?workspace_id=mine")
    assert response.status_code == 400
    assert response.json["error"] == "file_unavailable"


def test_sanitizing_unknown_write_does_not_authorize_retry(client, monkeypatch):
    calls = []
    def unknown(*args, **kwargs):
        calls.append(args)
        raise OSError("/synthetic-private/state: sensitive-marker")
    monkeypatch.setattr("storage.file_audit.reconcile_file_commits", unknown)
    response = client.post("/api/storage/reconcile", json={"workspace_id": "mine", "apply": True})
    assert response.status_code == 409
    assert response.json["error"] == "storage_operation_failed"
    assert response.json["error_code"] == "EXECUTION_UNKNOWN"
    assert response.json["automatic_retry_allowed"] is False
    assert len(calls) == 1
    assert "sensitive-marker" not in response.get_data(as_text=True)
