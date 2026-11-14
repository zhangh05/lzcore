"""Network inspections use only temporary internal worker Jobs."""

import pytest


@pytest.mark.parametrize("status", ["succeeded", "completed", "failed", "cancelled", "partial"])
def test_cancel_inspection_preserves_worker_terminal_evidence(monkeypatch, tmp_path, status):
    from types import SimpleNamespace
    from extensions.network_operations import network_inspection_lifecycle as lifecycle
    from extensions.network_operations import network_inspections as worker
    from jobs import manager

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    store = lifecycle._store("default")
    initial = {"task_id": "inspection_race", "job_id": "job_race", "status": "running",
               "results": {}, "completed": 0}
    store.save("inspections", initial["task_id"], initial)
    terminal = {"task_id": initial["task_id"], "status": status,
                "results": {"c1": {"status": "succeeded", "output_hash": "hash"}},
                "completed": 1, "succeeded": 1, "artifact_id": "art_evidence",
                "finished_at": "2026-11-13T00:00:00Z"}

    def complete_during_job_cancel(*_args):
        # The worker has also removed its implementation Job by this point.
        store.save("inspections", initial["task_id"], terminal)
        return SimpleNamespace(status="cancelled")

    monkeypatch.setattr(manager, "cancel_job", complete_during_job_cancel)
    assert lifecycle.cancel_inspection("default", initial["task_id"]) is False
    assert lifecycle.get_inspection("default", initial["task_id"]) == terminal
    stale_worker = {**initial, "completed": 0}
    worker._save_inspection_task("default", stale_worker)
    assert lifecycle.get_inspection("default", initial["task_id"]) == terminal
    assert stale_worker == terminal


@pytest.mark.parametrize("cancel_phase", ["collect", "evidence"])
def test_inspection_runner_cancel_preserves_evidence_through_job_cleanup(monkeypatch, tmp_path, cancel_phase):
    from extensions.network_operations import network_inspection_lifecycle as lifecycle
    from extensions.network_operations import network_inspections as worker
    from jobs.manager import create_job
    from jobs.runner import run_job
    from jobs.store import get_job

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    target = {"connection_id": "c1", "name": "synthetic", "host": "192.0.2.1"}
    task = {"task_id": "inspection_cancel", "status": "queued", "connection_ids": ["c1"],
            "script": {"name": "synthetic"}, "results": {}, "completed": 0,
            "succeeded": 0, "failed": 0, "partial": 0}
    job = create_job("default", "network_inspection", "Synthetic inspection", {"task_id": task["task_id"]}, enqueue=True)
    task["job_id"] = job.job_id
    worker._store("default").save("inspections", task["task_id"], task)
    monkeypatch.setattr(worker, "_inspection_connections", lambda *_args: [target])
    monkeypatch.setattr(worker, "_restore_command_plan", lambda *_args: (["display version"], {}, None))
    monkeypatch.setattr(worker, "commands_for", lambda *_args: ["display version"])

    def collect(*_args, **_kwargs):
        if cancel_phase == "collect":
            assert lifecycle.cancel_inspection("default", task["task_id"]) is True
        return {"ok": True, "read_ok": True, "output": {"display version": "synthetic output"},
                "command_results": [{"command": "display version", "complete": True}], "target": target}

    def save_evidence(*_args):
        if cancel_phase == "evidence":
            assert lifecycle.cancel_inspection("default", task["task_id"]) is True
        return "art_evidence"

    monkeypatch.setattr(worker, "collect_connection", collect)
    monkeypatch.setattr(worker, "_save_evidence_artifact", save_evidence)
    monkeypatch.setattr(worker, "_derive_findings", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(worker, "record_inspection_observation", lambda *_args: {"observation_id": "obs_evidence"})
    run_job("default", job.job_id)
    finished = worker.get_inspection("default", task["task_id"])
    assert finished["status"] == "cancelled"
    assert finished["completed"] == finished["succeeded"] == 1
    assert finished["results"]["c1"]["status"] == "succeeded"
    assert finished["results"]["c1"]["output_hash"]
    assert finished["artifact_id"] == "art_evidence"
    assert finished["observation_id"] == "obs_evidence"
    assert "job_id" not in finished
    assert "cancel_requested" not in finished
    assert get_job("default", job.job_id) is None


def test_queued_inspection_cancel_cannot_be_restarted_by_stale_worker(monkeypatch, tmp_path):
    import threading
    from extensions.network_operations import network_inspection_lifecycle as lifecycle
    from extensions.network_operations import network_inspections as worker
    from jobs.manager import create_job
    from jobs.store import get_job

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    task = {"task_id": "inspection_queued", "status": "queued", "results": {}, "completed": 0}
    job = create_job("default", "network_inspection", "Queued inspection", {"task_id": task["task_id"]}, enqueue=True)
    task["job_id"] = job.job_id
    worker._store("default").save("inspections", task["task_id"], task)
    assert lifecycle.cancel_inspection("default", task["task_id"])
    cancelled = worker.get_inspection("default", task["task_id"])
    assert cancelled["status"] == "cancelled"
    assert get_job("default", job.job_id) is None
    worker._execute_inspection("default", task["task_id"], [], [],
                               lambda *_args: pytest.fail("must not collect"), threading.Event())
    assert worker.get_inspection("default", task["task_id"]) == cancelled


def test_running_network_inspection_is_hidden_from_task_center(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")

    from backend.main import create_app
    from jobs.manager import create_job

    inspection = create_job(
        "default", "network_inspection", "网络巡检 · 内部步骤", {}, enqueue=False,
        metadata={"task_center_visible": False, "job_role": "internal_inspection"},
    )
    visible = create_job("default", "agent_run", "用户任务", {}, enqueue=False)
    client = create_app().test_client()

    listed = client.get("/api/jobs?workspace_id=default").get_json()["jobs"]
    assert [item["job_id"] for item in listed] == [visible.job_id]

    # The temporary record remains addressable while a worker may still need
    # it for execution or cancellation.
    detail = client.get(f"/api/jobs/{inspection.job_id}?workspace_id=default")
    assert detail.status_code == 200
    assert detail.get_json()["job"]["job_id"] == inspection.job_id


def test_legacy_network_inspection_is_hidden_without_new_metadata(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")

    from backend.main import create_app
    from jobs.manager import create_job

    create_job("default", "network_inspection", "旧网络巡检", {}, enqueue=False)
    client = create_app().test_client()
    assert client.get("/api/jobs?workspace_id=default").get_json()["jobs"] == []


def test_reconcile_hard_deletes_terminal_legacy_inspection_job(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")

    from extensions.network_operations import service
    from jobs.manager import create_job, mark_succeeded
    from jobs.store import get_job

    task = {"task_id": "inspection_legacy", "status": "succeeded", "job_id": ""}
    job = create_job(
        "default", "network_inspection", "旧网络巡检", {"task_id": task["task_id"]}, enqueue=False,
        metadata={"task_center_visible": False, "job_role": "internal_inspection"},
    )
    task["job_id"] = job.job_id
    service._store("default").save("inspections", task["task_id"], task)
    from jobs.manager import mark_running
    mark_running("default", job.job_id)
    mark_succeeded("default", job.job_id)

    service.reconcile_network_state()

    assert get_job("default", job.job_id) is None
    retained = service.get_inspection("default", task["task_id"])
    assert retained["status"] == "succeeded"
    assert "job_id" not in retained
