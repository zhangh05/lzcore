"""Workspace-scoped device, Skill authorization and network execution service."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import time
import uuid
from concurrent.futures import as_completed
from functools import wraps
from typing import Any, Callable

from extensions.network_operations.device_tools import (
    DeviceCredential,
    DeviceTarget,
    normalize_read_only_commands,
    normalize_configuration_commands,
    probe_target,
    resolve_source_address,
)
from extensions.network_operations.device_drivers import SEMANTIC_FACTS, semantic_catalog
from extensions.sdk import ExtensionDataStore, ExtensionSecretStore
from storage.locking import FileLock
from storage.principal import ContextThreadPoolExecutor
from storage.time_utils import now_iso


EXTENSION_ID = "network.operations"
SKILL_BASE_TOOL_ID = "network.operations.device.manage"
SKILL_TOOL_IDS = frozenset({
    "network.operations.devices_read",
    "network.operations.skills_read",
    "network.operations.context_read",
    "network.operations.device.manage",
    "network.operations.wait",
    "network.operations.inspection",
    "network.operations.topology",
})
INTERNAL_SCAN_LIMIT = 5000


STARTER_SCRIPTS: tuple[dict[str, Any], ...] = (
    {"script_id": "starter-h3c-health", "name": "H3C 健康巡检", "description": "采集 H3C 设备版本、CPU、内存、接口和日志摘要。", "vendors": ["h3c"], "commands": ["display version", "display cpu-usage", "display memory", "display interface brief", "display logbuffer | include ERROR|WARN"], "checks": [{"check_id": "log-alert", "name": "日志告警关键字", "description": "日志中出现 ERROR、FATAL 或 CRITICAL。", "severity": "medium", "kind": "output_matches", "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b"}], "readonly": True, "builtin": True, "version": 1},
    {"script_id": "starter-huawei-health", "name": "华为健康巡检", "description": "采集华为设备版本、CPU、内存、接口和日志摘要。", "vendors": ["huawei"], "commands": ["display version", "display cpu-usage", "display memory-usage", "display interface brief", "display logbuffer | include ERROR|WARN"], "checks": [{"check_id": "log-alert", "name": "日志告警关键字", "description": "日志中出现 ERROR、FATAL 或 CRITICAL。", "severity": "medium", "kind": "output_matches", "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b"}], "readonly": True, "builtin": True, "version": 1},
    {"script_id": "starter-cisco-health", "name": "Cisco 健康巡检", "description": "采集 Cisco 设备版本、CPU、内存、接口和日志摘要。", "vendors": ["cisco"], "commands": ["show version", "show processes cpu", "show memory statistics", "show ip interface brief", "show logging | include ERROR|WARN"], "checks": [{"check_id": "log-alert", "name": "日志告警关键字", "description": "日志中出现 ERROR、FATAL 或 CRITICAL。", "severity": "medium", "kind": "output_matches", "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b"}], "readonly": True, "builtin": True, "version": 1},
)

def _script_safe(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record.get(key) for key in ("script_id", "name", "description", "vendors", "commands", "checks", "readonly", "builtin", "version", "created_at", "updated_at") if key in record}

def _script_id(value: str) -> str:
    result = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", result):
        raise ValueError("invalid script_id")
    return result

def _ensure_starter_scripts(workspace_id: str) -> None:
    """Create editable per-workspace starter scripts only once.

    The marker deliberately prevents deleted templates from being recreated.
    """
    store = _store(workspace_id)
    if store.get("script_meta", "starter_scripts_initialized"):
        # Older per-workspace starter records predate deterministic health
        # checks.  Only enrich untouched starter records; custom scripts and
        # any user-owned rule set remain exactly as saved.
        for template in STARTER_SCRIPTS:
            existing = store.get("scripts", template["script_id"])
            if existing and existing.get("source") == "starter" and int(existing.get("version") or 0) == 1 and "checks" not in existing:
                existing["checks"] = list(template["checks"])
                existing["updated_at"] = now_iso()
                store.save("scripts", template["script_id"], existing)
        return
    for template in STARTER_SCRIPTS:
        record = {**dict(template), "readonly": True, "builtin": False, "source": "starter", "created_at": now_iso(), "updated_at": now_iso()}
        store.save("scripts", record["script_id"], record)
    store.save("script_meta", "starter_scripts_initialized", {"initialized_at": now_iso()})

def list_inspection_scripts(workspace_id: str) -> list[dict[str, Any]]:
    _ensure_starter_scripts(workspace_id)
    return [_script_safe(item) for item in _store(workspace_id).list("scripts", limit=200)]

def get_inspection_script(workspace_id: str, script_id: str) -> dict[str, Any] | None:
    _ensure_starter_scripts(workspace_id)
    identifier = _script_id(script_id)
    record = _store(workspace_id).get("scripts", identifier)
    return _script_safe(record) if record else None


_CHECK_SEVERITIES = {"low", "medium", "high", "critical"}


def _normalize_checks(value: Any) -> list[dict[str, str]]:
    """Validate deterministic checks without pretending every vendor has one parser.

    A check is deliberately a small, auditable evidence rule.  It never uses an
    LLM or a local heuristic to decide whether an operational condition is
    true: it either matches persisted command output, or it does not.
    """
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError("checks must be an array containing at most 30 items")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("each check must be an object")
        check_id = str(raw.get("check_id") or "").strip()
        name = str(raw.get("name") or "").strip()
        description = str(raw.get("description") or "").strip()
        severity = str(raw.get("severity") or "medium").strip().lower()
        kind = str(raw.get("kind") or "output_matches").strip()
        pattern = str(raw.get("pattern") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", check_id) or check_id in seen:
            raise ValueError("check_id must be unique and use letters, numbers, _ or -")
        if not name or len(name) > 100 or len(description) > 300:
            raise ValueError("check name or description is invalid")
        if severity not in _CHECK_SEVERITIES or kind != "output_matches" or not pattern or len(pattern) > 240:
            raise ValueError("invalid check severity, kind, or pattern")
        try:
            re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise ValueError("invalid check pattern") from exc
        seen.add(check_id)
        normalized.append({"check_id": check_id, "name": name, "description": description, "severity": severity, "kind": kind, "pattern": pattern})
    return normalized

def save_inspection_script(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    script_id = _script_id(str(payload.get("script_id") or _id("script")))
    name = str(payload.get("name") or "").strip()
    description = str(payload.get("description") or "").strip()
    raw_vendors = payload.get("vendors")
    if not isinstance(raw_vendors, list) or any(not isinstance(item, str) for item in raw_vendors):
        raise ValueError("script vendors must be an array")
    vendors = [item.strip().lower() for item in raw_vendors if item.strip()]
    allowed = {"h3c", "huawei", "cisco", "generic"}
    if not name or len(name) > 80: raise ValueError("script name is required and must be at most 80 characters")
    if not vendors or any(item not in allowed for item in vendors): raise ValueError("invalid script vendors")
    raw_commands = payload.get("commands")
    commands = normalize_read_only_commands(raw_commands)
    for vendor in set(vendors):
        normalize_read_only_commands(commands, vendor)
    existing = _store(workspace_id).get("scripts", script_id) or {}
    checks = _normalize_checks(payload["checks"]) if "checks" in payload else list(existing.get("checks") or [])
    record = {"script_id": script_id, "name": name, "description": description[:300], "vendors": sorted(set(vendors)), "commands": commands, "checks": checks, "readonly": True, "builtin": False, "source": str(existing.get("source") or "custom"), "version": int(existing.get("version") or 0) + 1, "created_at": str(existing.get("created_at") or now_iso()), "updated_at": now_iso()}
    _store(workspace_id).save("scripts", script_id, record)
    return _script_safe(record)

def delete_inspection_script(workspace_id: str, script_id: str) -> bool:
    _ensure_starter_scripts(workspace_id)
    return _store(workspace_id).delete("scripts", _script_id(script_id))

def _resolve_script(workspace_id: str, script_id: str | None) -> dict[str, Any] | None:
    if not script_id: return None
    script = get_inspection_script(workspace_id, str(script_id))
    if not script: raise ValueError("inspection_script_not_found")
    return script


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
    item = {key: value for key, value in record.items() if not key.endswith("_ref") and key not in {"revision", "probe_id"}}
    item["credential_configured"] = bool(
        record.get("password_ref") or record.get("private_key_ref") or record.get("auth_method") == "none"
    )
    item["verified"] = str(record.get("status") or "") == "connected"
    return item


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
    if parent_id and (parent_id == region_id or not _store(workspace_id).get("regions", parent_id)):
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
    if any(str(item.get("region_id") or "") == region_id for item in list_devices(workspace_id)):
        raise ValueError("region_has_devices")
    if any(str(item.get("parent_id") or "") == region_id for item in list_regions(workspace_id)):
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
        and _device_identity(str(item.get("name") or ""), str(item.get("host") or "")) == identity
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
        "tags": sorted({str(item).strip() for item in (payload.get("tags") or []) if str(item).strip()}),
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
            connection = get_connection(workspace_id, connection_id, include_secret=True)
            if not connection:
                continue
            connection.update({
                "revision": uuid.uuid4().hex,
                "host_key_fingerprint": "",
                "status": "untested",
                "last_error": "device_identity_changed_retest_required",
                "updated_at": now_iso(),
            })
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
            skill["device_ids"] = [item for item in skill.get("device_ids") or [] if item != device_id]
            skill["connection_ids"] = [
                item for item in skill.get("connection_ids") or [] if item not in deleted_connection_ids
            ]
            _save_or_delete_depleted_skill(workspace_id, skill)
    for topo in list_topologies(workspace_id):
        nodes = topo.get("nodes") or []
        if any(n.get("linked_device_id") == device_id for n in nodes):
            # A drawing belongs to its owner, not the asset register.  Keep
            # the node and links visible; merely sever the optional reference.
            topo["nodes"] = [
                {**node, "linked_device_id": None}
                if node.get("linked_device_id") == device_id else node
                for node in nodes
            ]
            save_topology(workspace_id, topo)
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


def _canonical_connection(records: list[dict[str, Any]], referenced: set[str]) -> dict[str, Any]:
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


def _replace_connection_references(workspace_id: str, old_ids: set[str], canonical_id: str) -> None:
    if not old_ids:
        return
    for skill in list_skills(workspace_id):
        current = [str(item) for item in (skill.get("connection_ids") or [])]
        if not old_ids.intersection(current):
            continue
        skill["connection_ids"] = list(dict.fromkeys(
            canonical_id if item in old_ids else item for item in current
        ))
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
        records = [item for item in records if str(item.get("device_id") or "") == device_id]
    return [_public_connection(item) for item in records]


def get_connection(workspace_id: str, connection_id: str, *, include_secret: bool = False) -> dict[str, Any] | None:
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
            item for item in _raw_connections(workspace_id)
            if str(item.get("connection_id") or "").removeprefix("connection_") == suffix
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
        private_key=ExtensionSecretStore.get(str(connection.get("private_key_ref") or "")),
        passphrase=ExtensionSecretStore.get(str(connection.get("passphrase_ref") or "")),
    )
    return DeviceTarget(
        host=str(device.get("host") or ""),
        port=int(connection.get("port") or (23 if connection.get("protocol") == "telnet" else 22)),
        protocol=str(connection.get("protocol") or "ssh"),
        vendor=str(device.get("vendor") or "generic"),
        name=str(device.get("name") or ""),
        source_address=resolve_source_address(
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
            identity = [str(root), session_scope, connection_id, record.get("revision"),
                        target.host, target.port, target.source_address, target.expected_fingerprint]
            session_options["session_key"] = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
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
            result = probe_target(
                target, commands=selected, facts=normalized_facts,
                accept_host_key=accept_host_key, read=read, timeout=remaining, **session_options,
            )
    except (ValueError, RuntimeError, OSError) as exc:
        result = {"ok": False, "status": "failed", "error": str(exc)[:300] or "connection_setup_failed"}
    fingerprint = str(result.get("fingerprint") or "")
    if fingerprint and accept_host_key and result.get("ok"):
        record["host_key_fingerprint"] = fingerprint
    profile = result.get("device_profile") if isinstance(result.get("device_profile"), dict) else {}
    connection_observed = bool(result.get("ok") or result.get("command_results"))
    if profile and connection_observed:
        record.update({
            "driver_id": str(profile.get("driver_id") or ""),
            "detected_vendor": str(profile.get("vendor") or ""),
            "os_family": str(profile.get("os_family") or ""),
            "semantic_facts": list(profile.get("semantic_facts") or []),
            "profile_detected_from": str(profile.get("detected_from") or ""),
            "profile_updated_at": now_iso(),
        })
    record.update({
        "status": "connected" if connection_observed else ("trust_required" if result.get("requires_host_key_acceptance") else "failed"),
        "last_tested_at": now_iso(),
        "last_error": "" if result.get("ok") else str(result.get("error") or "connection_test_failed")[:300],
        "latency_ms": int(result.get("duration_ms") or 0),
        "effective_source_address": target.source_address if target else str(record.get("effective_source_address") or ""),
        "updated_at": now_iso(),
    })
    with _connection_lock(workspace_id):
        current = get_connection(workspace_id, connection_id, include_secret=True)
        if not current:
            if configure:
                return {**result, "connection": None, "observation_superseded": True}
            return {"ok": False, "status": "failed", "error": "connection_deleted_during_test", "connection": None}
        if current.get("revision") != record.get("revision"):
            if configure:
                return {**result, "connection": _public_connection(current), "observation_superseded": True}
            return {"ok": False, "status": "failed", "error": "connection_changed_during_test", "connection": _public_connection(current)}
        if current.get("probe_id") != probe_id:
            # A newer probe owns the displayed status, but evidence from this
            # unchanged endpoint remains valid for its requesting tool call.
            return {**result, "connection": _public_connection(current), "observation_superseded": True}
        observation_keys = (
            "status", "last_tested_at", "last_error", "latency_ms", "effective_source_address",
            "updated_at", "host_key_fingerprint", "driver_id", "detected_vendor", "os_family",
            "semantic_facts", "profile_detected_from", "profile_updated_at",
        )
        current.update({key: record[key] for key in observation_keys if key in record})
        _store(workspace_id).save("connections", connection_id, current)
        result["connection"] = _public_connection(current)
    return result


def _normalize_semantic_facts(facts: list[str] | tuple[str, ...] | None) -> list[str]:
    if not isinstance(facts, (list, tuple)) or any(not isinstance(item, str) for item in facts):
        raise ValueError("facts must be an array of semantic fact names")
    normalized = list(dict.fromkeys(item.strip() for item in facts if item.strip()))
    if not normalized or len(normalized) > 10:
        raise ValueError("facts must contain 1 to 10 semantic fact names")
    unsupported = [item for item in normalized if item not in SEMANTIC_FACTS]
    if unsupported:
        raise ValueError(f"unsupported_semantic_fact:{unsupported[0]}")
    return normalized


def _save_connection_unlocked(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
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
            item for item in _raw_connections(workspace_id)
            if _connection_identity(item) == (device_id, protocol, port)
        ]
        connection_id = (
            str(_canonical_connection(matches, _referenced_connection_ids(workspace_id)).get("connection_id") or "")
            if matches else _id("connection")
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
    auth_method = str(payload.get("auth_method") or existing.get("auth_method") or ("none" if protocol == "telnet" else "password")).lower()
    if auth_method not in ({"none", "password"} if protocol == "telnet" else {"password", "private_key"}):
        raise ValueError("invalid auth method for protocol")
    username = str(payload.get("username") if "username" in payload else existing.get("username") or "").strip()
    source_address = str(payload.get("source_address") if "source_address" in payload else existing.get("source_address") or "").strip()
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
    if auth_method == "private_key" and not (private_key_ref or payload.get("private_key")):
        raise ValueError("private key is required for private-key authentication")
    if payload.get("password"):
        password_ref = secrets.set(f"connection_{connection_id}_password", str(payload["password"]))
    if payload.get("private_key"):
        private_key_ref = secrets.set(f"connection_{connection_id}_key", str(payload["private_key"]))
    if payload.get("passphrase"):
        passphrase_ref = secrets.set(f"connection_{connection_id}_passphrase", str(payload["passphrase"]))
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
        "name": str(payload.get("name") or existing.get("name") or protocol.upper()).strip()[:80],
        "protocol": protocol,
        "port": port,
        "username": username,
        "source_address": source_address,
        "auth_method": auth_method,
        "password_ref": password_ref,
        "private_key_ref": private_key_ref,
        "passphrase_ref": passphrase_ref,
        "host_key_fingerprint": str(payload.get("host_key_fingerprint") or (
            existing.get("host_key_fingerprint") if existing and _connection_identity(existing) == (device_id, protocol, port) else ""
        ) or ""),
        "status": "untested",
        "last_tested_at": str(existing.get("last_tested_at") or ""),
        "last_error": "",
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("connections", connection_id, record)
    return _public_connection(record)


def save_connection(workspace_id: str, payload: dict[str, Any], *, auto_test: bool = True) -> dict[str, Any]:
    """Create or update a connection by its stable endpoint identity.

    A device may have distinct SSH/Telnet endpoints or ports, but repeated
    submissions for the same ``device + protocol + port`` update the existing
    logical connection instead of creating ambiguous duplicate credentials.
    """
    with _connection_lock(workspace_id):
        record = _save_connection_unlocked(workspace_id, payload)
    if auto_test:
        result = test_connection(workspace_id, str(record.get("connection_id") or ""))
        if result.get("error") in {"connection_not_found", "connection_deleted_during_test", "connection_changed_during_test"}:
            raise ValueError(str(result["error"]))
        return result["connection"]
    return record


def _delete_connection_record(workspace_id: str, connection_id: str) -> bool:
    record = get_connection(workspace_id, connection_id, include_secret=True)
    if not record:
        return False
    secret_keys = ("password_ref", "private_key_ref", "passphrase_ref")
    retained_refs = {
        str(item[key]) for item in _raw_connections(workspace_id)
        if item.get("connection_id") != connection_id
        for key in secret_keys if item.get(key)
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
            skill["connection_ids"] = [item for item in skill.get("connection_ids") or [] if item != connection_id]
            _save_or_delete_depleted_skill(workspace_id, skill)
    return True


def _with_skill_base_capability(record: dict[str, Any]) -> dict[str, Any]:
    """Normalize legacy Skill records to the default device-execution contract."""
    return {
        **{key: value for key, value in record.items() if key != "capabilities"},
        "topology_id": str(record.get("topology_id") or ""),
        "allowed_tool_ids": list(dict.fromkeys([
        *(record.get("allowed_tool_ids") or []), SKILL_BASE_TOOL_ID,
        "network.operations.context_read",
        "network.operations.wait",
        ])),
    }


def list_skills(workspace_id: str, *, enabled_only: bool = False) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("skills", limit=500)
    return [_with_skill_base_capability(item) for item in records if not enabled_only or bool(item.get("enabled", True))]


def get_skill(workspace_id: str, skill_id: str) -> dict[str, Any] | None:
    try:
        record = _store(workspace_id).get("skills", skill_id)
    except ValueError:
        return None
    return _with_skill_base_capability(record) if record else None


def skill_contains_connection(skill: dict[str, Any] | None, connection_id: str) -> bool:
    return bool(
        skill and skill.get("enabled", True)
        and "network.operations.device.manage" in (skill.get("allowed_tool_ids") or [])
        and connection_id in (skill.get("connection_ids") or [])
    )


@_connection_transaction
def save_skill(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("skill name is required and must be at most 80 characters")
    skill_id = str(payload.get("skill_id") or _id("skill"))
    existing = get_skill(workspace_id, skill_id) or {}
    device_ids = list(dict.fromkeys(str(item).strip() for item in (payload.get("device_ids") or []) if str(item).strip()))
    connection_ids = list(dict.fromkeys(str(item).strip() for item in (payload.get("connection_ids") or []) if str(item).strip()))
    if not device_ids or not connection_ids:
        raise ValueError("skill requires at least one device and one configured connection")
    if any(not get_device(workspace_id, item) for item in device_ids):
        raise ValueError("skill contains unknown device")
    connections = [get_connection(workspace_id, item) for item in connection_ids]
    if any(not item for item in connections):
        raise ValueError("skill contains unknown connection")
    if any(str(item.get("device_id") or "") not in set(device_ids) for item in connections if item):
        raise ValueError("skill connection is not owned by a selected device")
    raw_tool_ids = payload.get("allowed_tool_ids", sorted(SKILL_TOOL_IDS))
    if not isinstance(raw_tool_ids, list):
        raise ValueError("skill tools must be an array")
    allowed_tool_ids = list(dict.fromkeys(
        str(item).strip()
        for item in raw_tool_ids
        if str(item).strip()
    ))
    if any(item not in SKILL_TOOL_IDS for item in allowed_tool_ids):
        raise ValueError("skill contains unsupported tool")
    allowed_tool_ids = _with_skill_base_capability({"allowed_tool_ids": allowed_tool_ids})["allowed_tool_ids"]
    default_script_id = str(payload.get("default_script_id") or "").strip()
    if default_script_id:
        _resolve_script(workspace_id, default_script_id)
    topology_id = str(payload.get("topology_id") if "topology_id" in payload else existing.get("topology_id") or "").strip()
    if topology_id and not get_topology(workspace_id, topology_id):
        raise ValueError("skill contains unknown topology")
    # A topology selected for a Skill is only useful when the model can read
    # it.  Do not make the UI remember a hidden capability toggle: bind the
    # canonical topology tool to the association itself, including API and
    # migration callers that do not go through the React form.
    if topology_id and "network.operations.topology" not in allowed_tool_ids:
        allowed_tool_ids.append("network.operations.topology")
    record = {
        "skill_id": skill_id,
        "name": name,
        "description": str(payload.get("description") or "").strip()[:500],
        "enabled": bool(payload.get("enabled", existing.get("enabled", True))),
        "device_ids": device_ids,
        "connection_ids": connection_ids,
        "allowed_tool_ids": allowed_tool_ids,
        # Approval is an optional workflow extension.  It never changes the
        # device account's authority and it is off unless the Skill owner
        # explicitly enables it.
        "approval_enabled": bool(payload.get("approval_enabled", existing.get("approval_enabled", False))),
        "default_script_id": default_script_id,
        "topology_id": topology_id,
        "instructions": str(payload.get("instructions") or "").strip()[:2000],
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("skills", skill_id, record)
    return record


@_connection_transaction
def delete_skill(workspace_id: str, skill_id: str) -> bool:
    return _store(workspace_id).delete("skills", skill_id)


def resolve_workbench_selection(workspace_id: str, selection: dict[str, Any]) -> dict[str, Any]:
    """Resolve authorization and saved metadata only; never contact selected devices."""
    if not isinstance(selection, dict):
        raise ValueError("invalid_workbench_skill_selection")
    with _connection_lock(workspace_id):
        skill_id = str(selection.get("skill_id") or "").strip()
        skill = get_skill(workspace_id, skill_id)
        if not skill or not skill.get("enabled", True):
            raise ValueError("workbench_skill_not_available")
        allowed_devices = set(skill.get("device_ids") or [])
        raw_resources = selection.get("resource_ids") if "resource_ids" in selection else selection.get("device_ids")
        if raw_resources is not None and not isinstance(raw_resources, list):
            raise ValueError("workbench_skill_resources_must_be_an_array")
        if isinstance(raw_resources, list) and len(raw_resources) > 100:
            raise ValueError("workbench_skill_resource_limit_exceeded")
        selected = list(dict.fromkeys(
            str(item).strip()
            for item in (raw_resources or [])
            if str(item).strip()
        ))
        if raw_resources is None:
            selected = list(skill.get("device_ids") or [])
        if not selected or not set(selected).issubset(allowed_devices):
            raise ValueError("workbench_skill_device_forbidden")
        devices = [get_device(workspace_id, item) for item in selected]
        connection_allowlist = set(skill.get("connection_ids") or [])
        visible_connections = {
            str(item.get("connection_id") or ""): item
            for item in list_connections(workspace_id)
            if item.get("connection_id") in connection_allowlist and item.get("device_id") in selected
        }
        connections = [
            visible_connections[connection_id]
            for connection_id in skill.get("connection_ids") or []
            if connection_id in visible_connections
        ]
        if not connections:
            raise ValueError("workbench_skill_has_no_configured_connection")
        topology_summary = None
        topology_id = str(skill.get("topology_id") or "").strip()
        if topology_id:
            topo = get_topology(workspace_id, topology_id)
            if topo:
                topology_summary = {
                    "topology_id": topo["topology_id"],
                    "name": topo["name"],
                    "description": topo.get("description", ""),
                    "version": topo.get("version", 1),
                    "node_count": len(topo.get("nodes") or []),
                    "link_count": len(topo.get("links") or []),
                    "group_count": len(topo.get("groups") or []),
                }
    return {
        "skill_id": skill_id,
        "skill_name": str(skill.get("name") or ""),
        "instructions": str(skill.get("instructions") or ""),
        "allowed_tool_ids": list(skill.get("allowed_tool_ids") or []),
        "approval_enabled": bool(skill.get("approval_enabled", False)),
        "device_ids": selected,
        "connection_ids": [str(item.get("connection_id") or "") for item in connections],
        "connection_policy": "on_demand",
        "topology": topology_summary,
        "devices": [{"device_id": item.get("device_id"), "name": item.get("name"), "host": item.get("host"), "vendor": item.get("vendor")} for item in devices if item],
        "connections": [{
            "connection_id": item.get("connection_id"),
            "device_id": item.get("device_id"),
            "protocol": item.get("protocol"),
            "port": item.get("port"),
            "last_observed_status": str(item.get("status") or "untested"),
            "last_tested_at": str(item.get("last_tested_at") or ""),
            "current_reachability": "not_checked",
            "driver_id": item.get("driver_id"),
            "detected_vendor": item.get("detected_vendor"),
            "os_family": item.get("os_family"),
            "semantic_facts": list(item.get("semantic_facts") or []),
            "profile_detected_from": item.get("profile_detected_from"),
        } for item in connections],
        "semantic_catalog": semantic_catalog(),
        "operational_context": operational_context(
            workspace_id,
            connection_ids=[str(item.get("connection_id") or "") for item in connections],
        ),
        "network_runtime_version": "network.cli.v3",
        "source": "server_validated_extension_context",
    }


def workbench_skill_catalog(workspace_id: str) -> list[dict[str, Any]]:
    """Project network Skills into the domain-neutral workbench catalog."""
    devices = {str(item.get("device_id") or ""): item for item in list_devices(workspace_id)}
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
            catalog.append({
                "skill_id": str(skill.get("skill_id") or ""),
                "name": str(skill.get("name") or ""),
                "description": str(skill.get("description") or ""),
                "resources": resources,
                "default_resource_ids": [item["resource_id"] for item in resources],
                "selection_mode": "multiple",
            })
    return catalog


def _safe_asset(record: dict[str, Any]) -> dict[str, Any]:
    item = dict(record)
    item.pop("credential_ref", None)
    item.pop("key_ref", None)
    item.pop("key_passphrase_ref", None)
    item["credential_configured"] = bool(record.get("credential_ref") or record.get("key_ref"))
    item["host_key_trusted"] = bool(record.get("host_key_fingerprint"))
    return item


def list_assets(workspace_id: str) -> list[dict[str, Any]]:
    return [_safe_asset(item) for item in _store(workspace_id).list("assets", limit=1000)]


def get_asset(workspace_id: str, asset_id: str, *, include_secret: bool = False) -> dict[str, Any] | None:
    item = _store(workspace_id).get("assets", asset_id)
    if not item:
        return None
    return item if include_secret else _safe_asset(item)


def _valid_host(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return bool(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", host))


def commands_for(asset: dict[str, Any], commands: list[str] | None = None, script: dict[str, Any] | None = None) -> list[str]:
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
    auth_method = str(asset.get("auth_method") or ("private_key" if private_key else "password")).lower()
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


def collect_connection(asset: dict[str, Any], commands: list[str] | None, *, timeout: int = 15,
                       facts: list[str] | None = None, session_scope: str = "") -> dict[str, Any]:
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
    return probe_target(_target_for(asset), commands=commands, facts=facts, read=True, timeout=timeout)


def _inspection_assets(workspace_id: str, asset_ids: list[str] | None) -> list[dict[str, Any]]:
    if not isinstance(asset_ids, list) or not asset_ids:
        raise ValueError("asset_ids must be a non-empty array")
    if any(not isinstance(item, str) or not item.strip() for item in asset_ids):
        raise ValueError("asset_ids must contain non-empty strings")
    normalized = [item.strip() for item in asset_ids]
    if len(set(normalized)) != len(normalized):
        raise ValueError("asset_ids must not contain duplicates")
    assets = [get_asset(workspace_id, asset_id, include_secret=True) for asset_id in normalized]
    missing = [asset_id for asset_id, asset in zip(normalized, assets) if asset is None]
    if missing:
        raise ValueError(f"inspection_assets_not_found:{','.join(missing)}")
    return [item for item in assets if item]


def _inspection_connections(workspace_id: str, connection_ids: list[str] | None) -> list[dict[str, Any]]:
    if not isinstance(connection_ids, list) or not connection_ids:
        raise ValueError("connection_ids must be a non-empty array")
    normalized = [str(item).strip() for item in connection_ids]
    if any(not item for item in normalized) or len(set(normalized)) != len(normalized):
        raise ValueError("connection_ids must contain unique non-empty strings")
    targets: list[dict[str, Any]] = []
    for connection_id in normalized:
        connection = get_connection(workspace_id, connection_id)
        if not connection:
            raise ValueError(f"inspection_connection_not_found:{connection_id}")
        device = get_device(workspace_id, str(connection.get("device_id") or ""))
        if not device:
            raise ValueError(f"inspection_connection_device_not_found:{connection_id}")
        targets.append({
            **device,
            "connection_id": connection_id,
            "workspace_id": workspace_id,
            "protocol": connection.get("protocol"),
            "port": connection.get("port"),
        })
    return targets


def _inspection_target_id(target: dict[str, Any]) -> str:
    identifier = str(target.get("connection_id") or target.get("asset_id") or "").strip()
    if not identifier:
        raise ValueError("inspection_target_id_missing")
    return identifier


def _safe_inspection_target(target: dict[str, Any]) -> dict[str, Any]:
    if target.get("connection_id"):
        return {
            key: target.get(key)
            for key in (
                "connection_id", "device_id", "name", "host", "vendor",
                "device_type", "region_id", "protocol", "port",
            )
            if key in target
        }
    return _safe_asset(target)


def _command_plan(
    commands: list[str] | None,
    script: dict[str, Any] | None,
    facts: list[str] | None = None,
) -> dict[str, Any]:
    if script:
        return {"mode": "script", "script": _script_safe(script)}
    if facts:
        return {"mode": "semantic_facts", "facts": _normalize_semantic_facts(facts)}
    if commands is not None:
        return {"mode": "inline_commands", "commands": list(commands)}
    raise ValueError("explicit_commands_facts_or_script_required")


def _restore_command_plan(task: dict[str, Any]) -> tuple[list[str] | None, dict[str, Any] | None, list[str] | None]:
    plan = task.get("command_plan")
    if not isinstance(plan, dict):
        raise ValueError("inspection_command_plan_missing")
    mode = str(plan.get("mode") or "")
    if mode == "script":
        script = plan.get("script")
        if not isinstance(script, dict) or not script.get("script_id"):
            raise ValueError("inspection_script_snapshot_invalid")
        return None, dict(script), None
    if mode == "semantic_facts":
        facts = plan.get("facts")
        if not isinstance(facts, list):
            raise ValueError("inspection_semantic_facts_invalid")
        return None, None, _normalize_semantic_facts(facts)
    if mode == "inline_commands":
        commands = plan.get("commands")
        if not isinstance(commands, list):
            raise ValueError("inspection_inline_commands_invalid")
        return list(commands), None, None
    raise ValueError("inspection_command_plan_invalid")


def _build_inspection_task(
    targets: list[dict[str, Any]],
    commands: list[str] | None,
    script: dict[str, Any] | None,
    *,
    facts: list[str] | None = None,
    job_id: str = "",
) -> dict[str, Any]:
    if sum((commands is not None, script is not None, bool(facts))) != 1:
        raise ValueError("exactly_one_of_commands_facts_or_script_required")
    for target in targets:
        if facts:
            # Validate vocabulary now, but defer vendor command selection to
            # the live session after runtime driver detection.
            _normalize_semantic_facts(facts)
        else:
            commands_for(target, commands, script)
    task_id = _id("inspection")
    is_connection_task = all(bool(item.get("connection_id")) for item in targets)
    target_ids = [_inspection_target_id(item) for item in targets]
    task = {
        "task_id": task_id, "job_id": job_id, "status": "queued",
        "target_kind": "connection" if is_connection_task else "asset",
        # Results remain attributable after an intentional hard delete. These
        # snapshots contain identity and routing metadata, never credentials.
        "target_snapshots": {
            identifier: _safe_inspection_target(item)
            for identifier, item in zip(target_ids, targets)
        },
        "total": len(targets), "completed": 0, "succeeded": 0, "partial": 0, "failed": 0,
        "results": {}, "artifact_id": "",
        "command_plan": _command_plan(commands, script, facts),
        "script": _script_safe(script) if script else {
            "script_id": "semantic-facts" if facts else "inline-commands",
            "name": "语义事实采集" if facts else "临时只读命令",
            "commands": list(commands or []),
            "facts": list(facts or []),
        },
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    if is_connection_task:
        task["connection_ids"] = target_ids
        task["device_ids"] = [str(item.get("device_id") or "") for item in targets]
    else:
        task["asset_ids"] = target_ids
        # Internal legacy tasks keep their historical field without leaking it
        # into the registered-connection path.
        task["asset_snapshots"] = dict(task["target_snapshots"])
    return task


def _new_inspection_task(workspace_id: str, asset_ids: list[str] | None, commands: list[str] | None, script_id: str, *, job_id: str = "") -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    assets = _inspection_assets(workspace_id, asset_ids)
    script = _resolve_script(workspace_id, script_id)
    task = _build_inspection_task(assets, commands, script, job_id=job_id)
    return task, assets, script


def _new_connection_inspection_task(
    workspace_id: str,
    connection_ids: list[str] | None,
    commands: list[str] | None,
    script_id: str,
    *,
    facts: list[str] | None = None,
    job_id: str = "",
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    if commands is not None and facts:
        raise ValueError("commands_and_facts_are_mutually_exclusive")
    targets = _inspection_connections(workspace_id, connection_ids)
    script = _resolve_script(workspace_id, script_id)
    if script and facts:
        raise ValueError("script_and_facts_are_mutually_exclusive")
    task = _build_inspection_task(targets, commands, script, facts=facts, job_id=job_id)
    return task, targets, script


class _DurableCancellation:
    """Cancellation probe backed by the canonical durable job record."""
    def __init__(self, workspace_id: str, job_id: str):
        self.workspace_id = workspace_id
        self.job_id = job_id
    def is_set(self) -> bool:
        from jobs.store import get_job
        job = get_job(self.workspace_id, self.job_id)
        return bool(job and job.cancel_requested)


def _enqueue_prepared_inspection(workspace_id: str, task: dict[str, Any], *, created_by: str) -> dict[str, Any]:
    from jobs.manager import create_job
    job = create_job(
        workspace_id=workspace_id,
        job_type="network_inspection",
        title=f"网络巡检 · {task['script'].get('name') or task['task_id']}",
        payload={"task_id": task["task_id"]},
        created_by=created_by,
        enqueue=False,
        # The job is a worker implementation detail.  Inspection evidence and
        # progress belong to the network extension/workbench, not the user's
        # task centre alongside independently requested tasks.
        metadata={"task_center_visible": False, "job_role": "internal_inspection"},
    )
    task["job_id"] = job.job_id
    _store(workspace_id).save("inspections", task["task_id"], task)
    try:
        from jobs.manager import enqueue_job
        enqueue_job(workspace_id, job.job_id)
    except Exception:
        task.update({"status": "failed", "error": "inspection_enqueue_failed", "finished_at": now_iso(), "updated_at": now_iso()})
        _store(workspace_id).save("inspections", task["task_id"], task)
        raise
    return get_inspection(workspace_id, task["task_id"]) or task


def enqueue_inspection(workspace_id: str, asset_ids: list[str] | None = None, commands: list[str] | None = None, script_id: str = "", *, created_by: str = "user") -> dict[str, Any]:
    """Create a durable inspection task and queue it on the platform Worker."""
    task, _assets, _script = _new_inspection_task(workspace_id, asset_ids, commands, script_id)
    return _enqueue_prepared_inspection(workspace_id, task, created_by=created_by)


def enqueue_connection_inspection(
    workspace_id: str,
    connection_ids: list[str] | None,
    commands: list[str] | None = None,
    script_id: str = "",
    *,
    facts: list[str] | None = None,
    created_by: str = "user",
) -> dict[str, Any]:
    """Create a durable inspection; each target reconnects and fails independently."""
    task, _targets, _script = _new_connection_inspection_task(
        workspace_id, connection_ids, commands, script_id, facts=facts
    )
    return _enqueue_prepared_inspection(workspace_id, task, created_by=created_by)


def execute_queued_inspection(workspace_id: str, task_id: str, job_id: str) -> dict[str, Any]:
    task = get_inspection(workspace_id, task_id)
    if not task:
        raise ValueError("inspection_not_found")
    assets = (
        _inspection_connections(workspace_id, list(task.get("connection_ids") or []))
        if task.get("connection_ids") else
        _inspection_assets(workspace_id, list(task.get("asset_ids") or []))
    )
    commands, script, facts = _restore_command_plan(task)
    cancel = _DurableCancellation(workspace_id, job_id)
    _execute_inspection(workspace_id, task_id, assets, commands, collect_connection, cancel, script, facts)
    return get_inspection(workspace_id, task_id) or task


_INSPECTION_JOB_TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})


def finalize_inspection_job(workspace_id: str, task_id: str, job_id: str) -> bool:
    """Hard-delete a terminal internal Job while preserving inspection evidence."""
    from jobs.store import delete_job, get_job

    job = get_job(workspace_id, job_id)
    if not job or job.job_type != "network_inspection" or job.status not in _INSPECTION_JOB_TERMINAL_STATUSES:
        return False
    task = get_inspection(workspace_id, task_id) if task_id else None
    if task and str(task.get("job_id") or "") == job_id:
        task.pop("job_id", None)
        task.pop("cancel_requested", None)
        task["updated_at"] = now_iso()
        _store(workspace_id).save("inspections", task_id, task)
    return delete_job(workspace_id, job_id, soft=False)


def _execute_inspection(
    workspace_id: str,
    task_id: str,
    targets: list[dict[str, Any]],
    commands: list[str] | None,
    collector: Callable,
    cancel: Any,
    script: dict[str, Any] | None = None,
    facts: list[str] | None = None,
) -> None:
    store = _store(workspace_id)
    task = store.get("inspections", task_id) or {}
    if cancel.is_set():
        task.update({"status": "cancelled", "finished_at": now_iso(), "updated_at": now_iso()})
        store.save("inspections", task_id, task)
        return
    task.update({"status": "running", "started_at": now_iso(), "updated_at": now_iso()})
    store.save("inspections", task_id, task)
    def run_one(target: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        from core.tools.context import bind_runtime_cancel_check, reset_runtime_cancel_check
        target_id = _inspection_target_id(target)
        if cancel.is_set():
            return target_id, {"status": "cancelled", "name": target["name"]}
        started = time.monotonic()
        cancel_token = bind_runtime_cancel_check(cancel.is_set)
        try:
            selected = None if facts else commands_for(target, commands, script)
            live = collector(target, selected, facts=facts, session_scope=task_id)
            if not live.get("ok"):
                raise RuntimeError(str(live.get("error") or "device connection failed"))
            raw = {str(key): str(value) for key, value in (live.get("output") or {}).items()}
            selected = [str(item.get("command") or "") for item in (live.get("command_results") or []) if item.get("command")]
            target_status = "succeeded" if live.get("read_ok") else "partial"
            diagnostics = [
                {key: item.get(key) for key in (
                    "command", "fact", "complete", "pages", "encoding",
                    "error_code", "device_error", "truncated", "duration_ms",
                    "dispatch_status",
                )}
                for item in (live.get("command_results") or [])
            ]
            normalized = json.dumps(raw, ensure_ascii=False, sort_keys=True)
            return target_id, {
                "status": target_status, "name": target["name"], "host": target["host"],
                "commands": selected, "output_hash": hashlib.sha256(normalized.encode()).hexdigest(),
                "facts": live.get("facts"),
                "command_results": diagnostics,
                "_raw_output": raw, "duration_ms": int((time.monotonic() - started) * 1000),
            }
        except Exception as exc:
            return target_id, {
                "status": "failed", "name": target["name"], "host": target["host"],
                "error": str(exc)[:300], "duration_ms": int((time.monotonic() - started) * 1000),
            }
        finally:
            reset_runtime_cancel_check(cancel_token)
    workers = min(5, max(1, len(targets)))
    raw_outputs: dict[str, dict[str, str]] = {}
    with ContextThreadPoolExecutor(max_workers=workers, thread_name_prefix="network-inspection") as pool:
        futures = [pool.submit(run_one, target) for target in targets]
        for future in as_completed(futures):
            target_id, result = future.result()
            raw = result.pop("_raw_output", None)
            if isinstance(raw, dict): raw_outputs[target_id] = raw
            task["results"][target_id] = result
            task["completed"] += 1
            task["succeeded"] += int(result["status"] == "succeeded")
            task["partial"] = int(task.get("partial") or 0) + int(result["status"] == "partial")
            task["failed"] += int(result["status"] == "failed")
            task["updated_at"] = now_iso()
            store.save("inspections", task_id, task)
    task["status"] = (
        "cancelled" if cancel.is_set()
        else "succeeded" if task["failed"] == 0 and int(task.get("partial") or 0) == 0
        else "partial" if task["succeeded"] > 0 or int(task.get("partial") or 0) > 0
        else "failed"
    )
    task["finished_at"] = now_iso()
    task["updated_at"] = now_iso()
    try:
        task["artifact_id"] = _save_evidence_artifact(workspace_id, task, raw_outputs)
        task["findings"] = _derive_findings(workspace_id, task, raw_outputs)
        task["finding_count"] = len(task["findings"])
        observation = record_inspection_observation(workspace_id, task)
        task["observation_id"] = observation["observation_id"]
        task["candidate_reference_id"] = str(observation.get("candidate_reference_id") or "")
        store.save("inspections", task_id, task)
    except Exception:
        task.update({"status": "failed", "error": "inspection_evidence_persist_failed", "finished_at": now_iso(), "updated_at": now_iso()})
        store.save("inspections", task_id, task)
        raise


def _save_evidence_artifact(workspace_id: str, task: dict[str, Any], raw_outputs: dict[str, dict[str, str]]) -> str:
    from artifacts.store import save_artifact
    from core.tools.redaction import redact_tool_output

    # Device observations are the evidence the selected agent must reason over.
    # Store the complete command transcript in an LLM-readable internal
    # artifact, applying only deterministic credential redaction.  Marking the
    # whole transcript ``secret`` made workspace.artifact return a placeholder
    # and silently removed the very evidence needed for diagnosis.
    evidence_payload = redact_tool_output({**task, "raw_outputs": raw_outputs})
    artifact = save_artifact(
        workspace_id=workspace_id,
        content=json.dumps(evidence_payload, ensure_ascii=False, indent=2),
        artifact_type="output_data",
        title=f"网络巡检证据 {task['task_id']}",
        sensitivity="internal",
        module=EXTENSION_ID,
        capability_id="network_inspection",
        metadata={"inspection_task_id": task["task_id"], "evidence_authority": "status_baseline_inspection"},
        tags=["network", "inspection", "evidence"],
        created_by="extension:network.operations",
    )
    return artifact.artifact_id if artifact else ""


def _finding_id(target_id: str, category: str, rule_id: str) -> str:
    digest = hashlib.sha256(f"{target_id}|{category}|{rule_id}".encode()).hexdigest()[:20]
    return f"finding_{digest}"


def _finding_view(record: dict[str, Any]) -> dict[str, Any]:
    """Project a finding without leaking command output or encrypted secrets."""
    allowed = (
        "finding_id", "target_id", "connection_id", "device_id", "target_name", "target_host",
        "asset_id", "asset_name", "asset_host", "category", "rule_id",
        "title", "description", "severity", "status", "first_seen_at", "last_seen_at",
        "last_seen_task_id", "evidence", "occurrences", "state_history", "updated_at",
    )
    return {key: record.get(key) for key in allowed if key in record}


def _upsert_finding(
    workspace_id: str,
    *,
    asset: dict[str, Any],
    category: str,
    rule_id: str,
    title: str,
    description: str,
    severity: str,
    task: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Record an evidence-backed observation while preserving human decisions.

    A re-observed resolved finding becomes open again.  An acknowledged or
    suppressed finding remains in its human-selected state; the new evidence is
    visible through ``last_seen_*`` rather than silently overriding that choice.
    """
    store = _store(workspace_id)
    target_id = _inspection_target_id(asset)
    finding_id = _finding_id(target_id, category, rule_id)
    previous = store.get("findings", finding_id) or {}
    previous_status = str(previous.get("status") or "")
    status = "open" if previous_status in {"", "resolved"} else previous_status
    occurrences = int(previous.get("occurrences") or 0) + 1
    record = {
        **previous,
        "finding_id": finding_id,
        "target_id": target_id,
        "target_name": asset.get("name", ""),
        "target_host": asset.get("host", ""),
        "category": category,
        "rule_id": rule_id,
        "title": title,
        "description": description,
        "severity": severity,
        "status": status,
        "first_seen_at": previous.get("first_seen_at") or now_iso(),
        "last_seen_at": now_iso(),
        "last_seen_task_id": task["task_id"],
        "evidence": evidence,
        "occurrences": occurrences,
        "state_history": list(previous.get("state_history") or []),
        "updated_at": now_iso(),
    }
    if asset.get("connection_id"):
        record["connection_id"] = str(asset.get("connection_id") or "")
        record["device_id"] = str(asset.get("device_id") or "")
        for legacy_key in ("asset_id", "asset_name", "asset_host"):
            record.pop(legacy_key, None)
    else:
        record["asset_id"] = target_id
        record["asset_name"] = asset.get("name", "")
        record["asset_host"] = asset.get("host", "")
    store.save("findings", finding_id, record)
    return _finding_view(record)


