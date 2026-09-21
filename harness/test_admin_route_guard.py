"""Mutating admin/extension routes must not serve remote callers without auth.

Background: these routes carry no per-route checks and rely on the global
middleware, which is a pass-through when no auth is configured. Combined
with a LAN listener that spells unauthenticated exposure acceptable, backup
and extension lifecycle writes become remotely drivable. The guard below
requires loopback or an authenticated caller for those writes.
"""
from __future__ import annotations


def _unauthenticated_app(monkeypatch, tmp_path):
    for key in (
        "LZCORE_AUTH_ENABLED",
        "LZCORE_API_TOKEN",
        "LZCORE_LOGIN_ENABLED",
        "LZCORE_LOGIN_USERNAME",
        "LZCORE_LOGIN_PASSWORD",
        "LZCORE_IDENTITY_ENABLED",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    from backend.main import create_app
    app = create_app()
    app.config.update(TESTING=True)
    return app


def test_remote_unauthenticated_admin_write_is_denied(monkeypatch, tmp_path):
    app = _unauthenticated_app(monkeypatch, tmp_path)
    response = app.test_client().post(
        "/api/admin/backups/prune",
        json={"keep": 10},
        headers={"Origin": "http://localhost:5273"},
        environ_overrides={"REMOTE_ADDR": "192.168.5.12"},
    )
    assert response.status_code == 403
    body = response.get_json()
    assert body["ok"] is False
    assert body["error"] == "remote_admin_write_denied"


def test_loopback_unauthenticated_admin_write_still_works(monkeypatch, tmp_path):
    app = _unauthenticated_app(monkeypatch, tmp_path)
    response = app.test_client().post(
        "/api/admin/backups/prune",
        json={"keep": 10},
        headers={"Origin": "http://localhost:5273"},
    )
    assert response.status_code == 200
    assert response.get_json()["ok"] is True
