"""Independent drawing persistence. No device execution, observation or discovery.

Keep the existing storage namespace so IDs, links and revision history survive.
Only the one-time legacy adapter reads asset names; normal drawing operations do not.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
import uuid
from functools import wraps
from typing import Any
from extensions.sdk import ExtensionDataStore
from storage.locking import FileLock
from storage.time_utils import now_iso


def _store(workspace_id: str) -> ExtensionDataStore:
    return ExtensionDataStore("network.operations", workspace_id)


def _notify_topology_saved(workspace_id: str, saved: dict[str, Any]) -> None:
    """One commit, one notice. patch_topology already ends in save_topology."""
    try:
        from backend.ws.agent_ws import broadcast_ws_event
        broadcast_ws_event({
            "name": "topology_updated",
            "data": {
                "workspace_id": workspace_id,
                "topology_id": str(saved.get("topology_id") or ""),
                "version": int(saved.get("version") or 0),
            },
        })
    except Exception:
        pass


def _sync_drawing_sessions(workspace_id: str, topology: dict) -> None:
    """Keep resource metadata and managed titles current, including offline clients."""
    from storage.session_store import list_sessions, update_session
    topology_id = topology["topology_id"]
    for session in list_sessions(workspace_id, limit=5000):
        metadata = dict(session.get("metadata") or {})
        raw_selection = metadata.get("workbench_selection")
        selection = dict(raw_selection) if isinstance(raw_selection, dict) else {}
        if metadata.get("topology_id") != topology_id and selection.get("skill_id") not in {
                f"drawing:{topology_id}", f"drawing:{topology_id}:ro"}:
            continue
        selection["skill_name"] = f"拓扑绘图 · {topology['name']}"
        title = session.get("title") or ""
        update_session(session["session_id"], workspace_id,
                       title=f"拓扑 · {topology['name']}" if title.startswith("拓扑 · ") else None,
                       metadata={"topology_name": topology["name"], "workbench_selection": selection})


def _drawing_transaction(func):
    @wraps(func)
    def mutate(workspace_id, *args, **kwargs):
        with FileLock(_store(workspace_id).root() / ".drawings.lock", timeout=10.0):
            return func(workspace_id, *args, **kwargs)
    return mutate


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _detached_snapshot(workspace_id: str, record: dict) -> dict:
    nodes, links = _topology_graph_for_read(record)
    for raw, node in zip(record.get("nodes") or [], nodes):
        asset_id = str(raw.get("linked_device_id") or raw.get("device_id") or "")
        asset = _store(workspace_id).get("devices", asset_id) if asset_id else None
        if asset:
            node["display_name"] = node["display_name"] or str(asset.get("name") or node["node_id"])
            if not raw.get("device_type"):
                node["device_type"] = str(asset.get("device_type") or "switch")
    for link in links:
        if link.get("source") == "discovered":
            link["source"] = "manual"
            link["status"] = "unknown"
            link["metadata"] = {**(link.get("metadata") or {}), "legacy_discovery": True}
    return {**record, "schema_version": 2, "nodes": nodes, "links": links}


@_drawing_transaction
def migrate_topology(workspace_id: str, topology_id: str) -> dict | None:
    store = _store(workspace_id)
    record = store.get("topologies", topology_id)
    if not record or int(record.get("schema_version") or 1) >= 3:
        return record
    if not store.get("topology_region_backups", topology_id):
        store.save("topology_region_backups", topology_id, record)
    from .region_geometry import migrate_regions
    migrated = migrate_regions(record)
    if int(record.get("schema_version") or 1) < 2:
        if not store.get("topology_asset_backups", topology_id):
            store.save("topology_asset_backups", topology_id, record)
        migrated = _detached_snapshot(workspace_id, migrated)
        migrated["schema_version"] = 3
    migrated["version"] = int(record.get("version") or 1) + 1
    migrated["updated_at"] = now_iso()
    store.save("topologies", topology_id, migrated)
    return migrated


def migrate_drawings(store: ExtensionDataStore) -> None:
    for record in store.list("topologies", limit=5000):
        migrate_topology(store.workspace_id, str(record["topology_id"]))


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
            "device_type": str(raw.get("device_type") or "switch"),
            "display_name": str(raw.get("display_name") or ""),
            "labels": list(raw.get("labels") or []),
            "region_id": raw.get("region_id") or None,
            "lock_group": str(raw.get("lock_group") or "").strip() or None,
            "x": raw.get("x", 0.0),
            "y": raw.get("y", 0.0),
            "ip": str(raw.get("ip") or "").strip() or None,
            "vendor": str(raw.get("vendor") or "").strip() or None,
            "model": str(raw.get("model") or "").strip() or None,
            "role": str(raw.get("role") or "").strip() or None,
            "vlan": str(raw.get("vlan") or "").strip() or None,
            "location": str(raw.get("location") or "").strip() or None,
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
    if int(record.get("schema_version") or 1) < 3:
        from .region_geometry import migrate_regions
        record = migrate_regions(record)
    nodes, links = _topology_graph_for_read(record)
    return {
        "topology_id": str(record.get("topology_id") or ""),
        "name": str(record.get("name") or ""),
        "description": str(record.get("description") or ""),
        "version": int(record.get("version") or 1),
        "region_migration_issues": list(record.get("region_migration_issues") or []),
        "nodes": nodes,
        "links": links,
        "groups": list(record.get("groups") or []),
        # Diagram annotations are user-owned visual context.  They are never
        # graph endpoints or execution targets.
        "canvas_items": list({str(item["item_id"]): item for item in record.get("canvas_items") or []}.values()),
        "created_at": str(record.get("created_at") or ""),
        "updated_at": str(record.get("updated_at") or ""),
    }


def list_topologies(workspace_id: str) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("topologies", limit=500)
    return [item for item in (get_topology(workspace_id, str(record["topology_id"])) for record in records) if item]


def get_topology(workspace_id: str, topology_id: str) -> dict[str, Any] | None:
    try:
        record = _store(workspace_id).get("topologies", topology_id)
    except ValueError:
        return None
    if record and int(record.get("schema_version") or 1) < 3:
        record = migrate_topology(workspace_id, topology_id)
    return _public_topology(record) if record else None


def _normalize_node_ip(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    if len(text) > 48:
        raise ValueError("topology_ip_invalid")
    clean_ip = text.split("/")[0].strip()
    try:
        ipaddress.ip_address(clean_ip)
        return text
    except ValueError as exc:
        raise ValueError("topology_ip_invalid") from exc


@_drawing_transaction
def save_topology(workspace_id: str, payload: dict[str, Any], *, edit_source: str = "manual") -> dict[str, Any]:
    topology_id = str(payload.get("topology_id") or _id("topo")).strip()
    existing = get_topology(workspace_id, topology_id)
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 80:
        if existing and existing.get("name"):
            name = str(existing.get("name") or "")[:80]
        else:
            name = "未命名图纸"

    # Optimistic concurrency check
    if existing is not None:
        expected_version = payload.get("version")
        if expected_version is None:
            raise ValueError("topology_version_conflict")
        if int(expected_version) != int(existing.get("version") or 1):
            raise ValueError("topology_version_conflict")
        new_version = int(existing.get("version") or 1) + 1
    else:
        new_version = 1

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
        if not node_id:
            node_id = _id("node")
        if node_id in seen_node_ids:
            normalized_nodes = [n for n in normalized_nodes if n["node_id"] != node_id]
        seen_node_ids.add(node_id)
        if raw.get("linked_device_id") or raw.get("device_id"):
            raise ValueError("topology_asset_association_removed")
        try:
            x = float(raw.get("x", 0.0))
            y = float(raw.get("y", 0.0))
        except (TypeError, ValueError):
            x, y = 0.0, 0.0
        if not math.isfinite(x):
            x = 0.0
        if not math.isfinite(y):
            y = 0.0
        if any(key in raw for key in ("zone", "group_id", "group")):
            raise ValueError("topology_legacy_region_fields_use_region_id")
        normalized_nodes.append({
            "node_id": node_id,
            "device_type": str(raw.get("device_type") or "switch").strip()[:48],
            "display_name": str(raw.get("display_name") or "").strip()[:80],
            "labels": list(dict.fromkeys(str(label).strip()[:80] for label in (raw.get("labels") or []) if str(label).strip())) if isinstance(raw.get("labels", []), list) else [],
            "region_id": str(raw.get("region_id") or "").strip() or None,
            "lock_group": str(raw.get("lock_group") or "").strip() or None,
            "x": x,
            "y": y,
            "ip": _normalize_node_ip(raw.get("ip")),
            "vendor": str(raw.get("vendor") or "").strip()[:48] or None,
            "model": str(raw.get("model") or "").strip()[:48] or None,
            "role": str(raw.get("role") or "").strip()[:32] or None,
            "vlan": str(raw.get("vlan") or "").strip()[:32] or None,
            "location": str(raw.get("location") or "").strip()[:64] or None,
        })

    if payload.get("groups"):
        raise ValueError("topology_legacy_regions_removed_use_canvas_items")
    normalized_groups: list[dict[str, Any]] = []

    raw_canvas_items = payload.get("canvas_items") if "canvas_items" in payload else (existing.get("canvas_items") if existing else [])
    if not isinstance(raw_canvas_items, list):
        raise ValueError("canvas_items must be a list")
    normalized_canvas_items: list[dict[str, Any]] = []
    seen_canvas_item_ids: set[str] = set()
    for raw in raw_canvas_items:
        if not isinstance(raw, dict):
            continue
        if "auto_fit" in raw and not isinstance(raw["auto_fit"], bool):
            raise ValueError("topology_auto_fit_invalid")
        if "zone" in raw:
            raise ValueError("topology_legacy_region_fields_use_item_id")
        item_id = str(raw.get("item_id") or _id("canvas")).strip()
        if item_id in seen_canvas_item_ids:
            normalized_canvas_items = [item for item in normalized_canvas_items if item["item_id"] != item_id]
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
        if not math.isfinite(x):
            x = 0.0
        if not math.isfinite(y):
            y = 0.0
        if not math.isfinite(width) or width <= 0:
            width = 180.0
        if not math.isfinite(height) or height <= 0:
            height = 96.0
        style = dict(raw.get("style") or {}) if isinstance(raw.get("style"), dict) else {}
        safe_style = {}
        for key in ("fill", "border", "color"):
            val = str(style.get(key) or "").strip()
            if val:
                # Valid color format: #hex (3..8 hex chars), rgba?(...), none, or alphanumeric CSS color name
                if (
                    re.match(r"^#(?:[0-9a-fA-F]{3,8})$", val)
                    or re.match(r"^rgba?\([0-9\s,\.%]+\)$", val)
                    or re.match(r"^[a-zA-Z]{1,24}$", val)
                ):
                    safe_style[key] = val[:32]
        if "borderWidth" in style:
            try:
                border_width = float(style["borderWidth"])
                if math.isfinite(border_width):
                    safe_style["borderWidth"] = max(0, min(20, border_width))
            except (ValueError, TypeError):
                pass
        normalized_canvas_items.append({
            "item_id": item_id,
            "kind": kind,
            "text": str(raw.get("text") or "").strip()[:240],
            "x": x,
            "y": y,
            "width": min(10000.0, max(40.0, width)),
            "height": min(10000.0, max(24.0, height)),
            "style": safe_style,

            **({"auto_fit": bool(raw["auto_fit"])} if "auto_fit" in raw else {}),
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
            continue
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
        source = "manual"
        # A label is a human description, not a generated endpoint caption.
        # Interfaces already have their own compact labels on the canvas.
        label = str(raw.get("label") or "").strip()
        metadata = dict(raw.get("metadata") or {}) if isinstance(raw.get("metadata"), dict) else {}
        evidence_refs = [str(item).strip() for item in (raw.get("evidence_refs") or []) if str(item).strip()]
        style = dict(raw.get("style") or {}) if isinstance(raw.get("style"), dict) else {}
        cleaned_style: dict[str, Any] = {}
        if "color" in style and isinstance(style["color"], str) and style["color"].strip():
            cleaned_style["color"] = style["color"].strip()[:32]
        if "width" in style:
            try:
                cleaned_style["width"] = round(max(0.5, min(20.0, float(style["width"]))), 1)
            except (TypeError, ValueError):
                pass
        if "line_style" in style and str(style["line_style"]).strip() in {"solid", "dashed", "dotted"}:
            cleaned_style["line_style"] = str(style["line_style"]).strip()
        if "curve_style" in style and str(style["curve_style"]).strip() in {"auto", "bezier", "straight", "taxi", "unbundled-bezier"}:
            cleaned_style["curve_style"] = str(style["curve_style"]).strip()
        if "curve_reverse" in style:
            cleaned_style["curve_reverse"] = bool(style["curve_reverse"])

        link_entry: dict[str, Any] = {
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
        }
        if cleaned_style:
            link_entry["style"] = cleaned_style
        normalized_links.append(link_entry)

    remaining_items = {item["item_id"]: item for item in normalized_canvas_items}
    removed_items = {item["item_id"]: item for item in (existing or {}).get("canvas_items", [])
                     if item["item_id"] not in remaining_items}
    for node in normalized_nodes:
        removed = removed_items.get(node.get("region_id"))
        if removed:
            node["region_id"] = None
    for node in normalized_nodes:
        region_id = node.get("region_id")
        if region_id and (region_id not in remaining_items or remaining_items[region_id]["kind"] not in {"rectangle", "ellipse"}):
            raise ValueError("topology_region_not_found:" + region_id)
    from .region_geometry import fit_regions
    normalized_canvas_items = fit_regions(normalized_nodes, normalized_canvas_items)
    record = {
        "schema_version": 3,
        "region_migration_issues": [issue for issue in (existing or {}).get("region_migration_issues", [])
                                    if any(n["node_id"] == issue["node_id"] and not n.get("region_id") for n in normalized_nodes)],
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
    public_record = _public_topology(record)
    if existing and all(public_record[key] == existing.get(key) for key in
                        ("name", "description", "nodes", "links", "groups", "canvas_items")):
        return existing
    _store(workspace_id).save("topologies", topology_id, record)
    try:
        _record_topology_revision(workspace_id, record, before=existing, source=edit_source)
    except Exception:  # history is a convenience, never a reason to lose a save
        pass
    from .node_bindings import prune_node_bindings
    prune_node_bindings(
        workspace_id,
        topology_id,
        {str(node.get("node_id") or "") for node in normalized_nodes},
    )
    saved = _public_topology(record)
    if not existing or existing.get("name") != saved["name"]:
        _sync_drawing_sessions(workspace_id, saved)
    _notify_topology_saved(workspace_id, saved)
    return saved


@_drawing_transaction
def patch_topology_with_receipt(workspace_id: str, topology_id: str, payload: dict[str, Any]) -> tuple[dict, dict, bool]:
    """Compute the model's receipt from the same locked baseline as its write."""
    from .drawing_feedback import change_set
    before = get_topology(workspace_id, topology_id)
    if not before:
        raise ValueError("topology_not_found")
    after = patch_topology(workspace_id, topology_id, payload)
    return after, change_set(before, after), after["version"] != before["version"]


