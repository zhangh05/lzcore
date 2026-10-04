"""Network inventory domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import time
import uuid
from typing import Any

from extensions.network_operations import device_tools
from extensions.network_operations.device_drivers import SEMANTIC_FACTS
from extensions.network_operations.device_tools import (
    DeviceCredential,
    DeviceTarget,
    normalize_configuration_commands,
    normalize_read_only_commands,
)
from extensions.sdk import ExtensionSecretStore
from storage.locking import FileLock
from storage.time_utils import now_iso

from .network_records import (
    EXTENSION_ID,
    SKILL_BASE_TOOL_ID,
    SKILL_TOOL_IDS,
    _connection_lock,
    _connection_transaction,
    _id,
    _public_connection,
    _store,
    _valid_host,
)
from .network_scripts import _resolve_script


def list_regions(workspace_id: str) -> list[dict[str, Any]]:
    return _store(workspace_id).list("regions", limit=500)


@_connection_transaction
def save_region(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("region name is required and must be at most 80 characters")
    region_id = str(payload.get("region_id") or _id("region"))
    existing = _store(workspace_id).get("regions", region_id) or {}
    parent_id = str(payload.get("parent_id") or "").strip()
    if parent_id and (
        parent_id == region_id or not _store(workspace_id).get("regions", parent_id)
    ):
        raise ValueError("invalid parent region")
    record = {
        "region_id": region_id,
        "name": name,
        "parent_id": parent_id,
        "description": str(payload.get("description") or "").strip()[:300],
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("regions", region_id, record)
    return record


@_connection_transaction
def delete_region(workspace_id: str, region_id: str) -> bool:
    if any(
        str(item.get("region_id") or "") == region_id
        for item in list_devices(workspace_id)
    ):
        raise ValueError("region_has_devices")
    if any(
        str(item.get("parent_id") or "") == region_id
        for item in list_regions(workspace_id)
    ):
        raise ValueError("region_has_children")
    return _store(workspace_id).delete("regions", region_id)


def list_devices(workspace_id: str) -> list[dict[str, Any]]:
    return _store(workspace_id).list("devices", limit=1000)


def get_device(workspace_id: str, device_id: str) -> dict[str, Any] | None:
    try:
        return _store(workspace_id).get("devices", device_id)
    except ValueError:
        # Model-proposed identifiers are data, not a storage exception path.
        return None


def _device_identity(name: str, host: str) -> tuple[str, str]:
    """A management address may expose multiple independently named devices."""
    return (name.strip().casefold(), host.strip().casefold())


@_connection_transaction
def save_device(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    host = str(payload.get("host") or "").strip()
    if not name or not host or not _valid_host(host):
        raise ValueError("valid device name and host are required")
    device_id = str(payload.get("device_id") or _id("device"))
    existing = get_device(workspace_id, device_id) or {}
    region_id = str(payload.get("region_id") or "").strip()
    if region_id and not _store(workspace_id).get("regions", region_id):
        raise ValueError("region_not_found")
    records = list_devices(workspace_id)
    if not existing and len(records) >= 1000:
        raise ValueError("extension_device_quota_exceeded")
    identity = _device_identity(name, host)
    if any(
        item.get("device_id") != device_id
        and _device_identity(str(item.get("name") or ""), str(item.get("host") or ""))
        == identity
        for item in records
    ):
        raise ValueError("device name and host already exist")
    record = {
        "device_id": device_id,
        "name": name,
        "host": host,
        "vendor": str(payload.get("vendor") or "generic").strip().lower(),
        "device_type": str(payload.get("device_type") or "switch").strip().lower(),
        # The role drives a diagram icon; the physical model is user-owned
        # inventory data and intentionally remains independently editable.
        "device_model": str(payload.get("device_model") or "").strip()[:80],
        "region_id": region_id,
        "tags": sorted(
            {
                str(item).strip()
                for item in (payload.get("tags") or [])
                if str(item).strip()
            }
        ),
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("devices", device_id, record)
    identity_changed = bool(existing) and any(
        str(existing.get(key) or "") != str(record.get(key) or "")
        for key in ("host", "vendor")
    )
    if identity_changed:
        for visible in list_connections(workspace_id, device_id=device_id):
            connection_id = str(visible.get("connection_id") or "")
            connection = get_connection(
                workspace_id, connection_id, include_secret=True
            )
            if not connection:
                continue
            connection.update(
                {
                    "revision": uuid.uuid4().hex,
                    "host_key_fingerprint": "",
                    "status": "untested",
                    "last_error": "device_identity_changed_retest_required",
                    "updated_at": now_iso(),
                }
            )
            _store(workspace_id).save("connections", connection_id, connection)
    return record


@_connection_transaction
def delete_device(workspace_id: str, device_id: str) -> bool:
    if not get_device(workspace_id, device_id):
        return False
    deleted_connection_ids = {
        str(connection.get("connection_id") or "")
        for connection in list_connections(workspace_id, device_id=device_id)
    }
    for connection_id in deleted_connection_ids:
        _delete_connection_record(workspace_id, connection_id)
    for skill in list_skills(workspace_id):
        if device_id in set(skill.get("device_ids") or []):
            skill["device_ids"] = [
                item for item in skill.get("device_ids") or [] if item != device_id
            ]
            skill["connection_ids"] = [
                item
                for item in skill.get("connection_ids") or []
                if item not in deleted_connection_ids
            ]
            _save_or_delete_depleted_skill(workspace_id, skill)

    return _store(workspace_id).delete("devices", device_id)


def _raw_connections(workspace_id: str) -> list[dict[str, Any]]:
    return _store(workspace_id).list("connections", limit=2000)


def _connection_identity(record: dict[str, Any]) -> tuple[str, str, int]:
    protocol = str(record.get("protocol") or "ssh").strip().lower()
    default_port = 23 if protocol == "telnet" else 22
    return (
        str(record.get("device_id") or "").strip(),
        protocol,
        int(record.get("port") or default_port),
    )


def _referenced_connection_ids(workspace_id: str) -> set[str]:
    return {
        str(connection_id)
        for skill in list_skills(workspace_id)
        for connection_id in (skill.get("connection_ids") or [])
        if str(connection_id)
    }


def _canonical_connection(
    records: list[dict[str, Any]], referenced: set[str]
) -> dict[str, Any]:
    """Keep the most useful stable record when legacy duplicates exist."""
    return max(
        records,
        key=lambda item: (
            str(item.get("connection_id") or "") in referenced,
            bool(_public_connection(item).get("verified")),
            str(item.get("updated_at") or item.get("created_at") or ""),
            str(item.get("connection_id") or ""),
        ),
    )


def _replace_connection_references(
    workspace_id: str, old_ids: set[str], canonical_id: str
) -> None:
    if not old_ids:
        return
    for skill in list_skills(workspace_id):
        current = [str(item) for item in (skill.get("connection_ids") or [])]
        if not old_ids.intersection(current):
            continue
        skill["connection_ids"] = list(
            dict.fromkeys(canonical_id if item in old_ids else item for item in current)
        )
        skill["updated_at"] = now_iso()
        _store(workspace_id).save("skills", str(skill.get("skill_id") or ""), skill)


def _reconcile_duplicate_connections_unlocked(workspace_id: str) -> int:
    groups: dict[tuple[str, str, int], list[dict[str, Any]]] = {}
    for record in _raw_connections(workspace_id):
        groups.setdefault(_connection_identity(record), []).append(record)
    referenced = _referenced_connection_ids(workspace_id)
    removed = 0
    for records in groups.values():
        if len(records) < 2:
            continue
        canonical = _canonical_connection(records, referenced)
        canonical_id = str(canonical.get("connection_id") or "")
        duplicate_ids = {
            str(item.get("connection_id") or "")
            for item in records
            if str(item.get("connection_id") or "") != canonical_id
        }
        _replace_connection_references(workspace_id, duplicate_ids, canonical_id)
        for duplicate_id in duplicate_ids:
            removed += int(_delete_connection_record(workspace_id, duplicate_id))
    return removed


def reconcile_duplicate_connections(workspace_id: str) -> int:
    """Enforce one logical connection for each device/protocol/port endpoint."""
    with _connection_lock(workspace_id):
        return _reconcile_duplicate_connections_unlocked(workspace_id)


def list_connections(workspace_id: str, *, device_id: str = "") -> list[dict[str, Any]]:
    records = _raw_connections(workspace_id)
    if device_id:
        records = [
            item for item in records if str(item.get("device_id") or "") == device_id
        ]
    return [_public_connection(item) for item in records]


def get_connection(
    workspace_id: str, connection_id: str, *, include_secret: bool = False
) -> dict[str, Any] | None:
    """Return a connection by its canonical id or an unambiguous visible suffix.

    Connection records deliberately use a namespaced canonical id such as
    ``connection_2f64b1865839``. Operators and models frequently retain the
    visible suffix instead. Requiring them to reconstruct the namespace turns
    a valid selected connection into a false ``connection_not_found`` outcome.
    Accept the suffix only when it identifies exactly one registered record;
    ambiguity remains a miss rather than silently choosing a device.
    """
    requested_id = str(connection_id or "").strip()
    if not requested_id:
        return None
    try:
        record = _store(workspace_id).get("connections", requested_id)
    except ValueError:
        record = None
    if not record:
        suffix = requested_id.removeprefix("connection_")
        matches = [
            item
            for item in _raw_connections(workspace_id)
            if str(item.get("connection_id") or "").removeprefix("connection_")
            == suffix
        ]
        record = matches[0] if len(matches) == 1 else None
    if not record:
        return None
    return record if include_secret else _public_connection(record)


def _connection_target(workspace_id: str, connection: dict[str, Any]) -> DeviceTarget:
    device = get_device(workspace_id, str(connection.get("device_id") or ""))
    if not device:
        raise ValueError("connection_device_not_found")
    credential = DeviceCredential(
        auth_method=str(connection.get("auth_method") or "none"),
        username=str(connection.get("username") or ""),
        password=ExtensionSecretStore.get(str(connection.get("password_ref") or "")),
        private_key=ExtensionSecretStore.get(
            str(connection.get("private_key_ref") or "")
        ),
        passphrase=ExtensionSecretStore.get(
            str(connection.get("passphrase_ref") or "")
        ),
    )
    return DeviceTarget(
        host=str(device.get("host") or ""),
        port=int(
            connection.get("port")
            or (23 if connection.get("protocol") == "telnet" else 22)
        ),
        protocol=str(connection.get("protocol") or "ssh"),
        vendor=str(device.get("vendor") or "generic"),
        name=str(device.get("name") or ""),
        source_address=device_tools.resolve_source_address(
            str(device.get("host") or ""),
            str(connection.get("source_address") or ""),
        ),
        expected_fingerprint=str(connection.get("host_key_fingerprint") or ""),
        credential=credential,
    )


def test_connection(
    workspace_id: str,
    connection_id: str,
    *,
    accept_host_key: bool = False,
    read: bool = False,
    configure: bool = False,
    commands: list[str] | None = None,
    facts: list[str] | None = None,
    timeout: int = 15,
    session_scope: str = "",
) -> dict[str, Any]:
    execution_started = time.monotonic()
    with _connection_lock(workspace_id):
        record = get_connection(workspace_id, connection_id, include_secret=True)
        if not record:
            return {"ok": False, "error": "connection_not_found"}
        # ``get_connection`` may have resolved an unambiguous visible suffix.
        # All state writes and Skill checks must use the stored canonical id.
        connection_id = str(record.get("connection_id") or connection_id)
        probe_id = uuid.uuid4().hex
        record["probe_id"] = probe_id
        _store(workspace_id).save("connections", connection_id, record)
    target: DeviceTarget | None = None
    try:
        target = _connection_target(workspace_id, record)
        if commands is not None and facts:
            raise ValueError("commands_and_facts_are_mutually_exclusive")
        normalized_facts = _normalize_semantic_facts(facts) if facts else []
        selected = commands if (read or configure) and not normalized_facts else []
        if configure:
            if read or normalized_facts:
                raise ValueError("configuration_cannot_use_read_or_templates")
            selected = normalize_configuration_commands(selected, target.vendor)
        elif read and not normalized_facts:
            selected = normalize_read_only_commands(selected, target.vendor)
        root = _store(workspace_id).root().resolve()
        endpoint = hashlib.sha256(f"{target.host}:{target.port}".encode()).hexdigest()
        session_options = {}
        if session_scope:
            # root includes principal identity. Revision and target prevent
            # credential/config edits or changed routing from reusing a socket.
            identity = [
                str(root),
                session_scope,
                connection_id,
                record.get("revision"),
                target.host,
                target.port,
                target.source_address,
                target.expected_fingerprint,
            ]
            session_options["session_key"] = hashlib.sha256(
                json.dumps(identity).encode()
            ).hexdigest()
        with FileLock(root / ".cli-locks" / (endpoint + ".lock"), timeout=timeout):
            latest = get_connection(workspace_id, connection_id, include_secret=True)
            if not latest or latest.get("revision") != record.get("revision"):
                raise ValueError("connection_changed_before_execution")
            if configure:
                # Resource authorization is resolved once by device_manage at
                # the tool boundary. This transport layer receives only the
                # already-authorized canonical connection and must not invent a
                # second Skill/configuration gate.
                session_options = {"configure": True}
            remaining = timeout - (time.monotonic() - execution_started)
            if remaining <= 0:
                raise TimeoutError("device_execution_budget_exhausted")
            result = device_tools.probe_target(
                target,
                commands=selected,
                facts=normalized_facts,
                accept_host_key=accept_host_key,
                read=read,
                timeout=remaining,
                **session_options,
            )
    except (ValueError, RuntimeError, OSError) as exc:
        result = {
            "ok": False,
            "status": "failed",
            "error": str(exc)[:300] or "connection_setup_failed",
        }
    fingerprint = str(result.get("fingerprint") or "")
    if fingerprint and accept_host_key and result.get("ok"):
        record["host_key_fingerprint"] = fingerprint
    profile = (
        result.get("device_profile")
        if isinstance(result.get("device_profile"), dict)
        else {}
    )
    connection_observed = bool(result.get("ok") or result.get("command_results"))
    if profile and connection_observed:
        record.update(
            {
                "driver_id": str(profile.get("driver_id") or ""),
                "detected_vendor": str(profile.get("vendor") or ""),
                "os_family": str(profile.get("os_family") or ""),
                "semantic_facts": list(profile.get("semantic_facts") or []),
                "profile_detected_from": str(profile.get("detected_from") or ""),
                "profile_updated_at": now_iso(),
            }
        )
    record.update(
        {
            "status": "connected"
            if connection_observed
            else (
                "trust_required"
                if result.get("requires_host_key_acceptance")
                else "failed"
            ),
            "last_tested_at": now_iso(),
            "last_error": ""
            if result.get("ok")
            else str(result.get("error") or "connection_test_failed")[:300],
            "latency_ms": int(result.get("duration_ms") or 0),
            "effective_source_address": target.source_address
            if target
            else str(record.get("effective_source_address") or ""),
            "updated_at": now_iso(),
        }
    )
    with _connection_lock(workspace_id):
        current = get_connection(workspace_id, connection_id, include_secret=True)
        if not current:
            if configure:
                return {**result, "connection": None, "observation_superseded": True}
            return {
                "ok": False,
                "status": "failed",
                "error": "connection_deleted_during_test",
                "connection": None,
            }
        if current.get("revision") != record.get("revision"):
            if configure:
                return {
                    **result,
                    "connection": _public_connection(current),
                    "observation_superseded": True,
                }
            return {
                "ok": False,
                "status": "failed",
                "error": "connection_changed_during_test",
                "connection": _public_connection(current),
            }
        if current.get("probe_id") != probe_id:
            # A newer probe owns the displayed status, but evidence from this
            # unchanged endpoint remains valid for its requesting tool call.
            return {
                **result,
                "connection": _public_connection(current),
                "observation_superseded": True,
            }
        observation_keys = (
            "status",
            "last_tested_at",
            "last_error",
            "latency_ms",
            "effective_source_address",
            "updated_at",
            "host_key_fingerprint",
            "driver_id",
            "detected_vendor",
            "os_family",
            "semantic_facts",
            "profile_detected_from",
            "profile_updated_at",
        )
        current.update({key: record[key] for key in observation_keys if key in record})
        _store(workspace_id).save("connections", connection_id, current)
        result["connection"] = _public_connection(current)
    return result


def _normalize_semantic_facts(facts: list[str] | tuple[str, ...] | None) -> list[str]:
    if not isinstance(facts, (list, tuple)) or any(
        not isinstance(item, str) for item in facts
    ):
        raise ValueError("facts must be an array of semantic fact names")
    normalized = list(dict.fromkeys(item.strip() for item in facts if item.strip()))
    if not normalized or len(normalized) > 10:
        raise ValueError("facts must contain 1 to 10 semantic fact names")
    unsupported = [item for item in normalized if item not in SEMANTIC_FACTS]
    if unsupported:
        raise ValueError(f"unsupported_semantic_fact:{unsupported[0]}")
    return normalized


def _save_connection_unlocked(
    workspace_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    device_id = str(payload.get("device_id") or "").strip()
    if not get_device(workspace_id, device_id):
        raise ValueError("device_not_found")
    protocol = str(payload.get("protocol") or "ssh").strip().lower()
    if protocol not in {"ssh", "telnet"}:
        raise ValueError("protocol must be ssh or telnet")
    try:
        port = int(payload.get("port") or (23 if protocol == "telnet" else 22))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid port") from exc
    if not 1 <= port <= 65535:
        raise ValueError("invalid port")
    requested_id = str(payload.get("connection_id") or "").strip()
    if requested_id:
        connection_id = requested_id
    else:
        matches = [
            item
            for item in _raw_connections(workspace_id)
            if _connection_identity(item) == (device_id, protocol, port)
        ]
        connection_id = (
            str(
                _canonical_connection(
                    matches, _referenced_connection_ids(workspace_id)
                ).get("connection_id")
                or ""
            )
            if matches
            else _id("connection")
        )
    existing = get_connection(workspace_id, connection_id, include_secret=True) or {}
    if requested_id and not existing:
        raise ValueError("connection_not_found")
    if existing and str(existing.get("device_id") or "") != device_id:
        raise ValueError("connection_device_is_immutable")
    if any(
        item.get("connection_id") != connection_id
        and _connection_identity(item) == (device_id, protocol, port)
        for item in _raw_connections(workspace_id)
    ):
        raise ValueError("connection_endpoint_already_exists")
    auth_method = str(
        payload.get("auth_method")
        or existing.get("auth_method")
        or ("none" if protocol == "telnet" else "password")
    ).lower()
    if auth_method not in (
        {"none", "password"} if protocol == "telnet" else {"password", "private_key"}
    ):
        raise ValueError("invalid auth method for protocol")
    username = str(
        payload.get("username")
        if "username" in payload
        else existing.get("username") or ""
    ).strip()
    source_address = str(
        payload.get("source_address")
        if "source_address" in payload
        else existing.get("source_address") or ""
    ).strip()
    if source_address:
        try:
            ipaddress.ip_address(source_address)
        except ValueError as exc:
            raise ValueError("source_address must be a local IP address") from exc
    if protocol == "ssh" and not username:
        raise ValueError("username is required for ssh")
    secrets = ExtensionSecretStore(EXTENSION_ID, workspace_id)
    password_ref = str(existing.get("password_ref") or "")
    private_key_ref = str(existing.get("private_key_ref") or "")
    passphrase_ref = str(existing.get("passphrase_ref") or "")
    # Reject incomplete auth changes before touching any stored secret.
    if auth_method == "password" and not (password_ref or payload.get("password")):
        raise ValueError("password is required for password authentication")
    if auth_method == "private_key" and not (
        private_key_ref or payload.get("private_key")
    ):
        raise ValueError("private key is required for private-key authentication")
    if payload.get("password"):
        password_ref = secrets.set(
            f"connection_{connection_id}_password", str(payload["password"])
        )
    if payload.get("private_key"):
        private_key_ref = secrets.set(
            f"connection_{connection_id}_key", str(payload["private_key"])
        )
    if payload.get("passphrase"):
        passphrase_ref = secrets.set(
            f"connection_{connection_id}_passphrase", str(payload["passphrase"])
        )
    if auth_method == "none":
        for reference in (password_ref, private_key_ref, passphrase_ref):
            if reference:
                ExtensionSecretStore.delete(reference)
        password_ref = private_key_ref = passphrase_ref = ""
    elif auth_method == "password":
        for reference in (private_key_ref, passphrase_ref):
            if reference:
                ExtensionSecretStore.delete(reference)
        private_key_ref = passphrase_ref = ""
    else:
        if password_ref:
            ExtensionSecretStore.delete(password_ref)
        password_ref = ""
    record = {
        "connection_id": connection_id,
        "revision": uuid.uuid4().hex,
        "device_id": device_id,
        "name": str(
            payload.get("name") or existing.get("name") or protocol.upper()
        ).strip()[:80],
        "protocol": protocol,
        "port": port,
        "username": username,
        "source_address": source_address,
        "auth_method": auth_method,
        "password_ref": password_ref,
        "private_key_ref": private_key_ref,
        "passphrase_ref": passphrase_ref,
        "host_key_fingerprint": str(
            payload.get("host_key_fingerprint")
            or (
                existing.get("host_key_fingerprint")
                if existing
                and _connection_identity(existing) == (device_id, protocol, port)
                else ""
            )
            or ""
        ),
        "status": "untested",
        "last_tested_at": str(existing.get("last_tested_at") or ""),
        "last_error": "",
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("connections", connection_id, record)
    return _public_connection(record)


def save_connection(
    workspace_id: str, payload: dict[str, Any], *, auto_test: bool = True
) -> dict[str, Any]:
    """Create or update a connection by its stable endpoint identity.

    A device may have distinct SSH/Telnet endpoints or ports, but repeated
    submissions for the same ``device + protocol + port`` update the existing
    logical connection instead of creating ambiguous duplicate credentials.
    """
    with _connection_lock(workspace_id):
        record = _save_connection_unlocked(workspace_id, payload)
    if auto_test:
        result = test_connection(workspace_id, str(record.get("connection_id") or ""))
        if result.get("error") in {
            "connection_not_found",
            "connection_deleted_during_test",
            "connection_changed_during_test",
        }:
            raise ValueError(str(result["error"]))
        return result["connection"]
    return record


def _delete_connection_record(workspace_id: str, connection_id: str) -> bool:
    record = get_connection(workspace_id, connection_id, include_secret=True)
    if not record:
        return False
    secret_keys = ("password_ref", "private_key_ref", "passphrase_ref")
    retained_refs = {
        str(item[key])
        for item in _raw_connections(workspace_id)
        if item.get("connection_id") != connection_id
        for key in secret_keys
        if item.get(key)
    }
    for key in secret_keys:
        if record.get(key) and str(record[key]) not in retained_refs:
            ExtensionSecretStore.delete(str(record[key]))
    return _store(workspace_id).delete("connections", connection_id)


def _save_or_delete_depleted_skill(workspace_id: str, skill: dict[str, Any]) -> None:
    if not skill.get("device_ids") or not skill.get("connection_ids"):
        _store(workspace_id).delete("skills", str(skill.get("skill_id") or ""))
        return
    save_skill(workspace_id, skill)


@_connection_transaction
def delete_connection(workspace_id: str, connection_id: str) -> bool:
    if not _delete_connection_record(workspace_id, connection_id):
        return False
    for skill in list_skills(workspace_id):
        if connection_id in set(skill.get("connection_ids") or []):
            skill["connection_ids"] = [
                item
                for item in skill.get("connection_ids") or []
                if item != connection_id
            ]
            _save_or_delete_depleted_skill(workspace_id, skill)
    return True


def _with_skill_base_capability(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize legacy Skill records to the default device-execution contract."""
    return {
        **{
            key: value
            for key, value in record.items()
            if key not in {"capabilities", "topology_id"}
        },
        "allowed_tool_ids": list(
            dict.fromkeys(
                [
                    *(
                        item
                        for item in (record.get("allowed_tool_ids") or [])
                        if item in SKILL_TOOL_IDS
                    ),
                    SKILL_BASE_TOOL_ID,
                    "network.operations.context_read",
                    "network.operations.wait",
                ]
            )
        ),
    }


