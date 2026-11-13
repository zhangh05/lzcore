"""Desktop backup authentication boundaries use synthetic temporary data only."""

import base64
import hashlib
import json
from pathlib import PurePosixPath
import zipfile

import pytest

from desktop_app import backup


@pytest.mark.parametrize("relative,excluded", [
    ("workspaces/_runtime/local_browser_token", True),
    ("workspaces/users/synthetic/_runtime/local_browser_token", True),
    ("workspaces/_runtime/secrets/encrypted.json", True),
    ("workspaces/synthetic/secrets/dpapi/test.bin", True),
    ("workspaces/synthetic/file.lock", True),
    ("config/credentials.yaml", True),
    ("config/secrets.yaml", True),
    ("config/.env", True),
    ("workspaces/synthetic/history.json", False),
    ("workspaces/synthetic/local_browser_token_notes.txt", False),
    ("config/settings.json", False),
])
def test_backup_file_exclusions(relative, excluded):
    assert backup._excluded_backup_file(PurePosixPath(relative)) is excluded


@pytest.mark.parametrize("include_credentials", [False, True])
def test_backups_exclude_instance_tokens_but_keep_business_data(tmp_path, monkeypatch, include_credentials):
    data = tmp_path / "data"
    business = data / "workspaces/synthetic/history.json"
    business.parent.mkdir(parents=True)
    business.write_bytes(b'{"synthetic": true}')
    token_paths = ["workspaces/_runtime/local_browser_token",
                   "workspaces/users/synthetic/_runtime/local_browser_token"]
    for relative in token_paths:
        path = data / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic-instance-token-do-not-transfer")
    monkeypatch.setattr(backup, "_portable_secrets", lambda _data: {})
    target = tmp_path / "backup.zip"
    password = "synthetic-backup-password" if include_credentials else ""
    result = backup.create_backup(data, target, password=password, include_credentials=include_credentials)
    assert result["encrypted"] is include_credentials
    archive, manifest = backup.read_backup(target, password)
    with archive:
        assert set(manifest["files"]) == {"workspaces/synthetic/history.json"}
        assert archive.read("workspaces/synthetic/history.json") == business.read_bytes()
        assert not set(token_paths) & set(archive.namelist())
        assert all(b"synthetic-instance-token" not in archive.read(name) for name in archive.namelist())


@pytest.mark.parametrize("name", ["workspaces/_runtime/local_browser_token",
                                 "workspaces/users/synthetic/_runtime/local_browser_token"])
@pytest.mark.parametrize("encrypted", [False, True])
@pytest.mark.parametrize("has_local_token", [False, True])
def test_restore_skips_legacy_token_and_preserves_local_token(tmp_path, monkeypatch, name, encrypted, has_local_token):
    entries = {name: b"synthetic-archived-instance-token",
               "workspaces/synthetic/history.json": b'{"synthetic": true}'}
    source = tmp_path / "legacy.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for relative, raw in entries.items():
            archive.writestr(relative, raw)
        archive.writestr("manifest.json", json.dumps({
            "format": "lzcore-backup", "schema": backup.DATA_SCHEMA,
            "includes_credentials": False,
            "files": {relative: {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                      for relative, raw in entries.items()},
        }))
    password = "synthetic-backup-password" if encrypted else ""
    if encrypted:
        salt = b"s" * 16
        source.write_text(json.dumps({
            "format": "lzcore-encrypted-backup", "schema": backup.DATA_SCHEMA,
            "salt": base64.b64encode(salt).decode(),
            "ciphertext": backup._cipher(password, salt).encrypt(source.read_bytes()).decode(),
        }))

    read = zipfile.ZipFile.read

    def guarded_read(archive, member, *args, **kwargs):
        relative = member.filename if isinstance(member, zipfile.ZipInfo) else member
        assert relative != name, "An archived instance token must not even be read"
        return read(archive, member, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "read", guarded_read)
    archive, manifest = backup.read_backup(source, password)
    with archive:
        assert set(manifest["files"]) == {"workspaces/synthetic/history.json"}
    data = tmp_path / "restored"
    local_token = data / name
    if has_local_token:
        local_token.parent.mkdir(parents=True)
        local_token.write_bytes(b"synthetic-current-instance-token")
    result = backup.stage_restore(data, source, password=password)
    assert result["files"] == 1
    stage = data / ".runtime/restore" / result["restore_id"] / "payload"
    assert not (stage / name).exists()
    assert local_token.exists() is has_local_token
    backup.queue_restore(data, result["restore_id"])
    assert backup.apply_pending_restore(data)["restored"] is True
    assert (data / "workspaces/synthetic/history.json").read_bytes() == entries["workspaces/synthetic/history.json"]
    assert local_token.exists() is has_local_token
    if has_local_token:
        assert local_token.read_bytes() == b"synthetic-current-instance-token"
