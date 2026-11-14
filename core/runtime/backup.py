"""Verified filesystem snapshots with atomic, recoverable restore."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import tarfile
import tempfile
import time
import uuid
from typing import Any

from storage.locking import FileLock
from storage.paths import get_workspace_root
from storage.time_utils import now_iso


class BackupError(RuntimeError):
    pass


MAX_BACKUP_FILES = 100_000
MAX_BACKUP_BYTES = 10 * 1024 * 1024 * 1024


def _require_local_data_plane() -> None:
    from storage.backend import backend_mode
    from storage.object_store import object_store_mode

    if backend_mode() not in {"filesystem", "file", "json"} or object_store_mode() != "local":
        raise BackupError("filesystem backup cannot cover PostgreSQL/S3 data; use a data-plane backup tool")


def backup_root() -> Path:
    configured = os.getenv("LZCORE_BACKUP_DIR", "").strip()
    root = Path(configured).expanduser().resolve() if configured else get_workspace_root().parent / ".lzcore-backups"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _data_root() -> Path:
    root = get_workspace_root().resolve()
    if root == Path(root.anchor) or len(root.parts) < 3:
        raise BackupError("unsafe workspace root")
    return root


def _files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    result = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise BackupError(f"workspace snapshot contains a symbolic link: {relative}")
        if path.is_file() and not path.name.endswith(".lock") and ".tmp." not in path.name:
            result.append(path)
    return result


def create_backup(*, retries: int = 3) -> dict[str, Any]:
    _require_local_data_plane()
    root = _data_root()
    destination_root = backup_root()
    backup_id = f"backup-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    destination = destination_root / f"{backup_id}.tar.gz"
    with FileLock(destination_root / "backup.lock", timeout=30):
        for attempt in range(max(1, retries)):
            try:
                return _create_stable_snapshot(root, destination, backup_id)
            except BackupError:
                if attempt + 1 >= max(1, retries):
                    raise
                time.sleep(0.05)
    raise BackupError("backup failed")


def _create_stable_snapshot(root: Path, destination: Path, backup_id: str) -> dict[str, Any]:
    stage = Path(tempfile.mkdtemp(prefix=".backup-stage-", dir=destination.parent))
    try:
        source_files = _files(root)
        if len(source_files) > MAX_BACKUP_FILES:
            raise BackupError("workspace contains too many files for one backup")
        source_names = [path.relative_to(root).as_posix() for path in source_files]
        for name in source_names:
            _safe_member(name)
        if len({name.casefold() for name in source_names}) != len(source_names):
            raise BackupError("backup paths collide on Windows")
        entries: list[dict[str, Any]] = []
        total_bytes = 0
        for source, name in zip(source_files, source_names):
            before = source.stat()
            target = stage / "data" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            with source.open("rb") as input_stream, target.open("wb") as output_stream:
                while chunk := input_stream.read(1024 * 1024):
                    output_stream.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            after = source.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise BackupError(f"workspace changed during snapshot: {name}")
            entries.append({"path": name, "size": size, "sha256": digest.hexdigest()})
            total_bytes += size
            if total_bytes > MAX_BACKUP_BYTES:
                raise BackupError("workspace backup exceeds the configured safety limit")
        if source_names != [path.relative_to(root).as_posix() for path in _files(root)]:
            raise BackupError("workspace file set changed during snapshot")
        from agent import __version__
        manifest = {
            "format": 1,
            "data_sources": {"records": "filesystem", "objects": "local"},
            "backup_id": backup_id,
            "created_at": now_iso(),
            "platform_version": __version__,
            "file_count": len(entries),
            "total_bytes": total_bytes,
            "files": entries,
        }
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary = destination.with_suffix(".tar.gz.tmp")
        try:
            with tarfile.open(temporary, "w:gz") as archive:
                archive.add(stage / "manifest.json", arcname="manifest.json", recursive=False)
                if (stage / "data").exists():
                    archive.add(stage / "data", arcname="data")
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return {**manifest, "size_bytes": destination.stat().st_size, "path": str(destination)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _safe_member(name: str) -> PurePosixPath:
    if not isinstance(name, str) or not name or "\\" in name:
        raise BackupError("unsafe backup path: paths must use forward slashes")
    path = PurePosixPath(name)
    windows = PureWindowsPath(name)
    if (path.is_absolute() or windows.drive or windows.root
            or any(part in {"", ".", ".."} for part in name.split("/"))):
        raise BackupError(f"unsafe backup path: {name}")
    for part in path.parts:
        if (part.endswith((".", " ")) or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
                or PureWindowsPath(part).is_reserved()
                or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part, re.IGNORECASE)):
            raise BackupError(f"unsafe backup path: {name}")
    return path


def verify_backup(archive_path: str | Path) -> dict[str, Any]:
    _require_local_data_plane()
    try:
        archive = tarfile.open(archive_path, "r:gz")
    except (OSError, tarfile.TarError) as exc:
        raise BackupError("invalid backup archive") from exc
    with archive:
        members = archive.getmembers()
        if len(members) > MAX_BACKUP_FILES * 2 + 2 or sum(member.size for member in members if member.isfile()) > MAX_BACKUP_BYTES:
            raise BackupError("backup archive exceeds safety limits")
        names: set[str] = set()
        windows_names: set[str] = set()
        for member in members:
            _safe_member(member.name)
            if member.name.casefold() in windows_names:
                raise BackupError(f"duplicate backup path: {member.name}")
            names.add(member.name)
            windows_names.add(member.name.casefold())
            if not (member.isfile() or member.isdir()):
                raise BackupError("backup links and device files are not allowed")
        try:
            manifest_stream = archive.extractfile("manifest.json")
            manifest = json.loads(manifest_stream.read() if manifest_stream else b"")
        except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise BackupError("invalid backup manifest") from exc
        if not isinstance(manifest, dict) or manifest.get("format") != 1 or not isinstance(manifest.get("files"), list):
            raise BackupError("unsupported backup format")
        if manifest.get("data_sources", {"records": "filesystem", "objects": "local"}) != {"records": "filesystem", "objects": "local"}:
            raise BackupError("backup does not cover a supported local data plane")
        backup_id = manifest.get("backup_id")
        if not isinstance(backup_id, str) or not re.fullmatch(r"backup-[A-Za-z0-9_-]+", backup_id):
            raise BackupError("invalid backup id")
        declared = {str(item.get("path")): item for item in manifest["files"] if isinstance(item, dict)}
        if len(declared) != len(manifest["files"]):
            raise BackupError("backup manifest contains duplicate or invalid file entries")
        actual = {name.removeprefix("data/") for name in names if name.startswith("data/") and name != "data" and archive.getmember(name).isfile()}
        if actual != set(declared):
            raise BackupError("backup file index mismatch")
        if manifest.get("file_count") != len(declared) or int(manifest.get("total_bytes") or 0) != sum(int(item.get("size") or 0) for item in declared.values()):
            raise BackupError("backup manifest totals do not match the file index")
        for name, entry in declared.items():
            _safe_member(name)
            try:
                stream = archive.extractfile(f"data/{name}")
            except KeyError as exc:
                raise BackupError(f"backup file is missing: {name}") from exc
            digest = hashlib.sha256()
            size = 0
            if stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
            if size != int(entry.get("size") or 0) or digest.hexdigest() != entry.get("sha256"):
                raise BackupError(f"backup checksum mismatch: {name}")
        return manifest


def _extract_verified(archive_path: str | Path, manifest: dict[str, Any], data: Path) -> None:
    data.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        for entry in manifest["files"]:
            name = str(entry["path"])
            target = data.joinpath(*_safe_member(name).parts)
            if target.resolve() == data.resolve() or not target.resolve().is_relative_to(data.resolve()):
                raise BackupError("restore target escapes staging directory")
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = archive.extractfile(f"data/{name}")
            with target.open("wb") as output_stream:
                if stream:
                    shutil.copyfileobj(stream, output_stream, length=1024 * 1024)


def _swap_in(data: Path, root: Path, rollback: Path) -> None:
    with FileLock(backup_root() / "restore.lock", timeout=30):
        if rollback.exists():
            raise BackupError("restore rollback path already exists")
        if root.exists():
            os.replace(root, rollback)
        try:
            os.replace(data, root)
        except Exception:
            if rollback.exists() and not root.exists():
                os.replace(rollback, root)
            raise


def restore_backup(archive_path: str | Path, *, confirmation: str) -> dict[str, Any]:
    """Replace the data root immediately. Only for an offline process (CLI)."""
    _require_local_data_plane()
    if confirmation != "RESTORE":
        raise BackupError("restore confirmation is required")
    archive_hash = _file_hash(Path(archive_path))
    manifest = verify_backup(archive_path)
    root = _data_root()
    parent = root.parent
    stage = Path(tempfile.mkdtemp(prefix=".restore-stage-", dir=parent))
    rollback = parent / f".{root.name}-before-{manifest['backup_id']}"
    try:
        data = stage / root.name
        _extract_verified(archive_path, manifest, data)
        if archive_hash != _file_hash(Path(archive_path)):
            raise BackupError("backup archive changed during restore")
        _swap_in(data, root, rollback)
        return {"ok": True, "backup_id": manifest["backup_id"], "restored_at": now_iso(), "rollback_path": str(rollback)}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _pending_marker() -> Path:
    return _data_root().parent / ".lzcore-pending-restore.json"


def stage_restore_backup(archive_path: str | Path, *, confirmation: str) -> dict[str, Any]:
    """Verify and extract a backup beside the data root without touching live data.

    A running service never swaps its own data root: the staged copy is
    applied by :func:`apply_staged_restore` on the next start, before any
    request or background worker can read or write the old tree.
    """
    _require_local_data_plane()
    if confirmation != "RESTORE":
        raise BackupError("restore confirmation is required")
    archive_hash = _file_hash(Path(archive_path))
    manifest = verify_backup(archive_path)
    root = _data_root()
    marker = _pending_marker()
    with FileLock(backup_root() / "restore.lock", timeout=30):
        if marker.exists():
            raise BackupError("a restore is already staged; restart the service to apply it")
        stage = Path(tempfile.mkdtemp(prefix=".restore-pending-", dir=root.parent))
        try:
            _extract_verified(archive_path, manifest, stage / root.name)
            if archive_hash != _file_hash(Path(archive_path)):
                raise BackupError("backup archive changed during restore")
            record = {
                "backup_id": manifest["backup_id"],
                "stage": stage.name,
                "data_root": str(root),
                "archive_sha256": archive_hash,
                "staged_at": now_iso(),
            }
            temporary = marker.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, marker)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
    return {"ok": True, "status": "restart_required", "restart_required": True,
            "backup_id": manifest["backup_id"], "staged_at": record["staged_at"]}


def pending_restore() -> dict[str, Any] | None:
    marker = _pending_marker()
    if not marker.is_file():
        return None
    try:
        record = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"status": "invalid"}
    return {key: record.get(key) for key in ("backup_id", "staged_at")}


def apply_staged_restore() -> dict[str, Any] | None:
    """Apply a staged restore; call only before the service starts serving."""
    marker = _pending_marker()
    if not marker.is_file():
        return None
    root = _data_root()
    record = json.loads(marker.read_text(encoding="utf-8"))
    stage_name = str(record.get("stage") or "")
    backup_id = str(record.get("backup_id") or "")
    if (not re.fullmatch(r"\.restore-pending-[A-Za-z0-9_]+", stage_name)
            or not re.fullmatch(r"backup-[A-Za-z0-9_-]+", backup_id)
            or record.get("data_root") != str(root)):
        raise BackupError("staged restore marker is invalid; remove it after inspection")
    stage = root.parent / stage_name
    data = stage / root.name
    if not data.is_dir():
        raise BackupError("staged restore payload is missing")
    rollback = root.parent / f".{root.name}-before-{backup_id}"
    _swap_in(data, root, rollback)
    marker.unlink()
    shutil.rmtree(stage, ignore_errors=True)
    return {"ok": True, "backup_id": backup_id, "restored_at": now_iso(), "rollback_path": str(rollback)}


def service_instance_lock_path() -> Path:
    """Held by a running backend for its lifetime; offline restore refuses while held."""
    return _data_root().parent / ".runtime" / "backend-instance.lock"


def list_backups() -> list[dict[str, Any]]:
    records = []
    for path in sorted(backup_root().glob("backup-*.tar.gz"), reverse=True):
        try:
            manifest = verify_backup(path)
            records.append({key: manifest.get(key) for key in ("backup_id", "created_at", "platform_version", "file_count", "total_bytes")} | {"size_bytes": path.stat().st_size})
        except BackupError as exc:
            records.append({"backup_id": path.name.removesuffix(".tar.gz"), "status": "invalid", "error": str(exc)})
    return records


def prune_backups(keep: int = 10) -> list[str]:
    keep = max(1, min(int(keep), 100))
    paths = sorted(backup_root().glob("backup-*.tar.gz"), reverse=True)
    removed = []
    for path in paths[keep:]:
        path.unlink()
        removed.append(path.name.removesuffix(".tar.gz"))
    return removed


def backup_path(backup_id: str) -> Path:
    if not backup_id.startswith("backup-") or not all(character.isalnum() or character in {"-", "_"} for character in backup_id):
        raise BackupError("invalid backup id")
    path = backup_root() / f"{backup_id}.tar.gz"
    if not path.is_file():
        raise BackupError("backup not found")
    return path


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
