"""Workflow interruption recovery uses isolated records and synthetic tools."""
import pytest
from jobs.schemas import JobRecord
from jobs.store import create_job, get_job, reconcile_running_jobs, fence_reclaimed_running_job
from storage.principal import storage_principal
from workflows.service import _save_run, get_run


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr("storage.principal.known_storage_principals", lambda: ["alice"])


def test_job_link_is_durable_before_workflow_execution(monkeypatch):
    from jobs.runner import _run_workflow
    from jobs.store import update_job
    def execute(ws, workflow_id, _inputs, *, job_id, run_id):
        assert get_job(ws, job_id).result_summary["workflow_run_id"] == run_id
        assert workflow_id == "wf_synthetic"
        return {"workflow_id": workflow_id, "run_id": run_id, "status": "succeeded"}
    monkeypatch.setattr("workflows.service.execute_workflow", execute)
    rec = create_job(JobRecord(job_type="workflow_run", status="running", payload={"workflow_id": "wf_synthetic"}))
    _run_workflow(rec)
    first = get_job("default", rec.job_id).result_summary["workflow_run_id"]
    update_job("default", rec.job_id, {"retry_count": 1})
    _run_workflow(get_job("default", rec.job_id))
    assert get_job("default", rec.job_id).result_summary["workflow_run_id"] != first


@pytest.mark.parametrize("mode", ["startup", "lease"])
def test_recovery_closes_linked_run_without_replaying_or_erasing_evidence(mode):
    with storage_principal("alice"):
        rec = create_job(JobRecord(job_type="workflow_run", status="running", updated_at="2020", payload={"workflow_id": "wf_synthetic"}))
        _save_run({"workspace_id": "default", "workflow_id": "wf_synthetic", "run_id": "wfrun_synthetic", "job_id": rec.job_id,
                   "status": "running", "nodes": [{"node_id": "a", "status": "succeeded", "output": {"receipt": "confirmed"}}, {"node_id": "b", "status": "running"}]})
        if mode == "lease":
            fence_reclaimed_running_job("default", rec.job_id, lease_id="lost", attempt=2)
    if mode == "startup":
        reconcile_running_jobs("9999", "9999")
    with storage_principal("alice"):
        run = get_run("default", "wfrun_synthetic")
        assert get_job("default", rec.job_id).status == "failed"
        assert run["status"] == "failed"
        assert run["execution_outcome"] == "unknown" and run["recovery_required"] is True
        assert run["nodes"][0]["output"] == {"receipt": "confirmed"}
        assert run["nodes"][1]["status"] == "execution_unknown"
        # A surviving executor cannot turn the recovery fence into success.
        _save_run({**run, "status": "succeeded"})
        assert get_run("default", "wfrun_synthetic")["status"] == "failed"


def test_startup_recovers_orphan_and_preserves_completed_and_new_runs():
    from storage.workspace_store import ensure_workspace
    with storage_principal("alice"):
        ensure_workspace("default")
        from storage.atomic_io import atomic_write_json
        from workflows.service import _run_path
        for name, status, updated in (("orphan", "running", "2020"), ("complete", "succeeded", "2020"), ("new", "running", "2040")):
            atomic_write_json(_run_path("default", name), {"workspace_id": "default", "workflow_id": "wf_synthetic", "run_id": name,
                                                       "status": status, "updated_at": updated, "nodes": []})
    reconcile_running_jobs("2030", "2030")
    with storage_principal("alice"):
        assert get_run("default", "orphan")["execution_outcome"] == "unknown"
        assert get_run("default", "complete")["status"] == "succeeded"
        assert get_run("default", "new")["status"] == "running"
