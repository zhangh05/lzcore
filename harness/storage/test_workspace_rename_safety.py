"""ID renaming must not strand durable jobs or their queue receipts."""
from jobs.schemas import JobRecord
from jobs.store import create_job, get_job
from jobs.queue import FileJobQueue
from storage.principal import storage_principal
from storage.paths import workspace_root, workspace_catalog_root
from storage.workspace_store import rename_workspace, update_workspace_state, get_workspace_state


def test_workspace_id_rename_refuses_before_any_data_or_identity_move(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr("storage.principal.known_storage_principals", lambda: ["alice", "bob"])
    for owner in ("alice", "bob"):
        with storage_principal(owner):
            create_job(JobRecord(job_id="job_synthetic", workspace_id="alpha", status="queued"))
    assert rename_workspace("alpha", "beta") == {"ok": False, "error": "workspace_id_rename_requires_offline_migration"}
    assert workspace_catalog_root("alpha").is_dir()
    assert not workspace_catalog_root("beta").exists()
    for owner in ("alice", "bob"):
        with storage_principal(owner):
            assert get_job("alpha", "job_synthetic").workspace_id == "alpha"
            assert not workspace_root("beta").exists()
    receipt = FileJobQueue().claim("worker")
    assert receipt.workspace_id == "alpha"
    with storage_principal(receipt.principal):
        assert get_job(receipt.workspace_id, receipt.job_id) is not None
        update_workspace_state("alpha", {"name": "新的显示名"})
        assert get_workspace_state("alpha")["name"] == "新的显示名"
