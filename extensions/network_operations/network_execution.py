"""Network execution domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

from typing import Any

from extensions.network_operations import device_tools
from extensions.network_operations.device_tools import (
    DeviceCredential,
    DeviceTarget,
    normalize_read_only_commands,
)
from extensions.sdk import ExtensionSecretStore

from .network_inventory import test_connection
from .network_records import _store


def _safe_asset(record: dict[str, Any]) -> dict[str, Any]:
    item = dict(record)
    item.pop("credential_ref", None)
    item.pop("key_ref", None)
    item.pop("key_passphrase_ref", None)
    item["credential_configured"] = bool(
        record.get("credential_ref") or record.get("key_ref")
    )
    item["host_key_trusted"] = bool(record.get("host_key_fingerprint"))
    return item


def list_assets(workspace_id: str) -> list[dict[str, Any]]:
    return [
        _safe_asset(item) for item in _store(workspace_id).list("assets", limit=1000)
    ]


def get_asset(
    workspace_id: str, asset_id: str, *, include_secret: bool = False
) -> dict[str, Any] | None:
    item = _store(workspace_id).get("assets", asset_id)
    if not item:
        return None
    return item if include_secret else _safe_asset(item)


def commands_for(
    asset: dict[str, Any],
    commands: list[str] | None = None,
    script: dict[str, Any] | None = None,
) -> list[str]:
    vendor = str(asset.get("vendor") or "generic").lower()
    if script:
        vendors = set(script.get("vendors") or [])
        if vendor not in vendors:
            raise ValueError(f"script_not_supported_for_vendor:{vendor}")
        selected = script.get("commands") or []
    else:
        selected = commands
    return normalize_read_only_commands(selected, vendor)


def _target_for(asset: dict[str, Any]) -> DeviceTarget:
    password = ExtensionSecretStore.get(str(asset.get("credential_ref") or ""))
    private_key = ExtensionSecretStore.get(str(asset.get("key_ref") or ""))
    passphrase = ExtensionSecretStore.get(str(asset.get("key_passphrase_ref") or ""))
    auth_method = str(
        asset.get("auth_method") or ("private_key" if private_key else "password")
    ).lower()
    credential = DeviceCredential(
        auth_method=auth_method,
        username=str(asset.get("username") or ""),
        password=password,
        private_key=private_key,
        passphrase=passphrase,
    )
    return DeviceTarget(
        host=str(asset.get("host") or ""),
        port=int(asset.get("port") or 22),
        vendor=str(asset.get("vendor") or "generic"),
        name=str(asset.get("name") or ""),
        expected_fingerprint=str(asset.get("host_key_fingerprint") or ""),
        credential=credential,
    )


def collect_connection(
    asset: dict[str, Any],
    commands: list[str] | None,
    *,
    timeout: int = 15,
    facts: list[str] | None = None,
    session_scope: str = "",
) -> dict[str, Any]:
    """Return the complete execution envelope, not just a lossy text mapping."""
    if asset.get("connection_id"):
        result = test_connection(
            str(asset.get("workspace_id") or ""),
            str(asset.get("connection_id") or ""),
            commands=commands,
            read=True,
            timeout=timeout,
            facts=facts,
            session_scope=session_scope,
        )
        return result
    return device_tools.probe_target(
        _target_for(asset), commands=commands, facts=facts, read=True, timeout=timeout
    )
