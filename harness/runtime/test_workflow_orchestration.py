from __future__ import annotations

import pytest

from workflows.service import WorkflowError, execute_workflow, save_workflow


def _write_workflow(monkeypatch, tmp_path, invoke, *, nodes=None):
    from types import SimpleNamespace
    import workflows.service as service

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))

    class Client:
        def list_tools(self):
            return [{"tool_id": "synthetic.write", "enabled": True}]

        def canonicalize_arguments(self, _tool_id, arguments):
            return dict(arguments)

        def invoke(self, _tool_id, arguments, context=None):
            invoke(arguments, context)
            return SimpleNamespace(status="succeeded", output={"receipt": arguments["node"]},
                                   summary="saved", errors=[], duration_ms=1)

    monkeypatch.setattr(service, "_tool_client", lambda: Client())
    service.save_workflow("default", {
        "workflow_id": "write_graph", "name": "write graph",
        "nodes": nodes or [{"node_id": "a", "tool_id": "synthetic.write", "arguments": {"node": "a"}}],
    })
    return service


@pytest.mark.parametrize("latest_status", ["running", "succeeded", "completed", "failed", "cancelled"])
def test_cancel_workflow_reads_latest_evidence_inside_run_lock(monkeypatch, tmp_path, latest_status):
    from copy import deepcopy
    from storage.locking import FileLock
    import workflows.service as service

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    initial = {"workspace_id": "default", "run_id": "cancel_race", "workflow_id": "wf",
               "status": "running", "nodes": []}
    service._save_run(initial)
    latest = {**initial, "status": latest_status,
              "nodes": [{"node_id": "a", "status": "succeeded", "output": {"receipt": "saved"}}]}
    if latest_status != "running":
        latest["finished_at"] = "2026-11-13T00:00:00Z"
    injected = False

    class InterleavedLock(FileLock):
        def __enter__(self):
            nonlocal injected
            if not injected:
                injected = True
                committed = deepcopy(latest)
                service._save_run(committed)
                latest.update(committed)
            return super().__enter__()

    monkeypatch.setattr(service, "FileLock", InterleavedLock)
    returned = service.cancel_run("default", "cancel_race")
    saved = service.get_run("default", "cancel_race")
    assert saved == returned
    assert saved["nodes"] == latest["nodes"]
    assert saved["status"] == latest_status
    if latest_status == "running":
        assert saved["cancel_requested"] is True
    else:
        assert saved == latest
        service._save_run(deepcopy(initial))
        assert service.get_run("default", "cancel_race") == latest


def test_concurrent_workflow_run_creation_executes_write_once(monkeypatch, tmp_path):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from storage.locking import FileLock

    entered, release_create = threading.Event(), threading.Event()
    second_attempt, release_tool = threading.Event(), threading.Event()
    calls = []

    def invoke(arguments, _context):
        calls.append(arguments["node"])
        assert release_tool.wait(5)

    service = _write_workflow(monkeypatch, tmp_path, invoke)
    original_write = service.atomic_write_json
    first_create = True

    def delayed_create(path, record):
        nonlocal first_create
        if path.stem == "same_run" and first_create:
            first_create = False
            entered.set()
            assert release_create.wait(5)
        return original_write(path, record)

    class ObservedLock(FileLock):
        def __enter__(self):
            if threading.current_thread().name.startswith("duplicate"):
                second_attempt.set()
            return super().__enter__()

    monkeypatch.setattr(service, "atomic_write_json", delayed_create)
    monkeypatch.setattr(service, "FileLock", ObservedLock)
    with ThreadPoolExecutor(max_workers=1) as owner_pool, ThreadPoolExecutor(max_workers=1, thread_name_prefix="duplicate") as duplicate_pool:
        owner = owner_pool.submit(service.execute_workflow, "default", "write_graph", run_id="same_run")
        try:
            assert entered.wait(5)
            duplicate = duplicate_pool.submit(service.execute_workflow, "default", "write_graph", run_id="same_run")
            assert second_attempt.wait(5)
            release_create.set()
            existing = duplicate.result(timeout=5)
            assert existing["status"] == "running"
            assert existing["run_id"] == "same_run"
        finally:
            release_create.set()
            release_tool.set()
        result = owner.result(timeout=5)
    assert calls == ["a"]
    assert result["status"] == "succeeded"
    assert service.execute_workflow("default", "write_graph", run_id="same_run") == result
    assert calls == ["a"]