def list_skills(
    workspace_id: str, *, enabled_only: bool = False
) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("skills", limit=500)
    return [
        _with_skill_base_capability(item)
        for item in records
        if not enabled_only or bool(item.get("enabled", True))
    ]


def get_skill(workspace_id: str, skill_id: str) -> dict[str, Any] | None:
    try:
        record = _store(workspace_id).get("skills", skill_id)
    except ValueError:
        return None
    return _with_skill_base_capability(record) if record else None


@_connection_transaction
def save_skill(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("skill name is required and must be at most 80 characters")
    skill_id = str(payload.get("skill_id") or _id("skill"))
    existing = get_skill(workspace_id, skill_id) or {}
    device_ids = list(
        dict.fromkeys(
            str(item).strip()
            for item in (payload.get("device_ids") or [])
            if str(item).strip()
        )
    )
    connection_ids = list(
        dict.fromkeys(
            str(item).strip()
            for item in (payload.get("connection_ids") or [])
            if str(item).strip()
        )
    )
    if not device_ids or not connection_ids:
        raise ValueError(
            "skill requires at least one device and one configured connection"
        )
    if any(not get_device(workspace_id, item) for item in device_ids):
        raise ValueError("skill contains unknown device")
    connections = [get_connection(workspace_id, item) for item in connection_ids]
    if any(not item for item in connections):
        raise ValueError("skill contains unknown connection")
    if any(
        str(item.get("device_id") or "") not in set(device_ids)
        for item in connections
        if item
    ):
        raise ValueError("skill connection is not owned by a selected device")
    raw_tool_ids = payload.get("allowed_tool_ids", sorted(SKILL_TOOL_IDS))
    if not isinstance(raw_tool_ids, list):
        raise ValueError("skill tools must be an array")
    allowed_tool_ids = list(
        dict.fromkeys(str(item).strip() for item in raw_tool_ids if str(item).strip())
    )
    if any(item not in SKILL_TOOL_IDS for item in allowed_tool_ids):
        raise ValueError("skill contains unsupported tool")
    allowed_tool_ids = _with_skill_base_capability(
        {"allowed_tool_ids": allowed_tool_ids}
    )["allowed_tool_ids"]
    default_script_id = str(payload.get("default_script_id") or "").strip()
    if default_script_id:
        _resolve_script(workspace_id, default_script_id)

    record = {
        "skill_id": skill_id,
        "name": name,
        "description": str(payload.get("description") or "").strip(),
        "enabled": bool(payload.get("enabled", existing.get("enabled", True))),
        "device_ids": device_ids,
        "connection_ids": connection_ids,
        "allowed_tool_ids": allowed_tool_ids,
        # Approval is an optional workflow extension.  It never changes the
        # device account's authority and it is off unless the Skill owner
        # explicitly enables it.
        "approval_enabled": bool(
            payload.get("approval_enabled", existing.get("approval_enabled", False))
        ),
        "default_script_id": default_script_id,
        "instructions": str(payload.get("instructions") or "").strip(),
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("skills", skill_id, record)
    return record


@_connection_transaction
def delete_skill(workspace_id: str, skill_id: str) -> bool:
    return _store(workspace_id).delete("skills", skill_id)


def workbench_skill_catalog(workspace_id: str) -> list[dict[str, Any]]:
    """Project device Skills into the workbench catalog.

    Drawing Skills stay off this list. The topology page binds ``drawing:<id>``
    itself so a device conversation cannot be mixed with a drawing conversation.
    """
    devices = {
        str(item.get("device_id") or ""): item for item in list_devices(workspace_id)
    }
    connections = list_connections(workspace_id)
    catalog: list[dict[str, Any]] = []
    for skill in list_skills(workspace_id, enabled_only=True):
        allowed_connections = set(skill.get("connection_ids") or [])
        configured_devices = {
            str(item.get("device_id") or "")
            for item in connections
            if item.get("connection_id") in allowed_connections
        }
        resources = [
            {
                "resource_id": device_id,
                "name": str(devices[device_id].get("name") or device_id),
                "description": str(devices[device_id].get("host") or ""),
                "kind": "network_device",
            }
            for device_id in skill.get("device_ids") or []
            if device_id in devices and device_id in configured_devices
        ]
        if resources:
            catalog.append(
                {
                    "skill_id": str(skill.get("skill_id") or ""),
                    "name": str(skill.get("name") or ""),
                    "description": str(skill.get("description") or ""),
                    "resources": resources,
                    "default_resource_ids": [item["resource_id"] for item in resources],
                    "selection_mode": "multiple",
                }
            )
    return catalog
