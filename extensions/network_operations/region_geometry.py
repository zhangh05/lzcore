"""Canonical region identity and conservative canvas geometry (center coordinates)."""
from __future__ import annotations

from copy import deepcopy
import math
import hashlib
import re

REGION_KINDS = {"rectangle", "ellipse"}
NODE_HALF_WIDTH = 70
NODE_HALF_HEIGHT = 55
PAD_X = 20
PAD_Y = 25
TITLE_HEIGHT = 24
MIN_WIDTH = 240
MIN_HEIGHT = 180


def region_bounds(nodes: list[dict], kind: str = "rectangle") -> dict:
    if not nodes:
        raise ValueError("region_members_required")
    left = min(node["x"] for node in nodes) - NODE_HALF_WIDTH - PAD_X
    right = max(node["x"] for node in nodes) + NODE_HALF_WIDTH + PAD_X
    top = min(node["y"] for node in nodes) - NODE_HALF_HEIGHT - PAD_Y - TITLE_HEIGHT
    bottom = max(node["y"] for node in nodes) + NODE_HALF_HEIGHT + PAD_Y
    factor = math.sqrt(2) if kind == "ellipse" else 1
    return {"x": (left + right) / 2, "y": (top + bottom) / 2,
            "width": max(MIN_WIDTH, (right - left) * factor),
            "height": max(MIN_HEIGHT, (bottom - top) * factor)}


def region_contains(item: dict, node: dict, *, footprint: bool = True) -> bool:
    rx, ry = item["width"] / 2, item["height"] / 2
    hx, hy = (NODE_HALF_WIDTH, NODE_HALF_HEIGHT) if footprint else (0, 0)
    dx, dy = abs(node["x"] - item["x"]) + hx, abs(node["y"] - item["y"]) + hy
    if item["kind"] == "ellipse":
        return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1
    return dx <= rx and dy <= ry and node["y"] - hy >= item["y"] - ry + TITLE_HEIGHT


def fit_regions(nodes: list[dict], items: list[dict]) -> list[dict]:
    members: dict[str, list[dict]] = {}
    for node in nodes:
        if node.get("region_id"):
            members.setdefault(node["region_id"], []).append(node)
    return [{**item, **region_bounds(members[item["item_id"]], item["kind"])}
            if item.get("auto_fit") is True and item["kind"] in REGION_KINDS and members.get(item["item_id"])
            else dict(item) for item in items]


def migrate_regions(record: dict) -> dict:
    """One-way adapter for persisted v1/v2 only, with no name fallback at runtime.

    Original records are backed up by migrate_topology before persistence.
    Ambiguous references stay unassigned and are reported instead of guessed.
    """
    result = deepcopy(record)
    if int(result.get("schema_version") or 1) >= 3:
        return result
    items = {item["item_id"]: item for item in result.get("canvas_items", [])}
    issues = []
    for group in result.get("groups", []):
        identity = group["group_id"]
        if identity not in items:
            items[identity] = {"item_id": identity, "kind": "rectangle", "text": group.get("name", ""),
                               "x": group.get("x", 0) + group.get("width", 320) / 2,
                               "y": group.get("y", 0) + group.get("height", 240) / 2,
                               "width": group.get("width", 320), "height": group.get("height", 240),
                               "auto_fit": False, "style": group.get("style", {})}
    regions = {key: item for key, item in items.items() if item.get("kind") in REGION_KINDS}
    aliases: dict[str, set[str]] = {}
    for identity, item in regions.items():
        for value in (item.get("zone"), item.get("text")):
            if value:
                aliases.setdefault(str(value), set()).add(identity)
    # Only known legacy auto-generated duplicates with one authored counterpart
    # can be consolidated. Same-name authored regions keep separate identities.
    redirects = {}
    for identity, item in regions.items():
        if identity == "zone-" + hashlib.sha256(str(item.get("zone") or "").encode()).hexdigest()[:16] and item.get("auto_fit") is True:
            targets = {key for key in aliases.get(str(item.get("zone") or ""), set())
                       if key != identity and not re.fullmatch(r"zone-[0-9a-f]{16}", key)}
            if len(targets) == 1:
                redirects[identity] = next(iter(targets))
    for node in result.get("nodes", []):
        explicit = str(node.get("region_id") or node.get("group_id") or "").strip()
        label = str(node.get("zone") or "").strip()
        target = redirects.get(explicit, explicit) if explicit in regions else None
        if not target:
            candidates = {redirects.get(key, key) for value in (explicit, label) for key in aliases.get(value, set())}
            if len(candidates) == 1:
                target = next(iter(candidates))
            elif explicit or label:
                issues.append({"node_id": node.get("node_id") or "node_" + str(node.get("device_id") or ""), "reason": "ambiguous_region" if candidates else "region_not_found"})
        node["region_id"] = target
        node.pop("zone", None)
        node.pop("group_id", None)
        node.pop("group", None)
    for identity in redirects:
        items.pop(identity)
    for item in items.values():
        item.pop("zone", None)
    result.update(schema_version=3, nodes=result.get("nodes", []), groups=[], canvas_items=list(items.values()),
                  region_migration_issues=issues)
    return result
