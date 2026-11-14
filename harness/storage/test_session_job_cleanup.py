"""Session lifecycle cleans jobs in the owning principal's repository."""
import pytest
from jobs.schemas import JobRecord, JobEvent
from jobs.store import create_job, get_job, append_event, append_log, _job_dir
from storage.principal import storage_principal
from storage.session_store import ensure_session, update_session, delete_session_permanently


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))


def test_archive_restore_and_hard_delete_are_principal_scoped():
    for principal in ("alice", "bob"):
        with storage_principal(principal):
            ensure_session("session_synthetic", "team")
            for i in range(2):
                create_job(JobRecord(job_id=f"job_synthetic{i}", workspace_id="team", status="running", payload={"session_id": "session_synthetic"}))
    with storage_principal("alice"):
        assert update_session("session_synthetic", "team", status="archived")
        assert all(get_job("team", f"job_synthetic{i}").status == "succeeded" for i in range(2))
        assert update_session("session_synthetic", "team", status="active")["status"] == "active"
        assert delete_session_permanently("session_synthetic", "team", True)
        assert all(get_job("team", f"job_synthetic{i}") is None for i in range(2))
        for writer in (
            lambda: append_event("team", "job_synthetic0", JobEvent()),
            lambda: append_log("team", "job_synthetic0", "late log"),
            lambda: create_job(JobRecord(job_id="job_late", workspace_id="team", payload={"session_id": "session_synthetic"})),
        ):
            with pytest.raises(ValueError):
                writer()
        assert not _job_dir("team", "job_synthetic0").exists()
    with storage_principal("bob"):
        assert get_job("team", "job_synthetic0").status == "running"


def test_archive_cancels_active_turn_instead_of_reporting_success():
    ensure_session("session_synthetic", "team")
    job = create_job(JobRecord(workspace_id="team", status="running", payload={"session_id": "session_synthetic"}, metadata={"active_turn": {"status": "running"}}))
    update_session("session_synthetic", "team", status="archived")
    current = get_job("team", job.job_id)
    assert current.status == "running" and current.cancel_requested is True


def test_job_cleanup_failure_is_retryable_and_not_success(monkeypatch):
    import jobs.store as jobs
    ensure_session("session_synthetic", "team")
    job = create_job(JobRecord(workspace_id="team", payload={"session_id": "session_synthetic"}))
    original = jobs.delete_job
    monkeypatch.setattr(jobs, "delete_job", lambda *_a, **_kw: False)
    assert delete_session_permanently("session_synthetic", "team", True) is False
    assert get_job("team", job.job_id) is not None
    monkeypatch.setattr(jobs, "delete_job", original)
    assert delete_session_permanently("session_synthetic", "team", True) is True
    assert get_job("team", job.job_id) is None


def test_soft_delete_cleans_queued_job_even_after_session_is_hidden():
    ensure_session("session_synthetic", "team")
    job = create_job(JobRecord(workspace_id="team", status="queued", payload={"session_id": "session_synthetic"}))
    update_session("session_synthetic", "team", status="deleted")
    assert get_job("team", job.job_id).status == "cancelled"


def test_archive_api_keeps_active_turn_cancellation(monkeypatch):
    from flask import Flask
    from backend.api import session_routes
    monkeypatch.setattr(session_routes, "_schedule_session_memory_reflection", lambda *_args: None)
    app = Flask(__name__)
    app.add_url_rule("/sessions/<session_id>/archive", view_func=session_routes.handle_session_archive, methods=["POST"])
    with storage_principal("alice"):
        ensure_session("session_synthetic", "team")
        job = create_job(JobRecord(workspace_id="team", status="running", payload={"session_id": "session_synthetic"}, metadata={"active_turn": {"status": "running"}}))
        response = app.test_client().post("/sessions/session_synthetic/archive?workspace_id=team")
        assert response.status_code == 200
        assert response.get_json()["session"]["status"] == "archived"
        current = get_job("team", job.job_id)
        assert current.status == "running" and current.cancel_requested