@pytest.mark.parametrize("mode", ["serial", "parallel", "last_node", "job"])
def test_workflow_cancellation_stops_pending_nodes_and_preserves_receipts(monkeypatch, tmp_path, mode):
    from jobs.manager import cancel_job, create_job
    from jobs.runner import run_job
    from jobs.store import get_job

    seen = []
    def invoke(arguments, context):
        seen.append(arguments["node"])
        if mode == "job":
            cancel_job("default", context.job_id)
        else:
            service.cancel_run("default", context.run_id)

    nodes = [{"node_id": name, "tool_id": "synthetic.write", "arguments": {"node": name}}
             for name in (["a"] if mode == "last_node" else ["a", "b", "c"])]
    if mode != "last_node":
        nodes[-1]["depends_on"] = ["b"]
    service = _write_workflow(monkeypatch, tmp_path, invoke, nodes=nodes)
    monkeypatch.setattr("core.runtime_engine.contracts.is_read_only_call", lambda *_args: mode == "parallel")
    if mode == "parallel":
        from storage.principal import ContextThreadPoolExecutor
        monkeypatch.setattr(service, "ContextThreadPoolExecutor", lambda **kwargs: ContextThreadPoolExecutor(max_workers=1))
    if mode == "job":
        job = create_job("default", "workflow_run", "Cancel workflow", {"workflow_id": "write_graph"}, enqueue=True)
        run_job("default", job.job_id)
        finished_job = get_job("default", job.job_id)
        assert finished_job.status == "cancelled"
        run = service.get_run("default", finished_job.result_summary["workflow_run_id"])
        assert finished_job.result_summary["status"] == "cancelled"
    else:
        run = service.execute_workflow("default", "write_graph")
    assert seen == ["a"]
    assert run["status"] == "cancelled"
    assert run["nodes"][0]["output"] == {"receipt": "a"}
    assert all(node["status"] == "cancelled" for node in run["nodes"][1:])
    assert len(run["nodes"]) == len(nodes)
    assert service.get_run("default", run["run_id"])["status"] == "cancelled"


def test_workflow_run_creation_refuses_unreadable_existing_record(monkeypatch, tmp_path):
    service = _write_workflow(monkeypatch, tmp_path, lambda *_args: pytest.fail("must not execute"))
    path = service._run_path("default", "broken_run")
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError):
        service.execute_workflow("default", "write_graph", run_id="broken_run")
    assert path.read_text(encoding="utf-8") == "{broken"


def test_workflow_final_commit_merges_cancel_after_last_probe(monkeypatch, tmp_path):
    service = _write_workflow(monkeypatch, tmp_path, lambda *_args: None)
    original_save = service._save_run

    def cancel_before_commit(record):
        if record["status"] == "succeeded":
            service.cancel_run(record["workspace_id"], record["run_id"])
        original_save(record)

    monkeypatch.setattr(service, "_save_run", cancel_before_commit)
    result = service.execute_workflow("default", "write_graph")
    assert result["status"] == "cancelled"
    assert result["nodes"][0]["output"] == {"receipt": "a"}
    assert service.get_run("default", result["run_id"]) == result


def _definition():
    return {
        "workflow_id": "network_asset_read",
        "name": "网络资产只读流程",
        "nodes": [{
            "node_id": "list_assets",
            "tool_id": "network.operations.devices_read",
            "arguments": {},
        }],
    }

