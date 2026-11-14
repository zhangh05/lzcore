from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from extensions.network_operations import network_inspections as inspections
from extensions.state import set_extension_enabled
from jobs.manager import create_job, mark_failed
from jobs.runner import run_job
from jobs.store import get_job


@pytest.fixture
def queued(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    task = {"task_id": "inspection_p1", "status": "queued", "connection_ids": ["missing", "good"],
            "script": {"name": "test"}, "results": {}, "completed": 0, "succeeded": 0, "failed": 0, "partial": 0}
    job = create_job("ws", "network_inspection", "test", {"task_id": task["task_id"]}, enqueue=True)
    task["job_id"] = job.job_id
    inspections._store("ws").save("inspections", task["task_id"], task)
    monkeypatch.setattr(inspections, "_restore_command_plan", lambda *_: (["show version"], {}, None))
    monkeypatch.setattr(inspections, "commands_for", lambda *_: ["show version"])
    monkeypatch.setattr(inspections, "_save_evidence_artifact", lambda *_: "art_kept")
    monkeypatch.setattr(inspections, "_derive_findings", lambda *_, **kw: [])
    monkeypatch.setattr(inspections, "record_inspection_observation", lambda *_: {"observation_id": "obs_kept"})
    calls = []

    def resolve(_ws, identifiers):
        if identifiers == ["missing"]:
            raise ValueError("missing_connection")
        return [{"connection_id": key, "name": key, "host": "192.0.2.1"} for key in identifiers]

    def collect(target, *_args, **_kwargs):
        calls.append(target["connection_id"])
        return {"ok": True, "read_ok": True, "output": {"show version": "test"}}

    monkeypatch.setattr(inspections, "_inspection_connections", resolve)
    monkeypatch.setattr(inspections, "collect_connection", collect)
    return task, job, calls


def test_missing_target_fails_independently_and_job_cleanup_preserves_evidence(queued):
    task, job, calls = queued
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert calls == ["good"]
    assert final["status"] == "partial"
    assert final["completed"] == 2 and final["failed"] == final["succeeded"] == 1
    assert final["results"]["missing"]["error"] == "inspection_target_unavailable"
    assert final["artifact_id"] == "art_kept" and not final.get("job_id")
    assert get_job("ws", job.job_id) is None


def test_preflight_failure_gets_business_terminal_state(queued, monkeypatch):
    task, job, calls = queued
    def broken_plan(*_):
        raise ValueError("invalid_plan")
    monkeypatch.setattr(inspections, "_restore_command_plan", broken_plan)
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert final["status"] == "failed" and final["error"] == "inspection_worker_failed"
    assert not final.get("job_id") and not calls


@pytest.mark.parametrize("save_fails", [False, True])
def test_finalizer_saves_terminal_state_before_deleting_recovery_job(queued, monkeypatch, save_fails):
    task, job, _ = queued
    mark_failed("ws", job.job_id, "synthetic failure")
    if save_fails:
        store_type = type(inspections._store("ws"))
        def broken_save(*_):
            raise OSError("disk_full")
        monkeypatch.setattr(store_type, "save", broken_save)
        with pytest.raises(OSError):
            inspections.finalize_inspection_job("ws", task["task_id"], job.job_id)
        assert get_job("ws", job.job_id) is not None
        assert inspections.get_inspection("ws", task["task_id"])["job_id"] == job.job_id
    else:
        assert inspections.finalize_inspection_job("ws", task["task_id"], job.job_id)
        assert inspections.get_inspection("ws", task["task_id"])["status"] == "failed"
        assert get_job("ws", job.job_id) is None


def test_quarantine_cancels_queued_task_before_resolution_or_collection(queued, monkeypatch):
    task, job, calls = queued
    set_extension_enabled("network.operations", False)
    monkeypatch.setattr(inspections, "_inspection_connections", lambda *_: pytest.fail("must not resolve targets"))
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert final["status"] == "cancelled" and final["error"] == "network_extension_disabled"
    assert not calls and get_job("ws", job.job_id) is None


def test_disabling_between_targets_stops_new_collection_and_keeps_completed_evidence(queued, monkeypatch):
    task, job, _ = queued
    task["connection_ids"] = ["first", "second"]
    inspections._store("ws").save("inspections", task["task_id"], task)
    calls = []
    def collect(target, *_args, **_kwargs):
        calls.append(target["connection_id"])
        set_extension_enabled("network.operations", False)
        return {"ok": True, "read_ok": True, "output": {"show version": "test"}}
    monkeypatch.setattr(inspections, "collect_connection", collect)
    monkeypatch.setattr(inspections, "ContextThreadPoolExecutor", lambda **kw: ThreadPoolExecutor(max_workers=1))
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert calls == ["first"]
    assert final["status"] == "cancelled" and final["artifact_id"] == "art_kept"
    assert final["succeeded"] == 1 and final["completed"] == 2


def test_transport_entry_rechecks_lifecycle_before_device_access(queued, monkeypatch):
    from extensions.network_operations import network_execution
    set_extension_enabled("network.operations", False)
    monkeypatch.setattr(network_execution, "test_connection", lambda *_a, **_kw: pytest.fail("must not connect"))
    with pytest.raises(ValueError, match="network_extension_disabled"):
        network_execution.collect_connection({"connection_id": "good", "workspace_id": "ws"}, [])


def test_unreadable_lifecycle_fails_closed_before_device_access(queued, monkeypatch):
    from extensions import state
    from extensions.network_operations import network_execution
    state._path().write_text("invalid-json")
    monkeypatch.setattr(network_execution, "test_connection", lambda *_a, **_kw: pytest.fail("must not connect"))
    with pytest.raises(ValueError):
        network_execution.collect_connection({"connection_id": "good", "workspace_id": "ws"}, [])


def test_rule_timeout_keeps_device_results_and_artifact(queued, monkeypatch):
    task, job, calls = queued
    def timeout(*_, **kw):
        raise inspections.InspectionRuleAnalysisTimeout("rule deadline")
    monkeypatch.setattr(inspections, "_derive_findings", timeout)
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert final["status"] == "failed" and final["error"] == "inspection_rule_analysis_failed"
    assert final["artifact_id"] == "art_kept" and final["completed"] == 2
    assert final["results"]["good"]["status"] == "succeeded" and calls == ["good"]


def test_artifact_lock_timeout_is_reported_as_persistence_failure(queued, monkeypatch):
    task, job, _ = queued
    def timeout(*_):
        raise TimeoutError("synthetic artifact lock timeout")
    monkeypatch.setattr(inspections, "_save_evidence_artifact", timeout)
    run_job("ws", job.job_id)
    final = inspections.get_inspection("ws", task["task_id"])
    assert final["status"] == "failed" and final["error"] == "inspection_evidence_persist_failed"
    assert final["completed"] == 2