@_drawing_transaction
def patch_topology(workspace_id: str, topology_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a small, versioned topology change without replacing the graph.

    This is the write path for an Agent.  A model normally knows only the
    objects it has just observed, so asking it to re-submit a whole canvas is
    both wasteful and unsafe: omitted objects must stay on the canvas.
    """
    existing = get_topology(workspace_id, topology_id)
    if not existing:
        raise ValueError("topology_not_found")
    current_version = int(existing.get("version") or 1)
    raw_version = payload.get("version")
    try:
        expected_version = current_version if raw_version is None else int(raw_version)
    except (TypeError, ValueError):
        raise ValueError("topology_version_invalid") from None
    if expected_version != current_version:
        raise ValueError("topology_version_conflict")

    def records(value: Any, field: str) -> list[dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
            raise ValueError(f"{field} must be a list of objects")
        return [dict(item) for item in value]

    raw_node_updates = payload.get("node_updates") if payload.get("node_updates") is not None else payload.get("nodes")
    raw_link_updates = payload.get("link_updates") if payload.get("link_updates") is not None else payload.get("links")
    if any(key in payload for key in ("group_updates", "groups", "zones", "remove_group_ids")):
        raise ValueError("topology_legacy_regions_removed_use_canvas_items")
    raw_item_updates = payload.get("canvas_item_updates") if payload.get("canvas_item_updates") is not None else payload.get("canvas_items")

    node_updates = records(raw_node_updates, "node_updates")
    link_updates = records(raw_link_updates, "link_updates")
    item_updates = records(raw_item_updates, "canvas_item_updates")
    remove_node_ids = {str(item).strip() for item in (payload.get("remove_node_ids") or []) if str(item).strip()}
    remove_link_ids = {
        str(item).strip() for item in (payload.get("remove_link_ids") or []) if str(item).strip()
    }
    if any(not isinstance(item, str) for item in (payload.get("remove_node_ids") or [])):
        raise ValueError("remove_node_ids must be a list of strings")
    if any(not isinstance(item, str) for item in (payload.get("remove_link_ids") or [])):
        raise ValueError("remove_link_ids must be a list of strings")

    nodes_by_id = {
        str(item.get("node_id") or ""): dict(item)
        for item in existing.get("nodes") or []
    }
    translate = payload.get("translate")
    if translate is not None:
        if not isinstance(translate, dict):
            raise ValueError("translate_invalid")
        ids = translate.get("node_ids", [])
        item_ids = translate.get("canvas_item_ids", [])
        existing_items = {item["item_id"]: item for item in existing.get("canvas_items") or []}
        if not isinstance(item_ids, list) or any(not isinstance(value, str) or value not in existing_items for value in item_ids):
            raise ValueError("translate_canvas_items_not_found")
        if not isinstance(ids, list) or not (ids or item_ids) or any(not isinstance(value, str) or value not in nodes_by_id for value in ids):
            raise ValueError("translate_nodes_not_found")
        try:
            dx, dy = float(translate.get("dx", 0)), float(translate.get("dy", 0))
        except (TypeError, ValueError):
            raise ValueError("translate_invalid") from None
        if not math.isfinite(dx) or not math.isfinite(dy):
            raise ValueError("translate_invalid")
        if "include_members" in translate and not isinstance(translate["include_members"], bool):
            raise ValueError("translate_invalid")
        if translate.get("include_members"):
            ids = list(dict.fromkeys([*ids, *(node_id for node_id, node in nodes_by_id.items()
                                            if node.get("region_id") in item_ids)]))
        explicit_items = {str(item.get("item_id") or item.get("id") or "") for item in item_updates
                          if "x" in item or "y" in item}
        item_updates = [{"item_id": item_id, "x": existing_items[item_id]["x"] + dx,
                         "y": existing_items[item_id]["y"] + dy,
                         "auto_fit": bool(existing_items[item_id].get("auto_fit")) if translate.get("include_members") else False}
                        for item_id in dict.fromkeys(item_ids) if item_id not in explicit_items] + item_updates
        explicit = {str(item.get("node_id") or item.get("id") or "") for item in node_updates if "x" in item or "y" in item}
        node_updates = [{"node_id": node_id, "x": nodes_by_id[node_id]["x"] + dx,
                         "y": nodes_by_id[node_id]["y"] + dy} for node_id in dict.fromkeys(ids) if node_id not in explicit] + node_updates
    for update in node_updates:
        node_id = str(update.get("node_id") or update.get("id") or "").strip()
        if not node_id:
            node_id = _id("node")
        update["node_id"] = node_id
        if not update.get("display_name") and (update.get("name") or update.get("label")):
            update["display_name"] = str(update.get("name") or update.get("label")).strip()
        if not update.get("device_type") and (update.get("type") or update.get("role")):
            update["device_type"] = str(update.get("type") or update.get("role")).strip()
        if any(key in update for key in ("zone", "group_id", "group")):
            raise ValueError("topology_legacy_region_fields_use_region_id")
        if "ip" in update and update["ip"] is not None:
            try:
                _normalize_node_ip(update["ip"])
            except ValueError:
                update["ip"] = None
        nodes_by_id[node_id] = {**nodes_by_id.get(node_id, {}), **update, "node_id": node_id}

    # A fixed-link group has the same displacement semantics as a manual drag.
    # Explicit coordinates take precedence; clearing lock_group detaches a node.
    originals = {node["node_id"]: node for node in existing.get("nodes") or []}
    direct = {item["node_id"] for item in node_updates if "x" in item or "y" in item}
    deltas = {}
    for node_id, original in originals.items():
        updated = nodes_by_id[node_id]
        group = updated.get("lock_group")
        if node_id in direct and group and group not in deltas:
            try:
                dx, dy = float(updated["x"]) - original["x"], float(updated["y"]) - original["y"]
            except (TypeError, ValueError):
                raise ValueError("node_position_invalid") from None
            if not math.isfinite(dx) or not math.isfinite(dy):
                raise ValueError("node_position_invalid")
            deltas[group] = (dx, dy)
    for node_id, node in nodes_by_id.items():
        if node_id not in direct and node_id in originals and node.get("lock_group") in deltas:
            dx, dy = deltas[node["lock_group"]]
            node["x"], node["y"] = originals[node_id]["x"] + dx, originals[node_id]["y"] + dy

    for node_id in remove_node_ids:
        nodes_by_id.pop(node_id, None)
    if remove_node_ids or any("lock_group" in item for item in node_updates):
        group_counts = {}
        for node in nodes_by_id.values():
            if node.get("lock_group"):
                group_counts[node["lock_group"]] = group_counts.get(node["lock_group"], 0) + 1
        for node in nodes_by_id.values():
            if node.get("lock_group") and group_counts[node["lock_group"]] < 2:
                node["lock_group"] = None

    links_by_id = {
        str(item.get("link_id") or ""): dict(item)
        for item in existing.get("links") or []
    }
    for update in link_updates:
        link_id = str(update.get("link_id") or update.get("id") or "").strip()
        src = str(
            update.get("source_node_id")
            or update.get("source")
            or update.get("source_id")
            or update.get("src")
            or update.get("from")
            or ""
        ).strip()
        tgt = str(
            update.get("target_node_id")
            or update.get("target")
            or update.get("target_id")
            or update.get("dst")
            or update.get("to")
            or ""
        ).strip()
        if src:
            update["source_node_id"] = src
        if tgt:
            update["target_node_id"] = tgt
        if not update.get("source_interface") and (update.get("source_port") or update.get("src_port") or update.get("src_iface")):
            update["source_interface"] = str(update.get("source_port") or update.get("src_port") or update.get("src_iface")).strip()
        if not update.get("target_interface") and (update.get("target_port") or update.get("dst_port") or update.get("dst_iface")):
            update["target_interface"] = str(update.get("target_port") or update.get("dst_port") or update.get("dst_iface")).strip()

        if link_id:
            links_by_id[link_id] = {**links_by_id.get(link_id, {}), **update, "link_id": link_id}
            continue
        # New links deliberately receive their id in save_topology.  Existing
        # links must be addressed by the id returned from a prior read.
        generated_id = _id("link")
        links_by_id[generated_id] = {**update, "link_id": generated_id}
    for link_id in remove_link_ids:
        links_by_id.pop(link_id, None)

    # Removing a node also removes only its incident links.  It must never
    # leave a graph whose links point at invisible/nonexistent nodes.
    surviving_nodes = set(nodes_by_id)
    links = []
    for link in links_by_id.values():
        source_node_id = str(link.get("source_node_id") or "")
        target_node_id = str(link.get("target_node_id") or "")
        if source_node_id not in surviving_nodes or target_node_id not in surviving_nodes:
            if source_node_id not in remove_node_ids and target_node_id not in remove_node_ids:
                raise ValueError("topology_link_endpoint_not_found")
            # Deliberate node deletion removes its incident links atomically.
            continue
        links.append(link)
    items_by_id = {item["item_id"]: dict(item) for item in existing.get("canvas_items") or []}
    for update in item_updates:
        item_id = str(update.get("item_id") or update.get("id") or "").strip()
        if not item_id:
            item_id = _id("item")
        update["item_id"] = item_id
        if any(key in update for key in ("x", "y", "width", "height")) and "auto_fit" not in update:
            update["auto_fit"] = False
        items_by_id[item_id] = {**items_by_id.get(item_id, {}), **update, "item_id": item_id}
    remove_items = payload.get("remove_canvas_item_ids") or []
    if not isinstance(remove_items, list) or any(not isinstance(value, str) for value in remove_items):
        raise ValueError("remove_canvas_item_ids must be a list of strings")
    if isinstance(remove_items, list):
        for item_id in remove_items:
            items_by_id.pop(str(item_id).strip(), None)

    if payload.get("layout") is not None:
        from .drawing_feedback import apply_optional_layout
        apply_optional_layout(nodes_by_id, payload["layout"], {
            item["node_id"] for item in node_updates if "x" in item or "y" in item
        } | {node_id for node_id, node in nodes_by_id.items() if node.get("lock_group") in deltas}, list(items_by_id.values()))

    # save_topology remains the single normalizer/validator for every graph
    # write.  It also keeps the stored representation and API representation
    # identical to manual canvas saves.
    return save_topology(workspace_id, {
        **existing,
        "topology_id": topology_id,
        "version": expected_version,
        "nodes": list(nodes_by_id.values()),
        "links": links,
        "groups": [],
        "canvas_items": list(items_by_id.values()),
        "name": payload.get("name", existing["name"]),
        "description": payload.get("description", existing["description"]),
    }, edit_source="agent")


@_drawing_transaction
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
# connected. Saved geometry edits also receive persistent change records.
# ---------------------------------------------------------------------------

TOPOLOGY_REVISION_LIMIT = 40


def _topology_structure_signature(topology: dict[str, Any]) -> str:
    payload = {
        "name": str(topology.get("name") or ""),
        "nodes": sorted(
            [
                [
                    str(node.get("node_id") or ""),
                    str(node.get("device_type") or ""),
                    str(node.get("display_name") or ""),
                    str(node.get("region_id") or ""),
                    str(node.get("ip") or ""),
                    str(node.get("vendor") or ""),
                    str(node.get("model") or ""),
                    str(node.get("role") or ""),
                    str(node.get("vlan") or ""),
                    str(node.get("location") or ""),
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


def _revision_edit(before: dict, after: dict) -> dict:
    """Store only changed objects for a conflict-aware inverse, never another full graph."""
    old = {key: before.get(key) for key in ("topology_id", "version", "name", "description")}
    new = {key: after.get(key) for key in old}
    activity = {"ids": [], "added": 0, "modified": 0, "removed": 0, "removedLabels": []}
    for collection, key, prefix in (("nodes", "node_id", ""), ("links", "link_id", ""),
                                  ("groups", "group_id", "group-"), ("canvas_items", "item_id", "canvas-")):
        previous = {item[key]: item for item in before.get(collection, [])}
        current = {item[key]: item for item in after.get(collection, [])}
        identities = {identity for identity in previous.keys() | current.keys()
                      if previous.get(identity) != current.get(identity)}
        old[collection] = [item for item in before.get(collection, []) if item[key] in identities]
        new[collection] = [item for item in after.get(collection, []) if item[key] in identities]
        for identity in sorted(identities):
            if identity not in current:
                item = previous[identity]
                activity["removed"] += 1
                activity["removedLabels"].append(str(item.get("display_name") or item.get("text") or item.get("name") or identity))
            else:
                activity["ids"].append(prefix + identity)
                activity["modified" if identity in previous else "added"] += 1
    if any(before.get(key) != after.get(key) for key in ("name", "description")):
        activity["modified"] += 1
    return {"before": old, "after": new, "activity": activity}


def _record_topology_revision(workspace_id: str, record: dict[str, Any], *, before: dict | None = None, source: str = "manual") -> None:
    """Persist saved drawing edits, including geometry, in the existing bounded history."""
    signature = hashlib.sha256(json.dumps({key: record.get(key) for key in
        ("name", "description", "nodes", "links", "groups", "canvas_items")}, sort_keys=True).encode()).hexdigest()
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
        "source": source,
        "edit": _revision_edit(before, _public_topology(record)) if before else None,
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


@_drawing_transaction
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
            "source": item.get("source", "manual"),
            "activity": (item.get("edit") or {}).get("activity"),
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
    # Old persisted inverse edits also need the full regional context. Migrating
    # the sparse delta alone would lose references to unchanged frames.
    snapshot = record.get("snapshot") or {}
    if record.get("edit") and int(snapshot.get("schema_version") or 1) < 3:
        from copy import deepcopy
        before = deepcopy(snapshot)
        edit = record["edit"]
        for collection, key in (("nodes", "node_id"), ("links", "link_id"),
                                ("groups", "group_id"), ("canvas_items", "item_id")):
            items = {item[key]: item for item in before.get(collection, [])}
            for item in edit["after"].get(collection, []):
                items.pop(item[key], None)
            items.update({item[key]: item for item in edit["before"].get(collection, [])})
            before[collection] = list(items.values())
        for key in ("version", "name", "description"):
            if key in edit["before"]:
                before[key] = edit["before"][key]
        record = {**record, "edit": _revision_edit(_public_topology(before), _public_topology(snapshot))}
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
        "style": dict(link.get("style") or {}),
    }


def _node_facts(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "device_type": str(node.get("device_type") or ""),
        "display_name": str(node.get("display_name") or ""),
        "region_id": str(node.get("region_id") or ""),
        "lock_group": str(node.get("lock_group") or ""),
        "ip": str(node.get("ip") or ""),
        "vendor": str(node.get("vendor") or ""),
        "model": str(node.get("model") or ""),
        "role": str(node.get("role") or ""),
        "vlan": str(node.get("vlan") or ""),
        "location": str(node.get("location") or ""),
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
    snapshot = _public_topology(record.get("snapshot") or {})
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


@_drawing_transaction
def restore_topology_revision(
    workspace_id: str,
    topology_id: str,
    revision_id: str,
    *,
    restore_layout: bool = True,
) -> dict[str, Any]:
    """Roll the canvas back to a revision.

    Restoring is a forward edit, not a rewrite of history: it writes the old
    structure as a new version, so the undo trail itself stays intact.
    """
    record = get_topology_revision(workspace_id, topology_id, revision_id)
    if not record:
        raise ValueError("topology_revision_not_found")
    from .region_geometry import migrate_regions
    snapshot = _detached_snapshot(workspace_id, migrate_regions(json.loads(json.dumps(record.get("snapshot") or {}))))
    snapshot["schema_version"] = 3
    topology_id = str(record.get("topology_id") or "")
    current = get_topology(workspace_id, topology_id)
    if not current:
        raise ValueError("topology_not_found")

    # Snapshot current state before restoring so user never loses current work (P0-4)
    _record_topology_revision(workspace_id, current)

    restored_nodes = (
        snapshot.get("nodes") or []
        if restore_layout
        else _restore_with_current_layout(snapshot.get("nodes") or [], current.get("nodes") or [])
    )

    return save_topology(workspace_id, {
        **snapshot,
        "topology_id": topology_id,
        "version": current.get("version"),
        "nodes": restored_nodes,
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


@_drawing_transaction
def delete_topology(workspace_id: str, topology_id: str) -> bool:
    record = get_topology(workspace_id, topology_id)
    if not record:
        return False
    store = _store(workspace_id)
    collection = _revision_collection(topology_id)
    for revision in _topology_revisions(workspace_id, topology_id):
        store.delete(collection, str(revision.get("revision_id") or ""))
    from .node_bindings import delete_topology_bindings
    delete_topology_bindings(workspace_id, topology_id)
    store.delete("annotations", topology_id)
    return store.delete("topologies", topology_id)
