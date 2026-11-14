"""Aggregate TaskState API contracts using real session/task storage."""

import pytest
from flask import Flask

from agent.runtime.task_state import commit_task_state
from backend.api.state_routes import register_state_routes
from backend.core.auth import register_auth_middleware
from storage.principal import storage_principal
from storage.session_store import create_session, update_session


@pytest.fixture
def client(monkeypatch):
    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    register_auth_middleware(app)
    register_state_routes(app)
    return app.test_client()


def _session(ws="tasks-ws", *, metadata=None, task=True):
    session = create_session(ws, title="核对任务")
    if task:
        commit_task_state(
            workspace_id=ws, session_id=session["session_id"],
            run_id="run-" + session["session_id"], user_input="核对外部写入结果",
            final_response="等待核对", run_ok=True,
            runtime_metadata=metadata or {}, tool_calls=[],
        )
    return session


def test_aggregate_preserves_workspace_and_principal_scope(client):
    with storage_principal("first-user"):
        own = _session()
        _session("other-ws")
    with storage_principal("second-user"):
        second = _session()
        response = client.get("/api/runtime/session-tasks?workspace_id=tasks-ws")
        assert [item["session_id"] for item in response.json["items"]] == [second["session_id"]]
    with storage_principal("first-user"):
        result = client.get("/api/runtime/session-tasks?workspace_id=tasks-ws").json
    assert result["ok"] is True and result["workspace_id"] == "tasks-ws"
    assert [item["session_id"] for item in result["items"]] == [own["session_id"]]
    assert result["sessions_scanned"] == 1 and result["truncated"] is False


def test_aggregate_identity_rejects_foreign_workspace(client, monkeypatch):
    from backend.core.identity import upsert_user, get_user

    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    upsert_user("scoped-user", "test-only-passphrase", "viewer", "tasks-ws", ["tasks-ws"])
    with client.session_transaction() as session:
        user = get_user("scoped-user")
        session.update(lzcore_user="scoped-user", lzcore_user_id=user["user_id"],
                       lzcore_auth_version=user["auth_version"], lzcore_identity_type="managed")
    assert client.get("/api/runtime/session-tasks?workspace_id=other-ws").status_code == 403
    assert client.get("/api/runtime/session-tasks?workspace_id=tasks-ws").status_code == 200


def test_limit_counts_empty_states_and_filters_session_status(client):
    _session()
    _session(task=False)
    archived = _session()
    update_session(archived["session_id"], "tasks-ws", status="archived")
    for limit, scanned, truncated in [(1, 1, True), (2, 2, True), (3, 2, False)]:
        result = client.get(f"/api/runtime/session-tasks?workspace_id=tasks-ws&status=active&limit={limit}").json
        assert result["sessions_scanned"] == scanned
        assert result["truncated"] is truncated
        assert all(item["session_id"] != archived["session_id"] for item in result["items"])
        if limit >= 2:
            assert len(result["items"]) == 1
    assert client.get("/api/runtime/session-tasks?workspace_id=tasks-ws&status=archived").json["items"][0]["session_id"] == archived["session_id"]


def test_default_limit_is_fifty_and_maximum_is_two_hundred(client, monkeypatch):
    import storage.session_store as store

    calls = []
    monkeypatch.setattr(store, "list_sessions", lambda ws, **kw: calls.append((ws, kw)) or [])
    for query in ("", "&limit=200"):
        assert client.get("/api/runtime/session-tasks?workspace_id=tasks-ws" + query).status_code == 200
    assert calls == [("tasks-ws", {"status": "active", "limit": 50}), ("tasks-ws", {"status": "active", "limit": 200})]


def test_single_session_failure_is_safe_and_does_not_drop_other_tasks(client, monkeypatch):
    from agent.runtime import task_state

    broken, good = _session(), _session()
    original = task_state.load_task_state

    def load(ws, sid):
        if sid == broken["session_id"]:
            raise OSError("sensitive path or credential must not reach the response")
        return original(ws, sid)

    monkeypatch.setattr(task_state, "load_task_state", load)
    response = client.get("/api/runtime/session-tasks?workspace_id=tasks-ws")
    assert response.status_code == 200
    assert response.json["sessions_scanned"] == 2
    assert response.json["errors"] == [{"session_id": broken["session_id"], "reason": "task_state_read_failed"}]
    assert [item["session_id"] for item in response.json["items"]] == [good["session_id"]]


@pytest.mark.parametrize("reconciled", [False, True])
def test_unknowns_are_identical_to_single_session_projection(client, reconciled):
    session = _session(metadata={
        "unknown_outcome": {"status": "reconciled" if reconciled else "unknown", "kind": "external_write", "reason": "read_back_required"},
        "cognitive": {"unknown_count": 1},
    })
    sid = session["session_id"]
    single = client.get(f"/api/runtime/sessions/{sid}/task-state?workspace_id=tasks-ws").json["task_state"]["task"]
    item = client.get("/api/runtime/session-tasks?workspace_id=tasks-ws").json["items"][0]
    assert item == {
        "session_id": sid, "title": session["title"], "updated_at": session["updated_at"],
        "task": {key: single[key] for key in ("task_id", "objective", "status", "unknowns")},
    }
    assert item["task"]["unknowns"] == ([] if reconciled else [{"kind": "external_write", "reason": "read_back_required"}])


@pytest.mark.parametrize("query", ["", "workspace_id=../bad", "workspace_id=tasks-ws&limit=0", "workspace_id=tasks-ws&limit=201", "workspace_id=tasks-ws&limit=no", "workspace_id=tasks-ws&status=unknown"])
def test_aggregate_rejects_invalid_input(client, query):
    assert client.get("/api/runtime/session-tasks?" + query).status_code == 400
