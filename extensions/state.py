"""Durable lifecycle and health state for installed extensions."""

from __future__ import annotations

from typing import Any, Callable
import json

from storage.atomic_io import atomic_write_json
from storage.locking import FileLock
from storage.records import runtime_record_file
from storage.time_utils import now_iso


def _path():
    return runtime_record_file("extensions", "state.json", create_parent=True)


def _read() -> dict[str, Any]:
    try:
        value = json.loads(_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError("invalid extension lifecycle state")
    return value


def get_extension_state(extension_id: str, *, default_enabled: bool = True) -> dict[str, Any]:
    record = dict(_read().get(extension_id) or {})
    return {
        "extension_id": extension_id,
        "enabled": bool(record.get("enabled", default_enabled)),
        "status": str(record.get("status") or "ready"),
        "failure_count": int(record.get("failure_count") or 0),
        "last_error": str(record.get("last_error") or ""),
        "schema_versions": dict(record.get("schema_versions") or {}),
        "updated_at": str(record.get("updated_at") or ""),
    }


def _mutate_extension_state(extension_id: str, mutate: Callable) -> dict[str, Any]:
    path = _path()
    with FileLock(path.with_name("state.lock")):
        data = _read()
        current = dict(data.get(extension_id) or {})
        mutate(current)
        current["updated_at"] = now_iso()
        data[extension_id] = current
        atomic_write_json(path, data)
    return get_extension_state(extension_id)


def update_extension_state(extension_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    return _mutate_extension_state(extension_id, lambda current: current.update(patch))


def set_extension_enabled(extension_id: str, enabled: bool) -> dict[str, Any]:
    return update_extension_state(extension_id, {
        "enabled": bool(enabled),
        "status": "ready" if enabled else "disabled",
        "failure_count": 0,
        "last_error": "",
    })


def record_extension_success(extension_id: str) -> None:
    def reset(current):
        if current.get("enabled", True) and current.get("status") not in {"disabled", "quarantined"}:
            current.update({"status": "ready", "failure_count": 0, "last_error": ""})
    _mutate_extension_state(extension_id, reset)


def record_extension_failure(extension_id: str, error: str, *, threshold: int = 5) -> dict[str, Any]:
    def increment(current):
        failures = int(current.get("failure_count") or 0) + 1
        current.update({"failure_count": failures, "last_error": str(error)[:500]})
        if failures >= threshold or current.get("status") == "quarantined":
            current.update({"enabled": False, "status": "quarantined"})
        elif current.get("enabled", True):
            current["status"] = "degraded"
    return _mutate_extension_state(extension_id, increment)


def set_workspace_schema_version(extension_id: str, workspace_id: str, version: int) -> dict[str, Any]:
    def set_version(current):
        versions = dict(current.get("schema_versions") or {})
        versions[workspace_id] = max(0, int(version))
        current["schema_versions"] = versions
    return _mutate_extension_state(extension_id, set_version)
