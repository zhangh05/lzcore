"""Explicit distribution mode, writable data paths and recoverable migration."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from storage.atomic_io import atomic_write_json

DATA_SCHEMA = 1


@dataclass(frozen=True)
class DesktopPaths:
    app: Path
    bundle: Path
    data: Path
    mode: str

    @property
    def workspaces(self):
        return self.data / "workspaces"

    @property
    def config(self):
        return self.data / "config"

    @property
    def runtime(self):
        return self.data / ".runtime"


def resolve_paths(app: Path, bundle: Path, *, frozen=False, data_dir=None, environ=None) -> DesktopPaths:
    env = os.environ if environ is None else environ
    portable = (app / "portable.json").is_file()
    mode = "portable" if portable else ("installed" if frozen else "development")
    explicit = data_dir or env.get("LZCORE_DESKTOP_DATA_DIR")
    if explicit:
        data = Path(explicit).expanduser().resolve()
    elif mode == "installed":
        local = env.get("LOCALAPPDATA")
        if not local:
            raise RuntimeError("Windows user data directory is unavailable")
        data = Path(local) / "LZCore"
    else:
        data = app / "data"
    if data.resolve() in {bundle.resolve(), app.resolve()} or (frozen and bundle.resolve() in data.resolve().parents):
        raise ValueError("The data directory must be separate from program files")
    return DesktopPaths(app.resolve(), bundle.resolve(), data.resolve(), mode)


def prepare_paths(paths: DesktopPaths):
    paths.data.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryFile(dir=paths.data) as probe:
            probe.write(b"lzcore")
            probe.flush()
    except OSError as exc:
        raise RuntimeError("数据目录不可写，请将便携版放到可写目录，或选择其他数据目录。") from exc
    paths.runtime.mkdir(exist_ok=True)
    # Desktop has one explicit data plane; never inherit a developer's paths
    # into a frozen release. Source users can select --data-dir instead.
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(paths.workspaces)
    os.environ["LZCORE_CONFIG_DIR"] = str(paths.config)
    os.environ["LZCORE_DESKTOP_DATA_DIR"] = str(paths.data)
    os.environ["LZCORE_EMBEDDED_WORKER"] = "true"
    os.environ["LZCORE_RUNTIME_BIND_HOST"] = "127.0.0.1"
    os.environ["LZCORE_LISTEN_HOST"] = "127.0.0.1"
    os.environ["WEBVIEW2_USER_DATA_FOLDER"] = str(paths.runtime / "webview2")


def copy_verified(source: Path, destination: Path) -> int:
    """Copy without following links; verify bytes before committing a migration."""
    if source.is_symlink() or not source.is_dir():
        raise ValueError("迁移源必须是普通目录")
    destination.mkdir(parents=True, exist_ok=True)
    count = 0
    for item in sorted(source.rglob("*")):
        if item.is_symlink():
            raise ValueError("Migration cannot follow symbolic links")
        rel = item.relative_to(source)
        target = destination / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif item.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            if file_sha256(item) != file_sha256(target):
                raise OSError("Migration verification failed")
            count += 1
    return count


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def migrate_legacy(paths: DesktopPaths):
    """Copy the adjacent legacy roots once; keep the original as recovery data.

    A journal makes the directory moves repeatable after interruption. An
    existing destination is never merged or overwritten automatically.
    """
    journal = paths.runtime / "legacy-migration.json"
    if journal.is_file():
        state = json.loads(journal.read_text(encoding="utf-8"))
        if state.get("complete"):
            return state
    else:
        roots = [name for name in ("workspaces", "config") if (paths.app / name).is_dir()]
        # A build may contain template config, but no existing workspace.
        if "workspaces" not in roots or paths.workspaces.exists() or paths.config.exists():
            return {"complete": True, "migrated": False}
        state = {"schema": DATA_SCHEMA, "roots": roots, "committed": [], "complete": False}
        atomic_write_json(journal, state)
    stage = paths.runtime / "legacy-migration"
    for name in state["roots"]:
        if name in state["committed"]:
            continue
        target = paths.data / name
        copied = stage / name
        if target.exists():
            # Only accept a move interrupted between rename and journal write.
            if copied.exists() or not (stage / f"{name}.verified").exists():
                raise RuntimeError("迁移目标已有数据，已保留源目录，请在桌面设置中导入。")
        else:
            if copied.exists():
                shutil.rmtree(copied)
            state["files"] = state.get("files", 0) + copy_verified(paths.app / name, copied)
            (stage / f"{name}.verified").write_text("verified", encoding="utf-8")
            copied.replace(target)
        state["committed"].append(name)
        atomic_write_json(journal, state)
    state.update(complete=True, migrated=True)
    atomic_write_json(journal, state)
    return state


def seed_config(paths: DesktopPaths):
    paths.config.mkdir(parents=True, exist_ok=True)
    source = paths.bundle / "config"
    if source.is_dir():
        for item in source.iterdir():
            if item.is_file() and (".example" in item.name or item.name == "logging.yaml"):
                target = paths.config / item.name
                if not target.exists():
                    shutil.copy2(item, target)
