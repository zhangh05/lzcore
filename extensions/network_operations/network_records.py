"""Network records domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import ipaddress
import re
import uuid
from functools import wraps
from typing import Any

from extensions.sdk import ExtensionDataStore
from storage.locking import FileLock

EXTENSION_ID = "network.operations"


SKILL_BASE_TOOL_ID = "network.operations.device.manage"


SKILL_TOOL_IDS = frozenset(
    {
        "network.operations.devices_read",
        "network.operations.skills_read",
        "network.operations.context_read",
        "network.operations.device.manage",
        "network.operations.wait",
        "network.operations.inspection",
    }
)


INTERNAL_SCAN_LIMIT = 5000


def _store(workspace_id: str) -> ExtensionDataStore:
    return ExtensionDataStore(EXTENSION_ID, workspace_id)


def _connection_lock(workspace_id: str) -> FileLock:
    """Serialize endpoint identity changes across workers and processes."""
    return FileLock(_store(workspace_id).root() / ".connections.lock", timeout=10.0)


def _connection_transaction(func):
    """Serialize related device, connection and Skill mutations, never network IO."""

    @wraps(func)
    def mutate(workspace_id, *args, **kwargs):
        with _connection_lock(workspace_id):
            return func(workspace_id, *args, **kwargs)

    return mutate


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _public_connection(record: dict[str, Any]) -> dict[str, Any]:
    item = {
        key: value
        for key, value in record.items()
        if not key.endswith("_ref") and key not in {"revision", "probe_id"}
    }
    item["credential_configured"] = bool(
        record.get("password_ref")
        or record.get("private_key_ref")
        or record.get("auth_method") == "none"
    )
    item["verified"] = str(record.get("status") or "") == "connected"
    return item


def _valid_host(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", host)
        )


def list_inspections(workspace_id: str) -> list[dict[str, Any]]:
    return _store(workspace_id).list("inspections", limit=200)


def get_inspection(workspace_id: str, task_id: str) -> dict[str, Any] | None:
    return _store(workspace_id).get("inspections", task_id)
