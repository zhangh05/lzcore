"""A running backend stages restores; only an offline start applies them."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest


@pytest.fixture
def data(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "data" / "workspaces"))
    monkeypatch.setenv("LZCORE_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    source = tmp_path / "data" / "workspaces" / "default" / "runs" / "run.json"
    source.parent.mkdir(parents=True)
    source.write_text('{"status":"original"}', encoding="utf-8")
    return source


def test_api_restore_only_stages_while_running(data):
    from core.runtime import backup

    created = backup.create_backup()
    data.write_text('{"status":"changed"}', encoding="utf-8")
    from backend.main import create_app
    client = create_app().test_client()
    response = client.post(f"/api/admin/backups/{created['backup_id']}/restore", json={"confirmation": "RESTORE"})
    assert response.status_code == 200, response.json
    assert response.json["restart_required"] is True
    # Live data untouched while the service runs.
    assert json.loads(data.read_text())["status"] == "changed"
    assert backup.pending_restore()["backup_id"] == created["backup_id"]
    again = client.post(f"/api/admin/backups/{created['backup_id']}/restore", json={"confirmation": "RESTORE"})
    assert again.status_code == 409

    # Applying is a pre-start step (see test_backend_start_claims_lock_and_applies_restore):
    # this app's startup threads are live, which is exactly when swapping is unsafe.


def test_staged_marker_cannot_point_outside_the_data_parent(data):
    from core.runtime import backup

    marker = backup._pending_marker()
    marker.write_text(json.dumps({"backup_id": "backup-x", "stage": "../evil",
                                  "data_root": str(backup._data_root())}), encoding="utf-8")
    with pytest.raises(backup.BackupError, match="marker"):
        backup.apply_staged_restore()
    assert json.loads(data.read_text())["status"] == "original"


def test_cli_restore_refuses_while_backend_holds_service_lock(data, monkeypatch):
    from core.runtime.backup import BackupError, service_instance_lock_path
    from storage.locking import FileLock
    from scripts import backup_cli

    monkeypatch.delenv("LZCORE_DESKTOP_DATA_DIR", raising=False)
    calls = []
    monkeypatch.setattr(backup_cli, "restore_backup", lambda *a, **k: calls.append(1))
    lock = service_instance_lock_path()
    lock.parent.mkdir(parents=True, exist_ok=True)
    entered, release = threading.Event(), threading.Event()

    def hold():
        with FileLock(lock):
            entered.set()
            release.wait(5)

    thread = threading.Thread(target=hold)
    thread.start()
    assert entered.wait(3)
    try:
        with pytest.raises(BackupError, match="backend"):
            backup_cli.restore_offline(Path("archive"), confirmation="RESTORE")
        assert calls == []
    finally:
        release.set()
        thread.join(3)
    backup_cli.restore_offline(Path("archive"), confirmation="RESTORE")
    assert calls == [1]


def test_backend_start_claims_lock_and_applies_restore(data, monkeypatch):
    from backend import main as backend_main
    from core.runtime import backup

    created = backup.create_backup()
    data.write_text('{"status":"changed"}', encoding="utf-8")
    backup.stage_restore_backup(created["path"], confirmation="RESTORE")
    monkeypatch.setattr(backend_main, "_SERVICE_LOCK", None)
    backend_main._prepare_service_start()
    try:
        assert json.loads(data.read_text())["status"] == "original"
        assert backend_main._SERVICE_LOCK is not None
        from core.runtime.backup import pending_restore
        assert pending_restore() is None
        assert not list(data.parents[3].glob(".restore-pending-*"))
    finally:
        backend_main._SERVICE_LOCK.__exit__(None, None, None)
