"""Release and backup integrity regressions; all payloads are synthetic."""
import hashlib
import io
import json
import os
import tarfile

import pytest

from core.runtime import backup
from deployment import slots


@pytest.fixture(autouse=True)
def local_storage(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_STORAGE_MODE", "filesystem")
    monkeypatch.setenv("LZCORE_RECORD_STORE_MODE", "filesystem")
    monkeypatch.setenv("LZCORE_OBJECT_STORE_MODE", "local")
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_BACKUP_DIR", str(tmp_path / "backups"))


def _stage(tmp_path, version):
    source = tmp_path / ("source-" + version)
    (source / "agent").mkdir(parents=True)
    (source / "frontend" / "dist").mkdir(parents=True)
    (source / "agent" / "__init__.py").write_text(f'__version__ = "{version}"\n')
    (source / "frontend" / "dist" / "index.html").write_text("synthetic frontend")
    slots.stage_release(source, version, root=tmp_path / "slots")
    return tmp_path / "slots" / "releases" / version


@pytest.mark.parametrize("operation", ["activate", "rollback", "retry"])
@pytest.mark.parametrize("damage", ["edit", "add", "delete", "rename", "symlink", "nested_manifest", "version", "invalid_manifest", "legacy_hash"])
def test_damaged_slot_never_changes_links(tmp_path, operation, damage):
    first = _stage(tmp_path, "1.0.0")
    second = _stage(tmp_path, "1.0.1")
    root = tmp_path / "slots"
    slots.activate_release("1.0.0", root=root)
    if operation in {"rollback", "retry"}:
        slots.activate_release("1.0.1", root=root)
    target = first if operation == "rollback" else second
    module = target / "agent" / "__init__.py"
    if damage == "edit":
        module.write_text("raise RuntimeError('damaged')")
    elif damage == "add":
        (target / "extra.py").write_text("extra")
    elif damage == "delete":
        module.unlink()
    elif damage == "rename":
        module.rename(module.with_name("renamed.py"))
    elif damage == "symlink":
        outside = tmp_path / "outside.py"
        outside.write_bytes(module.read_bytes())
        module.unlink()
        module.symlink_to(outside)
    elif damage == "nested_manifest":
        (target / "agent" / "release.json").write_text("not the root manifest")
    else:
        manifest_path = target / "release.json"
        manifest = json.loads(manifest_path.read_text())
        if damage == "version":
            manifest["version"] = "9.9.9"
        elif damage == "legacy_hash":
            manifest.pop("hash_format")
        manifest_path.write_text("[" if damage == "invalid_manifest" else json.dumps(manifest))
    before = {name: os.readlink(root / name) if (root / name).is_symlink() else None
              for name in ("current", "previous")}
    with pytest.raises(slots.ReleaseError):
        if operation == "rollback":
            slots.rollback_release(root=root)
        else:
            slots.activate_release("1.0.1", root=root)
    after = {name: os.readlink(root / name) if (root / name).is_symlink() else None
             for name in ("current", "previous")}
    assert after == before
    assert not (root / "switch.json").exists()


def test_tree_digest_frames_names_and_contents(tmp_path):
    left, right = tmp_path / "left", tmp_path / "right"
    left.mkdir(); right.mkdir()
    (left / "a").write_bytes(b"bc")
    (right / "ab").write_bytes(b"c")
    assert slots._hash_tree(left) != slots._hash_tree(right)


def test_interrupted_switch_does_not_reactivate_damaged_frozen_slot(tmp_path):
    first = _stage(tmp_path, "1.0.0")
    _stage(tmp_path, "1.0.1")
    root = tmp_path / "slots"
    slots.activate_release("1.0.0", root=root)
    slots.activate_release("1.0.1", root=root)
    before = {name: os.readlink(root / name) for name in ("current", "previous")}
    (root / "switch.json").write_text(json.dumps({"current": "releases/1.0.0", "previous": ""}))
    (first / "agent" / "__init__.py").write_text("damaged")
    with pytest.raises(slots.ReleaseError, match="checksum"):
        slots.activate_release("1.0.1", root=root)
    assert {name: os.readlink(root / name) for name in ("current", "previous")} == before
    assert (root / "switch.json").exists()


def _archive(path, names, **overrides):
    content = b"synthetic backup"
    entries = [{"path": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
               for name in names]
    manifest = {"format": 1, "backup_id": "backup-synthetic", "files": entries,
                "file_count": len(entries), "total_bytes": len(content) * len(entries), **overrides}
    with tarfile.open(path, "w:gz") as archive:
        for name, body in [("manifest.json", json.dumps(manifest).encode()),
                           *(("data/" + name, content) for name in names)]:
            info = tarfile.TarInfo(name)
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return path


@pytest.mark.parametrize("name", [
    "/absolute", "D:/escape", "D:escape", "nested/D:/escape", "../escape", "a/../escape",
    r"a\..\escape", r"\\server\share\escape", "//server/share/escape", "a/./file", "a//file",
    "NUL", "con.txt", "dir/COM1.log", "LPT9", "COM¹", "a/CONIN$", "a/file:stream",
    "a/trailing.", "a/trailing ", "a/b?.txt", "a/b\x01.txt", "", ".",
])
def test_backup_rejects_cross_platform_paths_before_restore_writes(tmp_path, monkeypatch, name):
    archive = _archive(tmp_path / "unsafe.tar.gz", [name])
    with pytest.raises(backup.BackupError):
        backup.verify_backup(archive)
    monkeypatch.setattr(backup.tempfile, "mkdtemp", lambda **kw: pytest.fail("restore staging started"))
    with pytest.raises(backup.BackupError):
        backup.restore_backup(archive, confirmation="RESTORE")


def test_windows_case_collisions_are_rejected(tmp_path):
    archive = _archive(tmp_path / "collision.tar.gz", ["a/file", "a/FILE"])
    with pytest.raises(backup.BackupError, match="duplicate"):
        backup.verify_backup(archive)


def test_backup_rejects_unsafe_manifest_rollback_path(tmp_path):
    archive = _archive(tmp_path / "unsafe-id.tar.gz", [], backup_id="../../escape")
    with pytest.raises(backup.BackupError, match="backup id"):
        backup.restore_backup(archive, confirmation="RESTORE")


@pytest.mark.parametrize("mode", [
    {"LZCORE_RECORD_STORE_MODE": "postgres"}, {"LZCORE_RECORD_STORE_MODE": "postgresql"},
    {"LZCORE_OBJECT_STORE_MODE": "s3"}, {"LZCORE_OBJECT_STORE_MODE": "object"},
    {"LZCORE_RECORD_STORE_MODE": "", "LZCORE_STORAGE_MODE": "postgres"},
    {"LZCORE_OBJECT_STORE_MODE": "", "LZCORE_STORAGE_MODE": "s3"},
])
@pytest.mark.parametrize("has_local_files", [False, True])
def test_remote_data_plane_refuses_create_verify_restore(tmp_path, monkeypatch, mode, has_local_files):
    archive = _archive(tmp_path / "local.tar.gz", [])
    root = tmp_path / "workspaces"
    root.mkdir()
    if has_local_files:
        (root / "local.txt").write_text("partial data")
    for key, value in mode.items():
        monkeypatch.setenv(key, value)
    for operation in [backup.create_backup, lambda: backup.verify_backup(archive),
                      lambda: backup.restore_backup(archive, confirmation="RESTORE")]:
        with pytest.raises(backup.BackupError, match="PostgreSQL/S3"):
            operation()
    assert not (tmp_path / "backups").exists()
    assert (root / "local.txt").exists() == has_local_files


def test_remote_data_source_manifest_is_rejected_even_in_local_mode(tmp_path):
    archive = _archive(tmp_path / "remote.tar.gz", [], data_sources={"records": "postgres", "objects": "s3"})
    with pytest.raises(backup.BackupError, match="data plane"):
        backup.verify_backup(archive)


def test_local_backup_remains_portable_and_restorable(tmp_path):
    source = tmp_path / "workspaces" / "local" / "docs" / "中文.txt"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"original")
    created = backup.create_backup()
    assert backup.verify_backup(created["path"])["data_sources"] == {"records": "filesystem", "objects": "local"}
    source.write_bytes(b"changed")
    assert backup.restore_backup(created["path"], confirmation="RESTORE")["ok"]
    assert source.read_bytes() == b"original"
