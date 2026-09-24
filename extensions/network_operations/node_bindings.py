"""Human-confirmed links from drawing nodes to registered devices.

Bindings are not drawing fields, Skill resources, or model evidence. The canvas
reads them to show the latest stored observation. QueryLoop never does.
"""

from __future__ import annotations

import uuid
from typing import Any

from extensions.sdk import ExtensionDataStore
from storage.time_utils import now_iso

COLLECTION = "node_bindings"
_PUBLIC_DEVICE_FIELDS = ("device_id", "name", "host", "vendor", "device_type")
_PUBLIC_CONNECTION_FIELDS = ("connection_id", "status", "last_tested_at")


def _store(workspace_id: str) -> ExtensionDataStore:
    return ExtensionDataStore("network.operations", workspace_id)


def _key(topology_id: str, node_id: str) -> str:
    return f"{topology_id}__{node_id}"


def _clean_id(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 80 or any(char in text for char in "/\\"):
        raise ValueError(f"invalid_{label}")
    return text


def bind_node(
    workspace_id: str,
    topology_id: str,
    node_id: str,
    device_id: str,
    *,
    actor: str = "",
) -> dict[str, Any]:
    from . import service
    from . import topology_service as drawings

    topology_id = _clean_id(topology_id, "topology_id")
    node_id = _clean_id(node_id, "node_id")
    device_id = _clean_id(device_id, "device_id")
    topology = drawings.get_topology(workspace_id, topology_id)
    if not topology:
        raise ValueError("topology_not_found")
    if not any(str(node.get("node_id") or "") == node_id for node in topology.get("nodes") or []):
        raise ValueError("topology_node_not_found")
    if not service.get_device(workspace_id, device_id):
        raise ValueError("device_not_found")
    store = _store(workspace_id)
    existing = store.get(COLLECTION, _key(topology_id, node_id)) or {}
    same_device = str(existing.get("device_id") or "") == device_id
    record = {
        "binding_id": str(existing.get("binding_id") or f"bind_{uuid.uuid4().hex[:12]}"),
        "topology_id": topology_id,
        "node_id": node_id,
        "device_id": device_id,
        "bound_by": str(actor or existing.get("bound_by") or "").strip()[:80],
        "bound_at": str(existing.get("bound_at") or now_iso()) if same_device else now_iso(),
        "updated_at": now_iso(),
    }
    store.save(COLLECTION, _key(topology_id, node_id), record)
    return record


def unbind_node(workspace_id: str, topology_id: str, node_id: str) -> bool:
    topology_id = _clean_id(topology_id, "topology_id")
    node_id = _clean_id(node_id, "node_id")
    return _store(workspace_id).delete(COLLECTION, _key(topology_id, node_id))


def prune_node_bindings(workspace_id: str, topology_id: str, surviving_node_ids: set[str]) -> int:
    removed = 0
    store = _store(workspace_id)
    for item in store.list(COLLECTION, limit=2000):
        if str(item.get("topology_id") or "") != topology_id:
            continue
        node_id = str(item.get("node_id") or "")
        if node_id in surviving_node_ids:
            continue
        if store.delete(COLLECTION, _key(topology_id, node_id)):
            removed += 1
    return removed


def delete_topology_bindings(workspace_id: str, topology_id: str) -> int:
    return prune_node_bindings(workspace_id, topology_id, set())


def list_overlay(workspace_id: str, topology_id: str) -> list[dict[str, Any]]:
    from . import service
    from . import topology_service as drawings

    topology_id = _clean_id(topology_id, "topology_id")
    topology = drawings.get_topology(workspace_id, topology_id)
    if not topology:
        raise ValueError("topology_not_found")
    node_ids = {str(node.get("node_id") or "") for node in topology.get("nodes") or []}
    devices = {
        str(item.get("device_id") or ""): item
        for item in service.list_devices(workspace_id)
    }
    connections = service.list_connections(workspace_id)
    observations = service.list_observations(workspace_id, limit=500)
    overlays = []
    for item in _store(workspace_id).list(COLLECTION, limit=2000):
        if str(item.get("topology_id") or "") != topology_id:
            continue
        node_id = str(item.get("node_id") or "")
        if node_id not in node_ids:
            continue
        device_id = str(item.get("device_id") or "")
        device = devices.get(device_id)
        device_connections = [
            row for row in connections if str(row.get("device_id") or "") == device_id
        ]
        connection_ids = {str(row.get("connection_id") or "") for row in device_connections}
        overlays.append({
            "binding_id": str(item.get("binding_id") or ""),
            "topology_id": topology_id,
            "node_id": node_id,
            "device_id": device_id,
            "bound_at": str(item.get("bound_at") or ""),
            "device_state": "bound" if device else "missing",
            "device": _public_device(device) if device else None,
            "connection": _latest_connection(device_connections),
            "observation": _latest_observation(observations, connection_ids),
        })
    overlays.sort(key=lambda row: row["node_id"])
    return overlays


def _public_device(device: dict[str, Any]) -> dict[str, str]:
    return {key: str(device.get(key) or "") for key in _PUBLIC_DEVICE_FIELDS}


def _latest_connection(connections: list[dict[str, Any]]) -> dict[str, str] | None:
    if not connections:
        return None
    chosen = max(
        connections,
        key=lambda row: (str(row.get("last_tested_at") or ""), str(row.get("connection_id") or "")),
    )
    return {key: str(chosen.get(key) or "") for key in _PUBLIC_CONNECTION_FIELDS}


def _latest_observation(
    observations: list[dict[str, Any]],
    connection_ids: set[str],
) -> dict[str, str] | None:
    if not connection_ids:
        return None
    for observation in observations:
        targets = {str(item) for item in observation.get("target_ids") or []}
        matched = connection_ids.intersection(targets)
        if not matched:
            continue
        snapshot = observation.get("snapshot") if isinstance(observation.get("snapshot"), dict) else {}
        target_status = "unknown"
        for connection_id in sorted(matched):
            entry = snapshot.get(connection_id)
            if isinstance(entry, dict) and entry.get("status"):
                target_status = str(entry.get("status") or "unknown")
                break
        return {
            "observation_id": str(observation.get("observation_id") or ""),
            "observed_at": str(observation.get("observed_at") or ""),
            "completeness": str(observation.get("completeness") or "unknown"),
            "target_status": target_status,
        }
    return None
