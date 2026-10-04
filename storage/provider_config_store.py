"""Storage helpers for local LLM provider configuration files."""

from __future__ import annotations

import os
import stat
import re
from pathlib import Path
from typing import Any

from storage.atomic_io import atomic_write_json, atomic_write_text, safe_read_json, safe_read_text
from storage.locking import FileLock


def validate_provider_id(provider_id: str) -> str:
    if not isinstance(provider_id, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", provider_id):
        raise ValueError("invalid provider id")
    if provider_id in {"con", "prn", "aux", "nul"} or re.fullmatch(r"(?:com|lpt)[1-9]", provider_id):
        raise ValueError("reserved provider id")
    return provider_id


def list_provider_ids(providers_dir: Path) -> list[str]:
    ids = []
    for path in ensure_provider_dir(providers_dir).glob("*.json"):
        try:
            validate_provider_id(path.stem)
        except ValueError:
            continue
        if path.is_file() and not path.is_symlink() and isinstance(safe_read_json(path, default=None), dict):
            ids.append(path.stem)
    return sorted(ids)


def ensure_provider_dir(providers_dir: Path) -> Path:
    providers_dir.mkdir(parents=True, exist_ok=True)
    return providers_dir


def provider_config_path(providers_dir: Path, provider_id: str) -> Path:
    path = ensure_provider_dir(providers_dir) / f"{validate_provider_id(provider_id)}.json"
    if path.is_symlink():
        raise ValueError("provider config cannot be a symlink")
    return path


def active_provider_path(providers_dir: Path) -> Path:
    return ensure_provider_dir(providers_dir) / "_active"


def read_provider_config(providers_dir: Path, provider_id: str) -> dict[str, Any] | None:
    data = safe_read_json(provider_config_path(providers_dir, provider_id), default=None)
    return data if isinstance(data, dict) else None


def write_provider_config(providers_dir: Path, provider_id: str, data: dict[str, Any]) -> None:
    path = provider_config_path(providers_dir, provider_id)
    with FileLock(path.with_name(path.name + ".lock")):
        atomic_write_json(path, data)
    try:
        os.chmod(str(path), stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def read_active_provider(providers_dir: Path) -> str:
    return safe_read_text(active_provider_path(providers_dir), default="").strip()


def write_active_provider(providers_dir: Path, provider_id: str) -> None:
    validate_provider_id(provider_id)
    path = active_provider_path(providers_dir)
    with FileLock(path.with_name(path.name + ".lock")):
        atomic_write_text(path, provider_id)


def delete_provider_config(providers_dir: Path, provider_id: str) -> bool:
    path = provider_config_path(providers_dir, provider_id)
    if not path.is_file():
        return False
    with FileLock(path.with_name(path.name + ".lock")):
        if not path.is_file():
            return False
        path.unlink()
    return True