def _derive_findings(workspace_id: str, task: dict[str, Any], raw_outputs: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    """Turn a completed read-only inspection into stable, traceable findings."""
    is_connection_task = task.get("target_kind") == "connection" or bool(task.get("connection_ids"))
    current_targets = (
        {}
        if is_connection_task else
        {item["asset_id"]: item for item in list_assets(workspace_id)}
    )
    snapshots = task.get("target_snapshots") if isinstance(task.get("target_snapshots"), dict) else {}
    if not snapshots and isinstance(task.get("asset_snapshots"), dict):
        snapshots = task["asset_snapshots"]
    checks = list((task.get("script") or {}).get("checks") or [])
    baseline = next((item for item in list_baselines(workspace_id) if item.get("current") and item.get("confirmed")), None)
    findings: list[dict[str, Any]] = []
    for target_id, result in sorted((task.get("results") or {}).items()):
        asset = current_targets.get(target_id) or snapshots.get(target_id)
        if not asset:
            continue
        result_status = str(result.get("status") or "")
        evidence = {
            "task_id": task["task_id"],
            "artifact_id": task.get("artifact_id", ""),
            "output_hash": result.get("output_hash", ""),
            "result_status": result_status,
        }
        if result_status == "failed":
            findings.append(_upsert_finding(
                workspace_id, asset=asset, category="connectivity", rule_id="inspection-failed",
                title="设备巡检未完成", description="设备无法完成本次只读巡检；请结合连接阶段和凭据状态人工核查。",
                severity="high", task=task, evidence={**evidence, "error": str(result.get("error") or "")[:240]},
            ))
            continue
        raw = raw_outputs.get(target_id) or {}
        joined_output = "\n".join(f"{command}\n{output}" for command, output in sorted(raw.items()))
        for check in checks:
            if re.search(str(check["pattern"]), joined_output, re.IGNORECASE):
                findings.append(_upsert_finding(
                    workspace_id, asset=asset, category="inspection_rule", rule_id=str(check["check_id"]),
                    title=str(check["name"]), description=str(check["description"]), severity=str(check["severity"]),
                    task=task, evidence={**evidence, "check_id": check["check_id"], "check_version": int((task.get("script") or {}).get("version") or 0)},
                ))
        before = (baseline or {}).get("devices", {}).get(target_id) if baseline else None
        after = {"status": result_status, "output_hash": result.get("output_hash", "")}
        if before is not None and before != after:
            findings.append(_upsert_finding(
                workspace_id, asset=asset, category="baseline_change", rule_id="state-diff",
                title="状态与已确认基线不一致", description="本次巡检输出或设备状态与当前人工确认基线不同；该结果需要人工判断是否为预期变更。",
                severity="medium", task=task, evidence={**evidence, "baseline_id": baseline.get("baseline_id", ""), "before": before, "after": after},
            ))
    return findings


def list_findings(
    workspace_id: str,
    *,
    status: str = "",
    severity: str = "",
    asset_id: str = "",
    limit: int = 200,
) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("findings", limit=max(1, min(limit, 1000)))
    filtered = [record for record in records if (
        (not status or str(record.get("status") or "") == status)
        and (not severity or str(record.get("severity") or "") == severity)
        and (not asset_id or str(record.get("asset_id") or "") == asset_id)
    )]
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    # Stable two-pass ordering: current high-severity findings first, newest
    # evidence first within the same business priority.
    filtered.sort(key=lambda item: str(item.get("last_seen_at") or ""), reverse=True)
    filtered.sort(key=lambda item: (str(item.get("status") or "") not in {"open", "acknowledged"}, severity_rank.get(str(item.get("severity") or ""), 9)))
    return [_finding_view(record) for record in filtered]


def list_inspections(workspace_id: str) -> list[dict[str, Any]]:
    return _store(workspace_id).list("inspections", limit=200)


def get_inspection(workspace_id: str, task_id: str) -> dict[str, Any] | None:
    return _store(workspace_id).get("inspections", task_id)


def retry_inspection(workspace_id: str, task_id: str) -> dict[str, Any]:
    task = get_inspection(workspace_id, task_id)
    if not task or task.get("status") not in {"failed", "cancelled", "partial"}:
        raise ValueError("retryable inspection task is required")
    commands, script, facts = _restore_command_plan(task)
    is_connection_task = bool(task.get("connection_ids"))
    assets = (
        _inspection_connections(workspace_id, list(task.get("connection_ids") or []))
        if is_connection_task else
        _inspection_assets(workspace_id, list(task.get("asset_ids") or []))
    )
    next_task = _build_inspection_task(assets, commands, script, facts=facts)
    retried = _enqueue_prepared_inspection(
        workspace_id,
        next_task,
        created_by="retry",
    )
    retried["retry_of_task_id"] = task_id
    _store(workspace_id).save("inspections", retried["task_id"], retried)
    return retried


def reconcile_network_state() -> int:
    """Explicit startup maintenance: migrate endpoints and reconcile durable jobs.

    Reads never trigger migrations. Each principal/workspace is migrated under
    the same transaction lock used by connection and Skill mutations.
    """
    from backend.core.identity import get_user
    from jobs.store import get_job, list_jobs
    from storage.principal import known_storage_principals, storage_principal
    from storage.workspace_store import list_workspace_ids
    reconciled = 0
    workspace_ids = list_workspace_ids(include_system=False) or ["default"]
    for principal in known_storage_principals() or [""]:
        identity = get_user(principal)
        scoped_workspaces = list(identity.get("workspace_ids") or []) if isinstance(identity, dict) else workspace_ids
        with storage_principal(principal):
            for workspace_id in sorted(set(scoped_workspaces)):
                reconcile_duplicate_connections(workspace_id)
                store = _store(workspace_id)
                for task in store.list("inspections", limit=INTERNAL_SCAN_LIMIT):
                    if task.get("status") not in {"queued", "running"}:
                        continue
                    job_id = str(task.get("job_id") or "")
                    if not job_id:
                        continue
                    job = get_job(workspace_id, job_id)
                    if not job or job.status not in {"failed", "cancelled"}:
                        continue
                    task.update({
                        "status": "cancelled" if job.status == "cancelled" else "failed",
                        "error": "" if job.status == "cancelled" else str(job.error or "backend_restart_during_job"),
                        "finished_at": str(job.finished_at or now_iso()),
                        "updated_at": now_iso(),
                    })
                    store.save("inspections", task["task_id"], task)
                    reconciled += 1
                # Previous releases retained finished worker implementation
                # Jobs. Remove those generic records while preserving the
                # extension-owned inspection and evidence records.
                for job in list_jobs(workspace_id, job_type="network_inspection", limit=INTERNAL_SCAN_LIMIT):
                    if str(job.get("status") or "") not in _INSPECTION_JOB_TERMINAL_STATUSES:
                        continue
                    if finalize_inspection_job(
                        workspace_id,
                        str((job.get("payload") or {}).get("task_id") or ""),
                        str(job.get("job_id") or ""),
                    ):
                        reconciled += 1
    return reconciled


def cancel_inspection(workspace_id: str, task_id: str) -> bool:
    task = get_inspection(workspace_id, task_id)
    if not task or task.get("status") not in {"queued", "running"}:
        return False
    job_id = str(task.get("job_id") or "")
    if job_id:
        try:
            from jobs.manager import cancel_job
            job = cancel_job(workspace_id, job_id)
        except ValueError:
            return False
        task["cancel_requested"] = True
        task["updated_at"] = now_iso()
        if job.status == "cancelled":
            task.update({"status": "cancelled", "finished_at": now_iso()})
        _store(workspace_id).save("inspections", task_id, task)
        if job.status == "cancelled":
            finalize_inspection_job(workspace_id, task_id, job_id)
        return True
    # Historical tasks without a durable job have no live worker to cancel.
    task.update({"status": "cancelled", "finished_at": now_iso()})
    task["cancel_requested"] = True
    task["updated_at"] = now_iso()
    _store(workspace_id).save("inspections", task_id, task)
    return True


def list_baselines(workspace_id: str) -> list[dict[str, Any]]:
    """Read confirmed references while preserving existing stored baselines."""
    references = [
        {
            **item,
            "baseline_id": item["reference_id"],
            "confirmed": item["state"] == "confirmed",
            "devices": dict(item.get("snapshot") or {}),
        }
        for item in list_references(workspace_id)
        if item.get("state") == "confirmed"
    ]
    known = {str(item.get("baseline_id") or "") for item in references}
    legacy = [
        item for item in _store(workspace_id).list("baselines", limit=200)
        if str(item.get("baseline_id") or "") not in known
    ]
    return [*references, *legacy]


@_connection_transaction
def record_command_experience(
    workspace_id: str,
    connection_id: str,
    output: dict[str, Any],
) -> list[dict[str, Any]]:
    """Remember read syntax outcomes as hints, never as an executable plan."""
    profile = output.get("device_profile") if isinstance(output.get("device_profile"), dict) else {}
    driver_id = str(profile.get("driver_id") or "unknown")
    recorded: list[dict[str, Any]] = []
    for item in output.get("command_results") or []:
        if not isinstance(item, dict):
            continue
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        status = "accepted" if item.get("complete") and not item.get("error_code") and not item.get("truncated") else "rejected"
        # Syntax feedback belongs to a driver command, not to one connection.
        # Keeping a connection in the identity made the same `display` command
        # appear once per device in the management UI and made a row deletion
        # look ineffective.  Connection provenance remains an aggregated field.
        key = _command_experience_id(driver_id, command)
        previous = _store(workspace_id).get("command_experience", key) or {}
        previous_connections = {
            str(value) for value in (previous.get("connection_ids") or []) if str(value)
        }
        if previous.get("connection_id"):
            previous_connections.add(str(previous["connection_id"]))
        previous_connections.add(str(connection_id))
        record = {
            "experience_id": key,
            "connection_id": connection_id,
            "connection_ids": sorted(previous_connections),
            "driver_id": driver_id,
            "command": command,
            "status": status,
            "error_code": str(item.get("error_code") or ""),
            "device_error": str(item.get("device_error") or "")[:200],
            "observations": int(previous.get("observations") or 0) + 1,
            "last_observed_at": now_iso(),
            "advisory_only": True,
        }
        _store(workspace_id).save("command_experience", key, record)
        recorded.append(record)
    return recorded


def _normalize_command_experience_command(command: str) -> str:
    """One deterministic identity for command-feedback aggregation."""
    return " ".join(str(command or "").split()).casefold()


def _command_experience_id(driver_id: str, command: str) -> str:
    normalized = _normalize_command_experience_command(command)
    return hashlib.sha256(f"{str(driver_id or 'unknown').casefold()}|{normalized}".encode()).hexdigest()[:24]


def _command_experience_connections(record: dict[str, Any]) -> set[str]:
    values = {str(value) for value in (record.get("connection_ids") or []) if str(value)}
    if record.get("connection_id"):
        values.add(str(record["connection_id"]))
    return values


def list_command_experience(
    workspace_id: str,
    *,
    connection_ids: list[str] | None = None,
    limit: int = 80,
) -> list[dict[str, Any]]:
    allowed = None if connection_ids is None else {str(item) for item in connection_ids if str(item)}
    # Aggregate before applying the display limit.  Otherwise a legacy duplicate
    # near the page boundary could hide a different command altogether.
    records = _store(workspace_id).list("command_experience", limit=INTERNAL_SCAN_LIMIT)
    grouped: dict[str, dict[str, Any]] = {}
    for item in records:
        if not isinstance(item, dict):
            continue
        connections = _command_experience_connections(item)
        if allowed is not None and not connections.intersection(allowed):
            continue
        driver_id = str(item.get("driver_id") or "unknown")
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        experience_id = _command_experience_id(driver_id, command)
        current = grouped.get(experience_id)
        observed_at = str(item.get("last_observed_at") or "")
        if current is None:
            current = {
                **item,
                "experience_id": experience_id,
                "connection_ids": sorted(connections),
                "observations": 0,
            }
            grouped[experience_id] = current
        else:
            current["connection_ids"] = sorted(set(current.get("connection_ids") or []).union(connections))
            if observed_at >= str(current.get("last_observed_at") or ""):
                # Latest real device outcome remains the advisory status.
                current.update({key: value for key, value in item.items() if key not in {"experience_id", "observations", "connection_ids"}})
                current["experience_id"] = experience_id
        current["observations"] = int(current.get("observations") or 0) + int(item.get("observations") or 0)
    result = list(grouped.values())
    result.sort(key=lambda item: str(item.get("last_observed_at") or ""), reverse=True)
    return result[:limit]


def record_inspection_observation(workspace_id: str, task: dict[str, Any]) -> dict[str, Any]:
    """Persist one time-bound observation; never declare that it is normal."""
    from core.runtime_engine.context_contract import normalize_observation_descriptor, normalize_reference_descriptor

    observation_id = _id("observation")
    target_ids = sorted(str(item) for item in (task.get("results") or {}).keys())
    snapshot = {
        target_id: {
            "status": str((task.get("results") or {}).get(target_id, {}).get("status") or "unknown"),
            "output_hash": str((task.get("results") or {}).get(target_id, {}).get("output_hash") or ""),
        }
        for target_id in target_ids
    }
    status = str(task.get("status") or "unknown")
    completeness = "complete" if status == "succeeded" else "partial" if status == "partial" else "failed" if status in {"failed", "cancelled"} else "unknown"
    scope_key = hashlib.sha256("|".join(target_ids).encode()).hexdigest()[:20]
    observation = normalize_observation_descriptor({
        "observation_id": observation_id,
        "source_kind": "network_inspection",
        "source_id": str(task.get("task_id") or ""),
        "artifact_id": str(task.get("artifact_id") or ""),
        "observed_at": str(task.get("finished_at") or now_iso()),
        "completeness": completeness,
        "scope_key": scope_key,
        "target_ids": target_ids,
        "snapshot": snapshot,
        "created_at": now_iso(),
    })
    _store(workspace_id).save("observations", observation_id, observation)
    candidate_id = ""
    if completeness in {"complete", "partial"}:
        candidate_id = _id("reference")
        candidate = normalize_reference_descriptor({
            "reference_id": candidate_id,
            "name": f"巡检候选参考 {str(task.get('task_id') or '')[-8:]}",
            "state": "candidate",
            "authority": "observed",
            "current": False,
            "scope_key": scope_key,
            "target_ids": target_ids,
            "source_observation_ids": [observation_id],
            "snapshot": snapshot,
            "completeness": completeness,
            "created_at": now_iso(),
            "updated_at": now_iso(),
        })
        _store(workspace_id).save("references", candidate_id, candidate)
        observation["candidate_reference_id"] = candidate_id
        _store(workspace_id).save("observations", observation_id, observation)
    return observation


def list_observations(workspace_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("observations", limit=max(1, min(limit, 500)))
    records.sort(key=lambda item: str(item.get("observed_at") or ""), reverse=True)
    return records[:limit]


def list_references(workspace_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("references", limit=max(1, min(limit, 500)))
    records.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
    return records[:limit]


@_connection_transaction
def delete_observation(workspace_id: str, observation_id: str) -> dict[str, Any]:
    """Hard-delete an observation and every reference that depends on it.

    A reference without its source observation is invalid evidence.  Deleting
    one therefore removes those dependent reference records in the same
    workspace transaction; inspection task history and artifacts are retained
    because they are separate execution/audit records.
    """
    store = _store(workspace_id)
    if not store.get("observations", observation_id):
        raise ValueError("observation_not_found")
    deleted_references = 0
    for reference in list_references(workspace_id, limit=INTERNAL_SCAN_LIMIT):
        source_ids = {str(item) for item in reference.get("source_observation_ids") or []}
        if observation_id in source_ids and store.delete("references", str(reference["reference_id"])):
            deleted_references += 1
    store.delete("observations", observation_id)
    return {
        "deleted": True,
        "observation_id": observation_id,
        "deleted_dependent_references": deleted_references,
    }


@_connection_transaction
def delete_observations(workspace_id: str, observation_ids: list[str]) -> dict[str, Any]:
    """Hard-delete selected observations and all references depending on them."""
    ids = sorted({str(observation_id or "").strip() for observation_id in observation_ids if str(observation_id or "").strip()})
    if not ids or len(ids) > 500:
        raise ValueError("observation_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    if any(not store.get("observations", observation_id) for observation_id in ids):
        raise ValueError("observation_not_found")
    selected = set(ids)
    dependent_reference_ids = [
        str(reference["reference_id"])
        for reference in list_references(workspace_id, limit=INTERNAL_SCAN_LIMIT)
        if selected.intersection({str(item) for item in reference.get("source_observation_ids") or []})
    ]
    for reference_id in dependent_reference_ids:
        if not store.delete("references", reference_id):
            raise RuntimeError("reference_delete_failed")
    for observation_id in ids:
        if not store.delete("observations", observation_id):
            raise RuntimeError("observation_delete_failed")
    return {"observation_ids": ids, "deleted_dependent_references": len(dependent_reference_ids)}


@_connection_transaction
def delete_reference(workspace_id: str, reference_id: str) -> bool:
    """Hard-delete a user-visible operational reference record."""
    return _store(workspace_id).delete("references", reference_id)


@_connection_transaction
def delete_references(workspace_id: str, reference_ids: list[str]) -> list[str]:
    """Hard-delete the selected user-visible operational reference records."""
    ids = sorted({str(reference_id or "").strip() for reference_id in reference_ids if str(reference_id or "").strip()})
    if not ids or len(ids) > 500:
        raise ValueError("reference_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    if any(not store.get("references", reference_id) for reference_id in ids):
        raise ValueError("reference_not_found")
    for reference_id in ids:
        if not store.delete("references", reference_id):
            raise RuntimeError("reference_delete_failed")
    return ids


@_connection_transaction
def delete_command_experience(workspace_id: str, experience_id: str) -> bool:
    """Hard-delete a command feedback identity, including legacy duplicates."""
    store = _store(workspace_id)
    selected = store.get("command_experience", experience_id) or {}
    selected_identity = ""
    if selected:
        selected_identity = _command_experience_id(
            str(selected.get("driver_id") or "unknown"),
            str(selected.get("command") or ""),
        )
    deleted = False
    for record in store.list("command_experience", limit=INTERNAL_SCAN_LIMIT):
        if not isinstance(record, dict):
            continue
        record_id = str(record.get("experience_id") or "")
        identity = _command_experience_id(
            str(record.get("driver_id") or "unknown"),
            str(record.get("command") or ""),
        )
        if record_id == experience_id or identity == experience_id or (selected_identity and identity == selected_identity):
            deleted = store.delete("command_experience", record_id) or deleted
    return deleted


@_connection_transaction
def delete_command_experiences(workspace_id: str, experience_ids: list[str]) -> list[str]:
    """Hard-delete selected command feedback identities and legacy duplicates."""
    ids = sorted({str(experience_id or "").strip() for experience_id in experience_ids if str(experience_id or "").strip()})
    if not ids or len(ids) > 500:
        raise ValueError("experience_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    records = [record for record in store.list("command_experience", limit=INTERNAL_SCAN_LIMIT) if isinstance(record, dict)]
    selected_identities: set[str] = set()
    for experience_id in ids:
        selected = store.get("command_experience", experience_id)
        if selected:
            selected_identities.add(_command_experience_id(str(selected.get("driver_id") or "unknown"), str(selected.get("command") or "")))
            continue
        if any(_command_experience_id(str(record.get("driver_id") or "unknown"), str(record.get("command") or "")) == experience_id for record in records):
            selected_identities.add(experience_id)
            continue
        raise ValueError("command_experience_not_found")
    for record in records:
        identity = _command_experience_id(str(record.get("driver_id") or "unknown"), str(record.get("command") or ""))
        if str(record.get("experience_id") or "") in ids or identity in selected_identities:
            if not store.delete("command_experience", str(record.get("experience_id") or "")):
                raise RuntimeError("command_experience_delete_failed")
    return ids


@_connection_transaction
def transition_reference(workspace_id: str, reference_id: str, action: str) -> dict[str, Any]:
    """Confirm or invalidate a candidate through an explicit human action."""
    from core.runtime_engine.context_contract import normalize_reference_descriptor

    record = _store(workspace_id).get("references", reference_id)
    if not record:
        raise ValueError("reference_not_found")
    action = str(action or "").lower()
    if action == "confirm":
        if record.get("state") != "candidate":
            raise ValueError("only_candidate_reference_can_be_confirmed")
        if record.get("completeness") != "complete":
            raise ValueError("complete_observation_required_for_confirmation")
        for current in list_references(workspace_id, limit=500):
            if current.get("state") == "confirmed" and current.get("current") and current.get("scope_key") == record.get("scope_key"):
                current.update({"state": "superseded", "current": False, "updated_at": now_iso(), "superseded_by": reference_id})
                _store(workspace_id).save("references", current["reference_id"], current)
        record.update({"state": "confirmed", "authority": "user_confirmed", "current": True, "confirmed_at": now_iso(), "updated_at": now_iso()})
    elif action == "invalidate":
        if record.get("state") not in {"candidate", "confirmed"}:
            raise ValueError("reference_cannot_be_invalidated")
        record.update({"state": "invalidated", "current": False, "invalidated_at": now_iso(), "updated_at": now_iso()})
    else:
        raise ValueError("reference_action_must_be_confirm_or_invalidate")
    normalized = normalize_reference_descriptor(record)
    _store(workspace_id).save("references", reference_id, normalized)
    return normalized


def operational_context(
    workspace_id: str,
    *,
    connection_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Return bounded, source-labelled context without performing network IO."""
    allowed = None if connection_ids is None else {str(item) for item in connection_ids if str(item)}
    observations = list_observations(workspace_id, limit=24)
    references = list_references(workspace_id, limit=40)
    if allowed is not None:
        observations = [item for item in observations if set(item.get("target_ids") or []).intersection(allowed)]
        references = [item for item in references if set(item.get("target_ids") or []).intersection(allowed)]
    def bounded_record(item: dict[str, Any]) -> dict[str, Any]:
        target_ids = list(item.get("target_ids") or [])
        snapshot = item.get("snapshot") if isinstance(item.get("snapshot"), dict) else {}
        return {
            key: value for key, value in item.items()
            if key not in {"snapshot", "target_ids"}
        } | {
            "target_ids": target_ids[:20],
            "omitted_target_count": max(0, len(target_ids) - 20),
            "snapshot": {target_id: snapshot.get(target_id) for target_id in target_ids[:20] if target_id in snapshot},
        }

    command_experience = list_command_experience(
        workspace_id,
        connection_ids=None if allowed is None else list(allowed),
        limit=40,
    )
    return {
        "observations": [bounded_record(item) for item in observations[:12]],
        "references": [bounded_record(item) for item in references[:20]],
        "command_experience": command_experience,
        "sources": [
            {"source_id": "live_cli", "kind": "live_observation", "available": True, "authority": "observed"},
            {"source_id": "inspection_history", "kind": "historical_observation", "available": bool(observations), "authority": "observed"},
            {"source_id": "confirmed_reference", "kind": "comparison_reference", "available": any(item.get("state") == "confirmed" and item.get("current") for item in references), "authority": "user_confirmed"},
            {"source_id": "command_experience", "kind": "syntax_feedback", "available": bool(command_experience), "authority": "observed", "advisory_only": True},
        ],
        "reference_rule": "observations_describe_a_point_in_time; only_current_user_confirmed_references_describe_expected_state",
        "first_observation_rule": "never_assume_normal",
    }


def inspection_evidence_summary(workspace_id: str, task_id: str) -> dict[str, Any]:
    """Return a safe evidence index and an LLM-readable, redacted artifact."""
    task = get_inspection(workspace_id, task_id)
    if not task:
        raise ValueError("inspection_not_found")
    is_connection_task = task.get("target_kind") == "connection" or bool(task.get("connection_ids"))
    snapshots = task.get("target_snapshots") if isinstance(task.get("target_snapshots"), dict) else {}
    devices = []
    for target_id, result in sorted((task.get("results") or {}).items()):
        snapshot = snapshots.get(target_id) if isinstance(snapshots.get(target_id), dict) else {}
        item = {
            "name": result.get("name", ""),
            "host": result.get("host", ""),
            "status": result.get("status", ""),
            "command_count": len(result.get("commands") or []),
            "output_hash": result.get("output_hash", ""),
            "duration_ms": result.get("duration_ms", 0),
            "error": result.get("error", ""),
        }
        if is_connection_task:
            item["connection_id"] = target_id
            item["device_id"] = str(snapshot.get("device_id") or "")
            item["protocol"] = str(snapshot.get("protocol") or "")
        else:
            item["asset_id"] = target_id
        devices.append(item)
    return {
        "ok": True,
        "task_id": task_id,
        "artifact_id": task.get("artifact_id", ""),
        "artifact_sensitivity": "internal",
        "devices": devices,
    }


def _topology_graph_for_read(record: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read legacy device-keyed diagrams as independent graph nodes.

    Older records used a registered ``device_id`` as the canvas identity.  The
    canvas now owns node identities and keeps the asset link separately.  This
    adapter is deliberately read-only so existing diagrams open safely before
    their next normal save persists the new representation.
    """
    nodes: list[dict[str, Any]] = []
    legacy_refs: dict[str, str] = {}
    for raw in record.get("nodes") or []:
        if not isinstance(raw, dict):
            continue
        legacy_id = str(raw.get("device_id") or "").strip()
        node_id = str(raw.get("node_id") or (f"node_{legacy_id}" if legacy_id else _id("node"))).strip()
        linked_device_id = str(raw.get("linked_device_id") or "").strip()
        if not linked_device_id and legacy_id and not raw.get("manual"):
            linked_device_id = legacy_id
        node = {
            "node_id": node_id,
            "linked_device_id": linked_device_id or None,
            "device_type": str(raw.get("device_type") or "switch"),
            "display_name": str(raw.get("display_name") or ""),
            "labels": list(raw.get("labels") or []),
            "group_id": raw.get("group_id") or None,
            "x": raw.get("x", 0.0),
            "y": raw.get("y", 0.0),
        }
        nodes.append(node)
        if legacy_id:
            legacy_refs[legacy_id] = node_id
        # Some diagrams were saved during the earlier transition: their
        # nodes already carry ``linked_device_id`` while links still use the
        # historic device endpoints.  Read both generations safely.
        if linked_device_id and linked_device_id not in legacy_refs:
            legacy_refs[linked_device_id] = node_id
    links: list[dict[str, Any]] = []
    for raw in record.get("links") or []:
        if not isinstance(raw, dict):
            continue
        src = str(raw.get("source_node_id") or raw.get("source_device_id") or "").strip()
        tgt = str(raw.get("target_node_id") or raw.get("target_device_id") or "").strip()
        links.append({
            **raw,
            "source_node_id": legacy_refs.get(src, src),
            "target_node_id": legacy_refs.get(tgt, tgt),
        })
        links[-1].pop("source_device_id", None)
        links[-1].pop("target_device_id", None)
    return nodes, links


def _public_topology(record: dict[str, Any]) -> dict[str, Any]:
    nodes, links = _topology_graph_for_read(record)
    return {
        "topology_id": str(record.get("topology_id") or ""),
        "name": str(record.get("name") or ""),
        "description": str(record.get("description") or ""),
        "version": int(record.get("version") or 1),
        "nodes": nodes,
        "links": links,
        "groups": list(record.get("groups") or []),
        # Diagram annotations are user-owned visual context.  They are never
        # graph endpoints or execution targets.
        "canvas_items": list(record.get("canvas_items") or []),
        "created_at": str(record.get("created_at") or ""),
        "updated_at": str(record.get("updated_at") or ""),
    }


def list_topologies(workspace_id: str) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("topologies", limit=500)
    return [_public_topology(item) for item in records]


def get_topology(workspace_id: str, topology_id: str) -> dict[str, Any] | None:
    try:
        record = _store(workspace_id).get("topologies", topology_id)
    except ValueError:
        return None
    return _public_topology(record) if record else None


def _normalize_discovery_provenance(
    source: str,
    status: str,
    metadata: dict[str, Any],
    *,
    source_node_id: str,
    target_node_id: str,
    linked_by_node_id: dict[str, str | None],
) -> tuple[str, str, dict[str, Any]]:
    """Keep a user-owned graph usable when inventory associations change.

    ``discovered`` means the link is currently backed by two managed assets.
    It is not a stronger ownership model than the diagram itself.  When an
    endpoint is unlinked (including asset deletion), retain the edge and its
    evidence history but downgrade its *current* operational claim to a manual
    unknown link.  Applying this in the common graph normalizer makes every
    save path safe, rather than teaching each caller a special deletion case.
    """
    if source != "discovered" or (
        linked_by_node_id.get(source_node_id) and linked_by_node_id.get(target_node_id)
    ):
        return source, status, metadata
    return "manual", "unknown", {
        **metadata,
        "discovery_state": "association_removed",
        "discovery_reason": "one_or_more_endpoints_unlinked",
    }


@_connection_transaction
def save_topology(workspace_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("topology name is required and must be at most 80 characters")
    topology_id = str(payload.get("topology_id") or _id("topo")).strip()
    existing = get_topology(workspace_id, topology_id)

    # Optimistic concurrency check
    if existing is not None:
        expected_version = payload.get("version")
        if expected_version is not None and int(expected_version) != int(existing.get("version") or 1):
            raise ValueError("topology_version_conflict")
        new_version = int(existing.get("version") or 1) + 1
    else:
        new_version = 1

    # Device inventory is optional context for a diagram node, never its
    # identity.  A topology remains useful before assets are registered.
    workspace_devices = {str(d.get("device_id") or ""): d for d in list_devices(workspace_id)}

    raw_nodes = payload.get("nodes") if "nodes" in payload else (existing.get("nodes") if existing else [])
    if not isinstance(raw_nodes, list):
        raise ValueError("nodes must be a list")

    normalized_nodes: list[dict[str, Any]] = []
    seen_node_ids: set[str] = set()
    legacy_node_refs: dict[str, str] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            continue
        legacy_device_id = str(raw.get("device_id") or "").strip()
        node_id = str(raw.get("node_id") or (f"node_{legacy_device_id}" if legacy_device_id else _id("node"))).strip()
        if not node_id or node_id in seen_node_ids:
            raise ValueError("duplicate_topology_node_id")
        seen_node_ids.add(node_id)
        # Accept old payloads on read/write, but persist the explicit optional
        # association.  Legacy ``manual`` nodes become unlinked nodes.
        linked_device_id = str(raw.get("linked_device_id") or "").strip()
        if not linked_device_id and legacy_device_id and not raw.get("manual"):
            linked_device_id = legacy_device_id
        if linked_device_id and linked_device_id not in workspace_devices:
            raise ValueError(f"topology node references unknown linked device: {linked_device_id}")
        dev = workspace_devices.get(linked_device_id, {})
        if legacy_device_id:
            legacy_node_refs[legacy_device_id] = node_id
        # Compatibility for clients that still submit a legacy device-keyed
        # link while the saved graph has already migrated to node ids.  The
        # public representation remains node-keyed; this map is only an input
        # adapter and is deliberately overwritten by explicit node ids.
        if linked_device_id and linked_device_id not in legacy_node_refs:
            legacy_node_refs[linked_device_id] = node_id
        try:
            x = float(raw.get("x", 0.0))
            y = float(raw.get("y", 0.0))
        except (TypeError, ValueError):
            x, y = 0.0, 0.0
        normalized_nodes.append({
            "node_id": node_id,
            "linked_device_id": linked_device_id or None,
            "device_type": str(raw.get("device_type") or dev.get("device_type") or "switch").strip()[:48],
            "display_name": str(raw.get("display_name") or dev.get("name") or "").strip()[:80],
            "labels": sorted({str(item).strip() for item in (raw.get("labels") or []) if str(item).strip()}),
            "group_id": str(raw.get("group_id") or "").strip() or None,
            "x": x,
            "y": y,
        })

    raw_groups = payload.get("groups") if "groups" in payload else (existing.get("groups") if existing else [])
    if not isinstance(raw_groups, list):
        raise ValueError("groups must be a list")

    normalized_groups: list[dict[str, Any]] = []
    seen_groups: set[str] = set()
    for raw in raw_groups:
        if not isinstance(raw, dict):
            continue
        group_id = str(raw.get("group_id") or _id("grp")).strip()
        if group_id in seen_groups:
            continue
        seen_groups.add(group_id)
        try:
            gx = float(raw.get("x", 0.0))
            gy = float(raw.get("y", 0.0))
            gw = float(raw.get("width", 320.0))
            gh = float(raw.get("height", 240.0))
        except (TypeError, ValueError):
            gx, gy, gw, gh = 0.0, 0.0, 320.0, 240.0
        kind = str(raw.get("kind") or "datacenter").strip().lower()
        if kind not in {"as", "region", "datacenter", "tenant", "custom"}:
            kind = "custom"
        normalized_groups.append({
            "group_id": group_id,
            "name": str(raw.get("name") or "未命名分组").strip()[:80],
            "description": str(raw.get("description") or "").strip()[:200],
            "kind": kind,
            "x": gx,
            "y": gy,
            "width": max(100.0, gw),
            "height": max(80.0, gh),
            "style": dict(raw.get("style") or {}) if isinstance(raw.get("style"), dict) else {},
        })

    raw_canvas_items = payload.get("canvas_items") if "canvas_items" in payload else (existing.get("canvas_items") if existing else [])
    if not isinstance(raw_canvas_items, list):
        raise ValueError("canvas_items must be a list")
    normalized_canvas_items: list[dict[str, Any]] = []
    seen_canvas_item_ids: set[str] = set()
    for raw in raw_canvas_items:
        if not isinstance(raw, dict):
            continue
        item_id = str(raw.get("item_id") or _id("canvas")).strip()
        if item_id in seen_canvas_item_ids:
            item_id = _id("canvas")
        seen_canvas_item_ids.add(item_id)
        kind = str(raw.get("kind") or "rectangle").strip().lower()
        if kind not in {"rectangle", "ellipse", "text"}:
            kind = "rectangle"
        try:
            x = float(raw.get("x", 0.0))
            y = float(raw.get("y", 0.0))
            width = float(raw.get("width", 180.0))
            height = float(raw.get("height", 96.0))
        except (TypeError, ValueError):
            x, y, width, height = 0.0, 0.0, 180.0, 96.0
        style = dict(raw.get("style") or {}) if isinstance(raw.get("style"), dict) else {}
        normalized_canvas_items.append({
            "item_id": item_id,
            "kind": kind,
            "text": str(raw.get("text") or "").strip()[:240],
            "x": x,
            "y": y,
            "width": min(1600.0, max(40.0, width)),
            "height": min(1200.0, max(24.0, height)),
            "style": {key: str(value)[:24] for key, value in style.items() if key in {"fill", "border", "color"}},
        })

    raw_links = payload.get("links") if "links" in payload else (existing.get("links") if existing else [])
    if not isinstance(raw_links, list):
        raise ValueError("links must be a list")

    normalized_links: list[dict[str, Any]] = []
    seen_links: set[str] = set()
    for raw in raw_links:
        if not isinstance(raw, dict):
            continue
        src = str(raw.get("source_node_id") or raw.get("source_device_id") or "").strip()
        tgt = str(raw.get("target_node_id") or raw.get("target_device_id") or "").strip()
        src = legacy_node_refs.get(src, src)
        tgt = legacy_node_refs.get(tgt, tgt)
        if src not in seen_node_ids or tgt not in seen_node_ids:
            raise ValueError(f"topology link endpoints must reference existing nodes in topology (got {src} -> {tgt})")
        link_id = str(raw.get("link_id") or _id("link")).strip()
        if link_id in seen_links:
            link_id = _id("link")
        seen_links.add(link_id)
        src_iface = str(raw.get("source_interface") or "").strip()[:64]
        tgt_iface = str(raw.get("target_interface") or "").strip()[:64]
        kind = str(raw.get("kind") or "physical").strip().lower()
        if kind not in {"physical", "logical"}:
            kind = "physical"
        status = str(raw.get("status") or "unknown").strip().lower()
        if status not in {"unknown", "up", "down"}:
            status = "unknown"
        source = str(raw.get("source") or "manual").strip().lower()
        if source not in {"manual", "discovered"}:
            source = "manual"
        # A label is a human description, not a generated endpoint caption.
        # Interfaces already have their own compact labels on the canvas.
        label = str(raw.get("label") or "").strip()
        metadata = dict(raw.get("metadata") or {}) if isinstance(raw.get("metadata"), dict) else {}
        linked_by_node_id = {node["node_id"]: node.get("linked_device_id") for node in normalized_nodes}
        source, status, metadata = _normalize_discovery_provenance(
            source,
            status,
            metadata,
            source_node_id=src,
            target_node_id=tgt,
            linked_by_node_id=linked_by_node_id,
        )
        evidence_refs = [str(item).strip() for item in (raw.get("evidence_refs") or []) if str(item).strip()]
        normalized_links.append({
            "link_id": link_id,
            "source_node_id": src,
            "source_interface": src_iface,
            "target_node_id": tgt,
            "target_interface": tgt_iface,
            "kind": kind,
            "label": label[:100],
            "metadata": metadata,
            "source": source,
            "evidence_refs": evidence_refs,
            "status": status,
        })

    record = {
        "topology_id": topology_id,
        "name": name,
        "description": str(payload.get("description") or "").strip()[:500],
        "version": new_version,
        "nodes": normalized_nodes,
        "links": normalized_links,
        "groups": normalized_groups,
        "canvas_items": normalized_canvas_items,
        "created_at": str(existing.get("created_at") or now_iso()) if existing else now_iso(),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("topologies", topology_id, record)
    try:
        _record_topology_revision(workspace_id, record)
    except Exception:  # history is a convenience, never a reason to lose a save
        pass
    return _public_topology(record)


@_connection_transaction
def patch_topology(workspace_id: str, topology_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a small, versioned topology change without replacing the graph.

    This is the write path for an Agent.  A model normally knows only the
    objects it has just observed, so asking it to re-submit a whole canvas is
    both wasteful and unsafe: omitted objects must stay on the canvas.
    """
    existing = get_topology(workspace_id, topology_id)
    if not existing:
        raise ValueError("topology_not_found")
    if "version" not in payload:
        raise ValueError("topology_version_required")
    try:
        expected_version = int(payload.get("version"))
    except (TypeError, ValueError) as exc:
        raise ValueError("topology_version_required") from exc
    if expected_version != int(existing.get("version") or 1):
        raise ValueError("topology_version_conflict")

    def records(value: Any, field: str) -> list[dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
            raise ValueError(f"{field} must be a list of objects")
        return [dict(item) for item in value]

    node_updates = records(payload.get("node_updates"), "node_updates")
    link_updates = records(payload.get("link_updates"), "link_updates")
    group_updates = records(payload.get("group_updates"), "group_updates")
    remove_node_ids = {str(item).strip() for item in (payload.get("remove_node_ids") or []) if str(item).strip()}
    remove_node_device_ids = {str(item).strip() for item in (payload.get("remove_node_device_ids") or []) if str(item).strip()}
    remove_link_ids = {
        str(item).strip() for item in (payload.get("remove_link_ids") or []) if str(item).strip()
    }
    remove_group_ids = {
        str(item).strip() for item in (payload.get("remove_group_ids") or []) if str(item).strip()
    }
    if any(not isinstance(item, str) for item in (payload.get("remove_node_ids") or [])) or any(
        not isinstance(item, str) for item in (payload.get("remove_node_device_ids") or [])
    ):
        raise ValueError("remove_node_ids must be a list of strings")
    if any(not isinstance(item, str) for item in (payload.get("remove_link_ids") or [])):
        raise ValueError("remove_link_ids must be a list of strings")
    if any(not isinstance(item, str) for item in (payload.get("remove_group_ids") or [])):
        raise ValueError("remove_group_ids must be a list of strings")

    nodes_by_id = {
        str(item.get("node_id") or ""): dict(item)
        for item in existing.get("nodes") or []
    }
    for update in node_updates:
        node_id = str(update.get("node_id") or "").strip()
        if not node_id:
            raise ValueError("node_update_requires_node_id")
        nodes_by_id[node_id] = {**nodes_by_id.get(node_id, {}), **update, "node_id": node_id}

    # Compatibility inputs used registered asset ids before diagrams acquired
    # their own node ids.  Resolve once and reject ambiguity explicitly: a
    # silent guess can modify the wrong visual node on a free-form diagram.
    node_ids_by_device: dict[str, list[str]] = {}
    for node_id, node in nodes_by_id.items():
        linked_device_id = str(node.get("linked_device_id") or "").strip()
        if linked_device_id:
            node_ids_by_device.setdefault(linked_device_id, []).append(node_id)
    for device_id in remove_node_device_ids:
        candidates = node_ids_by_device.get(device_id, [])
        if len(candidates) == 0:
            raise ValueError("topology_device_association_not_found")
        if len(candidates) > 1:
            raise ValueError("topology_device_association_ambiguous")
        remove_node_ids.add(candidates[0])
    for node_id in remove_node_ids:
        if node_id not in nodes_by_id:
            raise ValueError("topology_node_not_found")
        del nodes_by_id[node_id]

    groups_by_id = {
        str(item.get("group_id") or ""): dict(item)
        for item in existing.get("groups") or []
    }
    for update in group_updates:
        group_id = str(update.get("group_id") or "").strip()
        if not group_id:
            raise ValueError("group_update_requires_group_id")
        groups_by_id[group_id] = {**groups_by_id.get(group_id, {}), **update, "group_id": group_id}
    for group_id in remove_group_ids:
        if group_id not in groups_by_id:
            raise ValueError("topology_group_not_found")
        del groups_by_id[group_id]

    links_by_id = {
        str(item.get("link_id") or ""): dict(item)
        for item in existing.get("links") or []
    }
    for update in link_updates:
        link_id = str(update.get("link_id") or "").strip()
        is_new = not link_id
        if is_new and "source" not in update:
            raise ValueError("new_link_requires_source")
        if "source" in update and str(update.get("source") or "").strip().lower() not in {"manual", "discovered"}:
            raise ValueError("topology_link_source_invalid")
        if "status" in update and str(update.get("status") or "").strip().lower() not in {"unknown", "up", "down"}:
            raise ValueError("topology_link_status_invalid")
        if "evidence_refs" in update and (
            not isinstance(update.get("evidence_refs"), list)
            or any(not isinstance(item, str) or not item.strip() for item in update.get("evidence_refs") or [])
        ):
            raise ValueError("topology_evidence_refs_must_be_strings")
        if link_id:
            links_by_id[link_id] = {**links_by_id.get(link_id, {}), **update, "link_id": link_id}
            continue
        # New links deliberately receive their id in save_topology.  Existing
        # links must be addressed by the id returned from a prior read.
        generated_id = _id("link")
        links_by_id[generated_id] = {**update, "link_id": generated_id}
    for link_id in remove_link_ids:
        if link_id not in links_by_id:
            raise ValueError("topology_link_not_found")
        del links_by_id[link_id]

    # Removing a node also removes only its incident links.  It must never
    # leave a graph whose links point at invisible/nonexistent nodes.
    surviving_nodes = set(nodes_by_id)
    # Legacy patch callers may still address a link by registered device id.
    # Resolve that input once against the current associations before testing
    # graph integrity; persisted links remain strictly node-keyed.  An absent
    # or ambiguous association is a contract error, never a reason to silently
    # drop the requested edge.
    surviving_node_ids_by_device: dict[str, list[str]] = {}
    for node_id, node in nodes_by_id.items():
        linked_device_id = str(node.get("linked_device_id") or "").strip()
        if linked_device_id:
            surviving_node_ids_by_device.setdefault(linked_device_id, []).append(node_id)
    for link in links_by_id.values():
        for node_field, device_field in (("source_node_id", "source_device_id"), ("target_node_id", "target_device_id")):
            if link.get(node_field):
                continue
            device_id = str(link.get(device_field) or "").strip()
            candidates = surviving_node_ids_by_device.get(device_id, [])
            if len(candidates) == 0:
                raise ValueError("topology_link_endpoint_not_found")
            if len(candidates) > 1:
                raise ValueError("topology_device_association_ambiguous")
            link[node_field] = candidates[0]
    links = []
    for link in links_by_id.values():
        source_node_id = str(link.get("source_node_id") or "")
        target_node_id = str(link.get("target_node_id") or "")
        if source_node_id not in surviving_nodes or target_node_id not in surviving_nodes:
            # Explicit node removal owns only its incident edges.  Do not
            # manufacture a dangling graph in response to a partial patch.
            continue
        links.append(link)
    for link in links:
        if str(link.get("source") or "manual").strip().lower() == "discovered" and not [
            str(item).strip() for item in (link.get("evidence_refs") or []) if str(item).strip()
        ]:
            raise ValueError("discovered_link_requires_evidence")

    # save_topology remains the single normalizer/validator for every graph
    # write.  It also keeps the stored representation and API representation
    # identical to manual canvas saves.
    return save_topology(workspace_id, {
        **existing,
        "topology_id": topology_id,
        "version": expected_version,
        "nodes": list(nodes_by_id.values()),
        "links": links,
        "groups": list(groups_by_id.values()),
    })


@_connection_transaction
def remove_topology_node(workspace_id: str, topology_id: str, node_id: str, *, expected_version: int | None = None) -> dict[str, Any]:
    existing = get_topology(workspace_id, topology_id)
    if not existing:
        raise ValueError("topology_not_found")
    if expected_version is not None and int(expected_version) != int(existing.get("version") or 1):
        raise ValueError("topology_version_conflict")
    filtered_nodes = [n for n in existing.get("nodes") or [] if n.get("node_id") != node_id]
    if len(filtered_nodes) == len(existing.get("nodes") or []):
        raise ValueError("topology_node_not_found")
    filtered_links = [
        l for l in existing.get("links") or []
        if l.get("source_node_id") != node_id and l.get("target_node_id") != node_id
    ]
    payload = {
        **existing,
        "nodes": filtered_nodes,
        "links": filtered_links,
        "version": existing.get("version"),
    }
    return save_topology(workspace_id, payload)


# ---------------------------------------------------------------------------
# Topology revision history
#
# A canvas is edited continuously: dragging a node fires a save on every
# mouse-up.  Versioning every one of those saves would bury the few edits a
# human actually wants to get back, so a revision is recorded only when the
# *structure* of the diagram changes — which objects exist and how they are
# connected.  Pure layout movement is deliberately not a revision.
# ---------------------------------------------------------------------------

TOPOLOGY_REVISION_LIMIT = 40


def _topology_structure_signature(topology: dict[str, Any]) -> str:
    payload = {
        "name": str(topology.get("name") or ""),
        "nodes": sorted(
            [
                [
                    str(node.get("node_id") or ""),
                    str(node.get("linked_device_id") or ""),
                    str(node.get("device_type") or ""),
                    str(node.get("display_name") or ""),
                    str(node.get("group_id") or ""),
                    ",".join(sorted(str(item) for item in (node.get("labels") or []))),
                ]
                for node in (topology.get("nodes") or [])
            ]
        ),
        "links": sorted(
            [
                [
                    str(link.get("link_id") or ""),
                    str(link.get("source_node_id") or ""),
                    str(link.get("target_node_id") or ""),
                    str(link.get("source_interface") or ""),
                    str(link.get("target_interface") or ""),
                    str(link.get("kind") or ""),
                    str(link.get("source") or ""),
                    str(link.get("status") or ""),
                    str(link.get("label") or ""),
                    ",".join(sorted(str(item) for item in (link.get("evidence_refs") or []))),
                ]
                for link in (topology.get("links") or [])
            ]
        ),
        "groups": sorted(
            [
                [str(group.get("group_id") or ""), str(group.get("name") or ""), str(group.get("kind") or "")]
                for group in (topology.get("groups") or [])
            ]
        ),
        "canvas_items": sorted(
            [
                [str(item.get("item_id") or ""), str(item.get("kind") or ""), str(item.get("text") or "")]
                for item in (topology.get("canvas_items") or [])
            ]
        ),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:32]


def _revision_collection(topology_id: str) -> str:
    """Revisions live in a per-drawing collection with a collision-free key.

    One shared collection would have to be filtered by topology after a capped
    read, so a workspace with a dozen busy drawings would silently lose the
    history of whatever fell past the limit — and the retention cap would be
    computed from a truncated list, so it would prune the wrong revisions.
    """
    topology_key = str(topology_id or "")
    return f"topology_revisions_{hashlib.sha256(topology_key.encode('utf-8')).hexdigest()[:32]}"


def _legacy_revision_collections(topology_id: str) -> list[str]:
    """Collections used by the two pre-migration revision layouts."""
    old_per_drawing = (
        f"topology_revisions_{re.sub(r'[^A-Za-z0-9_]+', '_', str(topology_id or '')).strip('_')}"
    )
    return [collection for collection in (old_per_drawing, "topology_revisions")
            if collection != _revision_collection(topology_id)]


def _topology_revisions(workspace_id: str, topology_id: str) -> list[dict[str, Any]]:
    store = _store(workspace_id)
    collection = _revision_collection(topology_id)
    # Revision history is operational data. Move records written by either
    # earlier layout before listing so upgrading never makes old snapshots
    # disappear. Copy before deleting so an interrupted migration preserves the
    # original record for the next read.
    for legacy_collection in _legacy_revision_collections(topology_id):
        for item in store.list(legacy_collection, limit=500):
            if str(item.get("topology_id") or "") != topology_id:
                continue
            revision_id = str(item.get("revision_id") or "")
            if not revision_id:
                continue
            if not store.get(collection, revision_id):
                store.save(collection, revision_id, item)
            store.delete(legacy_collection, revision_id)
    revisions = [
        item for item in store.list(collection, limit=500)
        if str(item.get("topology_id") or "") == topology_id
    ]
    revisions.sort(key=lambda item: int(item.get("version") or 0))
    return revisions


def _record_topology_revision(workspace_id: str, record: dict[str, Any]) -> None:
    """Snapshot a topology when its structure, not just its layout, changed."""
    signature = _topology_structure_signature(record)
    store = _store(workspace_id)
    revisions = _topology_revisions(workspace_id, str(record.get("topology_id") or ""))
    if revisions and str(revisions[-1].get("signature") or "") == signature:
        return
    revision_id = _id("rev")
    collection = _revision_collection(str(record.get("topology_id") or ""))
    store.save(collection, revision_id, {
        "revision_id": revision_id,
        "topology_id": str(record.get("topology_id") or ""),
        "version": int(record.get("version") or 1),
        "signature": signature,
        "saved_at": str(record.get("updated_at") or now_iso()),
        "name": str(record.get("name") or ""),
        "summary": {
            "nodes": len(record.get("nodes") or []),
            "links": len(record.get("links") or []),
            "groups": len(record.get("groups") or []),
            "canvas_items": len(record.get("canvas_items") or []),
        },
        "snapshot": json.loads(json.dumps(record)),
    })
    # Keep history bounded; the oldest revisions are the least useful ones.
    overflow = len(revisions) + 1 - TOPOLOGY_REVISION_LIMIT
    for stale in revisions[:max(0, overflow)]:
        store.delete(collection, str(stale.get("revision_id") or ""))


def list_topology_revisions(workspace_id: str, topology_id: str) -> list[dict[str, Any]]:
    """Revisions, newest first, without the snapshots (a list stays cheap).

    Drawings created before history existed have no baseline.  Opening their
    history would otherwise show "nothing recorded yet" for a canvas that is
    very much in use, so the current state becomes version one on first look.
    """
    revisions = _topology_revisions(workspace_id, topology_id)
    if not revisions:
        existing = _store(workspace_id).get("topologies", topology_id)
        if existing:
            _record_topology_revision(workspace_id, existing)
            revisions = _topology_revisions(workspace_id, topology_id)
    return [
        {
            "revision_id": item.get("revision_id"),
            "version": item.get("version"),
            "saved_at": item.get("saved_at"),
            "name": item.get("name"),
            "summary": item.get("summary") or {},
        }
        for item in reversed(revisions)
    ]


def get_topology_revision(workspace_id: str, topology_id: str, revision_id: str) -> dict[str, Any] | None:
    """Read one revision. The owning drawing is part of the lookup, not trusted
    from the record alone, so an id from another canvas cannot reach it."""
    record = _store(workspace_id).get(_revision_collection(topology_id), revision_id)
    if not record:
        return None
    if str(record.get("topology_id") or "") != topology_id:
        return None
    return record


def _index_by_id(items: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    return {str(item.get(key) or ""): item for item in items if item.get(key)}


def _link_facts(link: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_node_id": str(link.get("source_node_id") or ""),
        "target_node_id": str(link.get("target_node_id") or ""),
        "source_interface": str(link.get("source_interface") or ""),
        "target_interface": str(link.get("target_interface") or ""),
        "kind": str(link.get("kind") or ""),
        "source": str(link.get("source") or ""),
        "status": str(link.get("status") or ""),
        "label": str(link.get("label") or ""),
    }


def _node_facts(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "linked_device_id": str(node.get("linked_device_id") or ""),
        "device_type": str(node.get("device_type") or ""),
        "display_name": str(node.get("display_name") or ""),
        "group_id": str(node.get("group_id") or ""),
    }


def diff_topology_snapshots(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """What changed between two topology versions, in canvas vocabulary."""
    before_nodes = _index_by_id(list(before.get("nodes") or []), "node_id")
    after_nodes = _index_by_id(list(after.get("nodes") or []), "node_id")
    before_links = _index_by_id(list(before.get("links") or []), "link_id")
    after_links = _index_by_id(list(after.get("links") or []), "link_id")
    before_groups = _index_by_id(list(before.get("groups") or []), "group_id")
    after_groups = _index_by_id(list(after.get("groups") or []), "group_id")
    before_items = _index_by_id(list(before.get("canvas_items") or []), "item_id")
    after_items = _index_by_id(list(after.get("canvas_items") or []), "item_id")

    def label_of(node_id: str) -> str:
        node = after_nodes.get(node_id) or before_nodes.get(node_id) or {}
        return str(node.get("display_name") or node_id)

    nodes_added = [
        {"node_id": node_id, "label": label_of(node_id)}
        for node_id in after_nodes
        if node_id not in before_nodes
    ]
    nodes_removed = [
        {"node_id": node_id, "label": label_of(node_id)}
        for node_id in before_nodes
        if node_id not in after_nodes
    ]
    nodes_changed = []
    for node_id in before_nodes:
        if node_id not in after_nodes:
            continue
        before_facts = _node_facts(before_nodes[node_id])
        after_facts = _node_facts(after_nodes[node_id])
        if before_facts != after_facts:
            nodes_changed.append({
                "node_id": node_id,
                "label": label_of(node_id),
                "changes": {
                    field: {"from": before_facts[field], "to": after_facts[field]}
                    for field in before_facts
                    if before_facts[field] != after_facts[field]
                },
            })

    links_added, links_removed, links_changed = [], [], []
    for link_id, link in after_links.items():
        if link_id not in before_links:
            links_added.append({
                "link_id": link_id,
                "label": f"{label_of(str(link.get('source_node_id') or ''))} ↔ {label_of(str(link.get('target_node_id') or ''))}",
            })
    for link_id, link in before_links.items():
        if link_id not in after_links:
            links_removed.append({
                "link_id": link_id,
                "label": f"{label_of(str(link.get('source_node_id') or ''))} ↔ {label_of(str(link.get('target_node_id') or ''))}",
            })
    for link_id, link in before_links.items():
        if link_id not in after_links:
            continue
        before_facts = _link_facts(link)
        after_facts = _link_facts(after_links[link_id])
        if before_facts != after_facts:
            links_changed.append({
                "link_id": link_id,
                "label": f"{label_of(before_facts['source_node_id'])} ↔ {label_of(before_facts['target_node_id'])}",
                "changes": {
                    field: {"from": before_facts[field], "to": after_facts[field]}
                    for field in before_facts
                    if before_facts[field] != after_facts[field]
                },
            })

    def group_label(group: dict[str, Any]) -> str:
        return str(group.get("name") or group.get("group_id") or "")

    def item_label(item: dict[str, Any]) -> str:
        return str(item.get("text") or item.get("kind") or item.get("item_id") or "")

    return {
        "nodes_added": nodes_added,
        "nodes_removed": nodes_removed,
        "nodes_changed": nodes_changed,
        "links_added": links_added,
        "links_removed": links_removed,
        "links_changed": links_changed,
        "groups_added": [
            {"group_id": group_id, "label": group_label(after_groups[group_id])}
            for group_id in after_groups
            if group_id not in before_groups
        ],
        "groups_removed": [
            {"group_id": group_id, "label": group_label(before_groups[group_id])}
            for group_id in before_groups
            if group_id not in after_groups
        ],
        "canvas_items_added": [
            {"item_id": item_id, "label": item_label(after_items[item_id])}
            for item_id in after_items
            if item_id not in before_items
        ],
        "canvas_items_removed": [
            {"item_id": item_id, "label": item_label(before_items[item_id])}
            for item_id in before_items
            if item_id not in after_items
        ],
        "summary": {
            "nodes_added": len(nodes_added),
            "nodes_removed": len(nodes_removed),
            "nodes_changed": len(nodes_changed),
            "links_added": len(links_added),
            "links_removed": len(links_removed),
            "links_changed": len(links_changed),
            "total_changes": (
                len(nodes_added) + len(nodes_removed) + len(nodes_changed)
                + len(links_added) + len(links_removed) + len(links_changed)
                + len([g for g in after_groups if g not in before_groups])
                + len([g for g in before_groups if g not in after_groups])
                + len([i for i in after_items if i not in before_items])
                + len([i for i in before_items if i not in after_items])
            ),
        },
    }


def compare_topology_revision(workspace_id: str, topology_id: str, revision_id: str) -> dict[str, Any]:
    """Diff a stored revision against what the canvas holds now."""
    record = get_topology_revision(workspace_id, topology_id, revision_id)
    if not record:
        raise ValueError("topology_revision_not_found")
    snapshot = record.get("snapshot") or {}
    current = get_topology(workspace_id, topology_id)
    if not current:
        raise ValueError("topology_not_found")
    return {
        "revision_id": revision_id,
        "topology_id": topology_id,
        "revision_version": record.get("version"),
        "revision_saved_at": record.get("saved_at"),
        "current_version": current.get("version"),
        **diff_topology_snapshots(snapshot, current),
    }


@_connection_transaction
def restore_topology_revision(workspace_id: str, topology_id: str, revision_id: str) -> dict[str, Any]:
    """Roll the canvas back to a revision.

    Restoring is a forward edit, not a rewrite of history: it writes the old
    structure as a new version, so the undo trail itself stays intact.
    """
    record = get_topology_revision(workspace_id, topology_id, revision_id)
    if not record:
        raise ValueError("topology_revision_not_found")
    snapshot = json.loads(json.dumps(record.get("snapshot") or {}))
    topology_id = str(record.get("topology_id") or "")
    current = get_topology(workspace_id, topology_id)
    if not current:
        raise ValueError("topology_not_found")
    return save_topology(workspace_id, {
        **snapshot,
        "topology_id": topology_id,
        "version": current.get("version"),
        # Keep the newest layout: a rollback is about structure, and silently
        # teleporting every node back would destroy work done since.
        "nodes": _restore_with_current_layout(snapshot.get("nodes") or [], current.get("nodes") or []),
    })


def _restore_with_current_layout(
    snapshot_nodes: list[dict[str, Any]], current_nodes: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    positions = {
        str(node.get("node_id") or ""): (node.get("x"), node.get("y"))
        for node in current_nodes
    }
    restored = []
    for node in snapshot_nodes:
        node_id = str(node.get("node_id") or "")
        x, y = positions.get(node_id, (node.get("x"), node.get("y")))
        restored.append({**node, "x": x, "y": y})
    return restored


@_connection_transaction
def delete_topology(workspace_id: str, topology_id: str) -> bool:
    record = get_topology(workspace_id, topology_id)
    if not record:
        return False
    # Clear any Skill references to this topology so no dangling references remain
    for skill in list_skills(workspace_id):
        if str(skill.get("topology_id") or "") == topology_id:
            skill["topology_id"] = ""
            save_skill(workspace_id, skill)
    store = _store(workspace_id)
    collection = _revision_collection(topology_id)
    for revision in _topology_revisions(workspace_id, topology_id):
        store.delete(collection, str(revision.get("revision_id") or ""))
    return store.delete("topologies", topology_id)


def topology_state(workspace_id: str, topology_id: str, *, scope_device_ids: set[str] | None = None, scope_connection_ids: set[str] | None = None) -> dict[str, Any]:
    """Project recorded facts for both canvas and model; never probe on a UI refresh.

    Connection tests describe management access at a point in time. Inspection
    completion and a manually drawn link do not establish device/link health.
    """
    topo = get_topology(workspace_id, topology_id)
    if not topo:
        raise ValueError("topology_not_found")
    linked_by_node_id = {
        str(node.get("node_id") or ""): str(node.get("linked_device_id") or "")
        for node in topo.get("nodes", [])
    }
    device_ids = {device_id for device_id in linked_by_node_id.values() if device_id}
    if scope_device_ids is not None:
        device_ids &= scope_device_ids
    devices = {d["device_id"]: d for d in list_devices(workspace_id) if d["device_id"] in device_ids}
    connections = [c for c in list_connections(workspace_id) if c.get("device_id") in device_ids
                   and (scope_connection_ids is None or c.get("connection_id") in scope_connection_ids)]
    observations = list_observations(workspace_id, limit=500)
    nodes = []
    for node_id, device_id in sorted(linked_by_node_id.items()):
        if not device_id or device_id not in device_ids:
            continue
        device_connections = [c for c in connections if c.get("device_id") == device_id]
        ids = {c["connection_id"] for c in device_connections}
        observation = next((
            o for o in observations
            if ids.intersection(o.get("target_ids") or []) or device_id in (o.get("target_ids") or [])
        ), None)
        device = devices.get(device_id, {})
        nodes.append({
            "node_id": node_id,
            "device_id": device_id,
            "name": device.get("name", device_id),
            "device_type": device.get("device_type", ""),
            "vendor": device.get("vendor", ""),
            "host": device.get("host", ""),
            "connections": [{key: c.get(key, "") for key in (
                "connection_id", "protocol", "port", "status", "verified", "last_tested_at",
            )} for c in device_connections],
            "observation": {key: observation.get(key, "") for key in (
                "observation_id", "source_id", "artifact_id", "observed_at", "completeness",
            )} if observation else None,
        })
    return {"topology_id": topology_id, "version": topo["version"], "refreshed_at": now_iso(),
            "source": "recorded_facts", "nodes": nodes,
            "links": [{"link_id": link["link_id"], "observed_status": "unknown",
                       "recorded_status": link.get("status", "unknown"), "source": link.get("source", "manual")}
                      for link in topo.get("links", [])
                      if linked_by_node_id.get(str(link.get("source_node_id") or "")) in device_ids
                      and linked_by_node_id.get(str(link.get("target_node_id") or "")) in device_ids]}


def compare_topology(workspace_id: str, topology_id: str, *, scope_device_ids: set[str] | None = None) -> dict[str, Any]:
    topo = get_topology(workspace_id, topology_id)
    if not topo:
        raise ValueError("topology_not_found")
    linked_by_node_id = {
        str(node.get("node_id") or ""): str(node.get("linked_device_id") or "")
        for node in topo.get("nodes", [])
    }

    all_workspace_devices = list_devices(workspace_id)
    if scope_device_ids is not None:
        available_devices = [d for d in all_workspace_devices if d.get("device_id") in scope_device_ids]
    else:
        available_devices = all_workspace_devices
    available_ids = {str(d.get("device_id") or "") for d in available_devices}

    # A diagram symbol is intentionally outside device inventory and evidence
    # comparison.  Reporting it as a missing device would turn a drawing aid
    # into a false operational alarm.
    topo_nodes = [n for n in topo.get("nodes") or [] if n.get("linked_device_id") and (scope_device_ids is None or n.get("linked_device_id") in scope_device_ids)]
    topo_device_ids = {str(n.get("linked_device_id") or "") for n in topo_nodes}

    devices_in_scope_not_in_topology = sorted(available_ids - topo_device_ids)
    topology_devices_not_in_scope = sorted(topo_device_ids - available_ids)

    # Current observations retain target-level snapshots, not interface-to-
    # interface adjacency.  An observation on either device cannot prove that
    # this particular link is present or operational.  Keep comparisons
    # conservative until collection emits explicit adjacency evidence.

    topo_links = [
        l for l in topo.get("links") or []
        if linked_by_node_id.get(str(l.get("source_node_id") or ""))
        and linked_by_node_id.get(str(l.get("target_node_id") or ""))
        and (scope_device_ids is None or (linked_by_node_id.get(str(l.get("source_node_id") or "")) in scope_device_ids and linked_by_node_id.get(str(l.get("target_node_id") or "")) in scope_device_ids))
    ]

    link_comparisons = []
    matched_count = 0
    mismatched_count = 0
    unknown_count = 0

    for link in topo_links:
        link_id = link.get("link_id")
        src_node = str(link.get("source_node_id") or "")
        tgt_node = str(link.get("target_node_id") or "")
        src_dev = linked_by_node_id.get(src_node, "")
        tgt_dev = linked_by_node_id.get(tgt_node, "")
        src_iface = link.get("source_interface") or ""
        tgt_iface = link.get("target_interface") or ""
        recorded_status = link.get("status") or "unknown"

        evidence_refs = [str(item) for item in (link.get("evidence_refs") or []) if str(item)]
        comparison_status = "unknown"
        unknown_count += 1
        note = (
            "已关联证据引用，但当前证据不含两端接口邻接关系，不能确认此链路"
            if evidence_refs
            else "无两端接口邻接证据，保持未知状态"
        )

        link_comparisons.append({
            "link_id": link_id,
            "source_node_id": src_node,
            "source_device_id": src_dev,
            "source_interface": src_iface,
            "target_node_id": tgt_node,
            "target_device_id": tgt_dev,
            "target_interface": tgt_iface,
            "kind": link.get("kind"),
            "recorded_status": recorded_status,
            "comparison_status": comparison_status,
            "evidence_count": len(evidence_refs),
            "evidence_refs": evidence_refs[:10],
            "note": note,
        })

    return {
        "ok": True,
        "topology_id": topology_id,
        "topology_name": topo.get("name"),
        "version": topo.get("version"),
        "devices_in_scope_not_in_topology": devices_in_scope_not_in_topology,
        "topology_devices_not_in_scope": topology_devices_not_in_scope,
        "link_comparisons": link_comparisons,
        "summary": {
            "total_nodes": len(topo_nodes),
            "total_links": len(topo_links),
            "matched_links": matched_count,
            "mismatched_links": mismatched_count,
            "unknown_evidence_links": unknown_count,
            "available_devices_missing_from_topology": len(devices_in_scope_not_in_topology),
        },
    }


# ---------------------------------------------------------------------------
# Neighbour discovery
# ---------------------------------------------------------------------------

_NEIGHBOR_COMMAND_HINTS = ("lldp", "cdp")
_INTERFACE_RE = re.compile(
    r"^(?:xge|10ge|25ge|40ge|100ge|ge|gigabitethernet|te|ten-gigabitethernet|tengigabitethernet|"
    r"fa|fastethernet|ethernet|eth|gi|gig|e|g|xg|hu|fo|bagg|bridge-aggregation|po|port-channel|"
    r"vlanif|vlan|lo|loopback|mgmt|me|aux|console)[-\s]?[\d/:.]*\d[\d/:.]*$",
    re.IGNORECASE,
)


# Cisco prints "Gig 1/0/1" with a space; the token has to be joined before it
# can be recognised as an interface at all.
_INTERFACE_SPACED_RE = re.compile(
    r"\b(gig|gi|ten|te|fa|eth|fo|hu|xge|ge|po| hundredgige| fortygige)\s+(\d[\d/:.]*)",
    re.IGNORECASE,
)


def _looks_like_interface(value: str) -> bool:
    token = str(value or "").strip().rstrip(",;")
    if not token or len(token) > 32:
        return False
    return bool(_INTERFACE_RE.match(token))


def _clean_neighbor_token(value: str) -> str:
    token = str(value or "").strip().rstrip(",;")
    # Cisco CDP prints "hostname.domain"; the device record usually holds the
    # short name, so keep both forms for matching.
    return token


def parse_neighbor_output(output: str) -> list[dict[str, str]]:
    """Best-effort parse of ``display lldp neighbor`` / ``show cdp neighbors``.

    Vendors disagree on every column, so this handles the two shapes that
    actually occur: the verbose key/value block and the brief table. Anything
    unrecognised is skipped rather than guessed at, because a wrong link is
    worse than no link.
    """
    results: list[dict[str, str]] = []
    if not output:
        return results
    local_if = ""
    remote_name = ""
    remote_port = ""

    def flush() -> None:
        nonlocal local_if, remote_name, remote_port
        if local_if and (remote_name or remote_port):
            results.append({
                "local_interface": local_if,
                "remote_name": _clean_neighbor_token(remote_name),
                "remote_interface": _clean_neighbor_token(remote_port),
            })
        local_if, remote_name, remote_port = "", "", ""

    for raw_line in str(output).splitlines():
        line = _INTERFACE_SPACED_RE.sub(r"\1\2", raw_line.strip())
        if not line:
            continue
        low = line.lower()
        if low.startswith(("local interface", "local intf", "local port", "localinterface")):
            flush()
            local_if = line.split(":", 1)[-1].strip()
            continue
        if low.startswith(("system name", "peer system name", "device id", "remote device id", "sysname")):
            remote_name = line.split(":", 1)[-1].strip()
            continue
        if low.startswith(("port id", "remote port", "portid")):
            remote_port = line.split(":", 1)[-1].strip()
            continue
        parts = line.split()
        if len(parts) >= 4 and not _looks_like_interface(parts[0]) and _looks_like_interface(parts[1]):
            # Cisco brief table: <device id> <local iface> <holdtime> ... <port id>
            flush()
            remote_name = parts[0]
            local_if = parts[1]
            remote_port = parts[-1]
            continue
        if len(parts) >= 3 and _looks_like_interface(parts[0]):
            # Huawei / H3C brief table: <local iface> <chassis id> <port id> <system name>
            flush()
            local_if = parts[0]
            tail = [p for p in parts[1:]]
            if _looks_like_interface(tail[-1]):
                remote_name = tail[-1]
                remote_port = tail[-2] if len(tail) >= 2 and _looks_like_interface(tail[-2]) else ""
            else:
                remote_name = tail[-1] if tail else ""
                remote_port = tail[-2] if len(tail) >= 2 and _looks_like_interface(tail[-2]) else ""
    flush()
    return results


def _device_match_keys(device: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    name = str(device.get("name") or "").strip().lower()
    host = str(device.get("host") or "").strip().lower()
    if name:
        keys.add(name)
        keys.add(name.split(".")[0])
    if host:
        keys.add(host)
    return {key for key in keys if key}


def discover_topology_neighbors(workspace_id: str, topology_id: str) -> dict[str, Any]:
    """Suggest links that were observed on the wire but never drawn.

    Neighbour tables are read from evidence that has already been collected;
    this never connects to a device. A candidate is only offered when both
    ends resolve to devices already on the canvas, so adopting one always
    produces a link the drawing can represent.
    """
    topo = get_topology(workspace_id, topology_id)
    if not topo:
        raise ValueError("topology_not_found")
    linked_by_node_id = {
        str(node.get("node_id") or ""): str(node.get("linked_device_id") or "")
        for node in topo.get("nodes", [])
    }
    node_ids_by_device_id: dict[str, list[str]] = {}
    for node_id, device_id in linked_by_node_id.items():
        if device_id:
            node_ids_by_device_id.setdefault(device_id, []).append(node_id)
    # A discovered fact may be written back only when each asset has one
    # unambiguous drawing node. A device can intentionally appear more than
    # once, but choosing one depiction here would turn evidence into a guess.
    node_by_device_id = {
        device_id: node_ids[0]
        for device_id, node_ids in node_ids_by_device_id.items()
        if len(node_ids) == 1
    }
    device_ids = set(node_by_device_id)
    if not node_ids_by_device_id:
        return {"topology_id": topology_id, "candidates": [], "scanned_devices": 0, "note": "topology_has_no_linked_devices"}
    devices = [d for d in list_devices(workspace_id) if d.get("device_id") in device_ids]
    keys_by_device_id = {d["device_id"]: _device_match_keys(d) for d in devices}
    device_ids_by_key: dict[str, set[str]] = {}
    for device_id, keys in keys_by_device_id.items():
        for key in keys:
            device_ids_by_key.setdefault(key, set()).add(device_id)

    observations = list_observations(workspace_id, limit=500)
    artifact_by_device: dict[str, str] = {}
    for observation in observations:
        artifact_id = str(observation.get("artifact_id") or "").strip()
        if not artifact_id:
            continue
        for target in observation.get("target_ids") or []:
            target_id = str(target)
            if target_id in device_ids and target_id not in artifact_by_device:
                artifact_by_device[target_id] = artifact_id

    existing_pairs = set()
    for link in topo.get("links", []):
        source = str(link.get("source_node_id") or "")
        target = str(link.get("target_node_id") or "")
        existing_pairs.add(frozenset((source, target)))

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    scanned = 0
    for device_id, artifact_id in artifact_by_device.items():
        try:
            from artifacts.store import read_artifact_content
            # Inspection evidence is classified "sensitive"; reading it back for
            # analysis is the intended use, and "secret" stays blocked regardless.
            content = read_artifact_content(workspace_id, artifact_id, allow_sensitive=True)
        except Exception:
            continue
        if not content:
            continue
        try:
            payload = json.loads(content)
        except Exception:
            continue
        raw_outputs = payload.get("raw_outputs") if isinstance(payload, dict) else None
        if not isinstance(raw_outputs, dict):
            continue
        scanned += 1
        for command, entry in raw_outputs.items():
            if not any(hint in str(command).lower() for hint in _NEIGHBOR_COMMAND_HINTS):
                continue
            text = entry.get("output") if isinstance(entry, dict) else entry
            if not isinstance(text, str):
                continue
            for neighbor in parse_neighbor_output(text):
                remote_key = str(neighbor.get("remote_name") or "").strip().lower()
                if not remote_key:
                    continue
                remote_key = remote_key.split(".")[0]
                remote_candidates = device_ids_by_key.get(remote_key, set())
                remote_id = next(iter(remote_candidates)) if len(remote_candidates) == 1 else None
                if not remote_id or remote_id == device_id:
                    continue
                source_node = node_by_device_id.get(device_id)
                target_node = node_by_device_id.get(remote_id)
                if not source_node or not target_node:
                    continue
                if frozenset((source_node, target_node)) in existing_pairs:
                    continue
                signature = (source_node, target_node, neighbor.get("local_interface", ""), neighbor.get("remote_interface", ""))
                if signature in seen:
                    continue
                seen.add(signature)
                candidates.append({
                    "source_node_id": source_node,
                    "target_node_id": target_node,
                    "source_interface": neighbor.get("local_interface", ""),
                    "target_interface": neighbor.get("remote_interface", ""),
                    "source_device_id": device_id,
                    "target_device_id": remote_id,
                    "remote_name": neighbor.get("remote_name", ""),
                    "evidence_artifact_id": artifact_id,
                })
    return {
        "topology_id": topology_id,
        "candidates": candidates,
        "scanned_devices": scanned,
        "note": "" if candidates else "no_unrecorded_neighbours_in_collected_evidence",
    }