def test_network_asset_read_dag_executes_and_persists_inputs(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests
    reset_extension_cache_for_tests(); reset_default_client_for_tests()
    saved = save_workflow("default", _definition())
    assert saved["execution_order"] == ["list_assets"]
    run = execute_workflow("default", "network_asset_read", {"text": "alpha beta"})
    assert run["status"] == "succeeded"
    assert [item["status"] for item in run["nodes"]] == ["succeeded"]
    assert run["nodes"][0]["output"]["devices"] == []
    assert run["inputs"] == {"text": "alpha beta"}


def test_workflow_rejects_raw_runtime_secrets_before_persistence(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests

    reset_extension_cache_for_tests()
    reset_default_client_for_tests()
    save_workflow("default", _definition())

    with pytest.raises(WorkflowError, match="cannot contain raw secrets"):
        execute_workflow(
            "default",
            "network_asset_read",
            {"text": "alpha beta", "api_token": "must-not-persist"},
        )


def test_workflow_accepts_non_secret_token_metadata(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests

    reset_extension_cache_for_tests()
    reset_default_client_for_tests()
    save_workflow("default", _definition())

    run = execute_workflow(
        "default",
        "network_asset_read",
        {"text": "alpha beta", "token_count": 42, "max_tokens": 1024},
    )

    assert run["status"] == "succeeded"
    assert run["inputs"]["token_count"] == 42


def test_workflow_validation_rejects_cycles_and_unknown_tools(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    cyclic = _definition()
    cyclic["nodes"].append({"node_id": "second", "tool_id": "network.operations.devices_read", "arguments": {}, "depends_on": ["list_assets"]})
    cyclic["nodes"][0]["depends_on"] = ["second"]
    with pytest.raises(WorkflowError, match="cycle"):
        save_workflow("default", cyclic)
    unknown = _definition()
    unknown["nodes"][0]["tool_id"] = "missing.tool"
    with pytest.raises(WorkflowError, match="unknown or disabled"):
        save_workflow("default", unknown)
    secret = _definition()
    secret["nodes"][0]["arguments"]["api_token"] = "literal-secret"
    with pytest.raises(WorkflowError, match="static secret"):
        save_workflow("default", secret)


def test_missing_runtime_input_is_recorded_as_a_failed_node(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests
    reset_extension_cache_for_tests(); reset_default_client_for_tests()
    missing = _definition()
    missing["nodes"][0]["arguments"] = {"workspace_id": "${input.missing}"}
    save_workflow("default", missing)
    run = execute_workflow("default", "network_asset_read", {})
    assert run["status"] == "failed"
    assert run["nodes"][0]["status"] == "failed"
    assert "not found" in run["nodes"][0]["errors"][0]
    from storage.review_store import load_sidecar
    review = load_sidecar("default", f"workflow-{run['run_id']}")
    assert review and review["items"][0]["source_key"] == f"workflow-run:{run['run_id']}"


def test_continue_runs_independent_branch_but_skips_failed_dependents(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    import workflows.service as service

    seen = []

    class Client:
        def canonicalize_arguments(self, _tool_id, arguments):
            return dict(arguments)

        def list_tools(self):
            return [{"tool_id": "data.manage", "enabled": True}]

        def invoke(self, _tool_id, arguments, context=None):
            seen.append(arguments["text"])
            ok = arguments["text"] != "fail"
            return type("Result", (), {
                "status": "succeeded" if ok else "failed",
                "output": {"value": arguments["text"]} if ok else {},
                "summary": "ok" if ok else "failed",
                "errors": [] if ok else ["failed"],
                "duration_ms": 1,
            })()

    monkeypatch.setattr(service, "_tool_client", lambda: Client())
    service.save_workflow("default", {
        "workflow_id": "continue_graph", "name": "continue graph",
        "failure_policy": "continue",
        "nodes": [
            {"node_id": "source", "tool_id": "data.manage", "arguments": {"action": "parse", "text": "fail"}},
            {"node_id": "independent", "tool_id": "data.manage", "arguments": {"action": "parse", "text": "independent"}},
            {"node_id": "dependent", "tool_id": "data.manage", "depends_on": ["source"], "arguments": {"action": "parse", "text": "must-not-run"}},
        ],
    })
    run = service.execute_workflow("default", "continue_graph")
    by_id = {node["node_id"]: node for node in run["nodes"]}
    assert seen == ["independent", "fail"] or seen == ["fail", "independent"]
    assert by_id["dependent"]["status"] == "skipped"
    assert "source" in by_id["dependent"]["errors"][0]
    assert run["status"] == "failed"


def test_workflow_job_runs_through_durable_job_lifecycle(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests
    reset_extension_cache_for_tests(); reset_default_client_for_tests()
    save_workflow("default", _definition())
    from jobs.manager import create_job
    from jobs.runner import run_job
    from jobs.store import get_job
    job = create_job("default", "workflow_run", "Workflow", {"workflow_id": "network_asset_read", "inputs": {"text": "queued text"}}, enqueue=True)
    run_job("default", job.job_id)
    completed = get_job("default", job.job_id)
    assert completed and completed.status == "succeeded"
    assert completed.result_summary["workflow_id"] == "network_asset_read"
    assert completed.result_summary["workflow_run_id"].startswith("wfrun_")


def test_progress_save_cannot_erase_a_concurrent_cancel_request(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    from workflows.service import _save_run, cancel_run, get_run

    initial = {
        "workspace_id": "default",
        "run_id": "cancel_race",
        "workflow_id": "network_asset_read",
        "status": "running",
        "nodes": [],
    }
    _save_run(initial)
    stale_progress = dict(get_run("default", "cancel_race") or {})
    cancel_run("default", "cancel_race")
    _save_run(stale_progress)

    assert get_run("default", "cancel_race")["cancel_requested"] is True


def test_organization_workspace_isolation_and_workflow_roles(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    monkeypatch.setenv("LZCORE_SESSION_SECRET", "workflow-session-secret")
    monkeypatch.setenv("LZCORE_MASTER_KEY", "workflow-master-key")
    monkeypatch.delenv("LZCORE_LOGIN_USERNAME", raising=False)
    monkeypatch.delenv("LZCORE_LOGIN_PASSWORD", raising=False)
    from backend.core.identity import upsert_user
    from storage.workspace_store import ensure_workspace
    ensure_workspace("team_a"); ensure_workspace("team_b"); ensure_workspace("root_owner")
    upsert_user("developer_a", "password", "developer", "org_a", ["team_a"])
    upsert_user("viewer_a", "password", "viewer", "org_a", ["team_a"])
    upsert_user("admin_b", "password", "admin", "org_b", ["team_b"])
    upsert_user("platform_owner", "password", "owner", "org_root", ["root_owner"])
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests
    reset_extension_cache_for_tests(); reset_default_client_for_tests()
    from backend.main import create_app
    app = create_app(); app.config.update(TESTING=True)
    origin = {"Origin": "http://localhost:5273"}

    developer = app.test_client()
    developer.post("/api/auth/login", json={"username": "developer_a", "password": "password"}, headers=origin)
    created = developer.post("/api/workflows", json={**_definition(), "workspace_id": "team_a"}, headers=origin)
    assert created.status_code == 201
    assert developer.get("/api/workflows?workspace_id=team_b", headers=origin).status_code == 403

    viewer = app.test_client()
    viewer.post("/api/auth/login", json={"username": "viewer_a", "password": "password"}, headers=origin)
    denied = viewer.post("/api/workflows/network_asset_read/runs", json={"workspace_id": "team_a", "inputs": {"text": "x"}}, headers=origin)
    assert denied.status_code == 403

    admin_b = app.test_client()
    admin_b.post("/api/auth/login", json={"username": "admin_b", "password": "password"}, headers=origin)
    assert admin_b.get("/api/workflows?workspace_id=team_a", headers=origin).status_code == 403
    assert admin_b.post("/api/identity/organizations", json={"organization_id": "forbidden_org", "name": "Forbidden"}, headers=origin).status_code == 403
    assert admin_b.post("/api/identity/users", json={"username": "escalated", "password": "password", "role": "owner", "organization_id": "org_b", "workspace_ids": ["team_b"]}, headers=origin).status_code == 403
    assert admin_b.post("/api/identity/users", json={"username": "developer_a", "password": "replaced", "role": "viewer", "organization_id": "org_b", "workspace_ids": ["team_b"]}, headers=origin).status_code == 403
    assert admin_b.post("/api/identity/organizations/org_b/memberships", json={"username": "developer_a", "role": "viewer", "workspace_ids": ["team_b"]}, headers=origin).status_code == 403

    original = app.test_client()
    assert original.post("/api/auth/login", json={"username": "developer_a", "password": "password"}, headers=origin).status_code == 200

    owner = app.test_client()
    owner.post("/api/auth/login", json={"username": "platform_owner", "password": "password"}, headers=origin)
    created_org = owner.post("/api/identity/organizations", json={"organization_id": "org_c", "name": "组织 C"}, headers=origin)
    assert created_org.status_code == 201
    assert owner.get("/api/identity/organizations", headers=origin).get_json()["organizations"]
    from backend.core.identity import assign_workspace
    with pytest.raises(ValueError, match="another organization"):
        assign_workspace("org_c", "team_a")


def test_queued_workflow_rejects_raw_secrets_before_job_persistence(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "false")
    from extensions.runtime import reset_extension_cache_for_tests
    from core.tools.integration import reset_default_client_for_tests

    reset_extension_cache_for_tests()
    reset_default_client_for_tests()
    save_workflow("default", _definition())
    from backend.main import create_app

    app = create_app()
    app.config.update(TESTING=True)
    from backend.core.local_token import local_browser_token
    response = app.test_client().post(
        "/api/workflows/network_asset_read/runs",
        json={
            "workspace_id": "default",
            "enqueue": True,
            "inputs": {"text": "alpha beta", "api_token": "must-not-persist"},
        },
        headers={"Origin": "http://localhost:5273", "X-LZCore-Local-Token": local_browser_token()},
    )

    assert response.status_code == 400
    assert "cannot contain raw secrets" in response.get_json()["error"]
    assert not list((tmp_path / "workspaces").rglob("job_*.json"))
