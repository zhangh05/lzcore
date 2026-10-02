"""Drawing-only change receipts, approximate geometry and optional placement."""
from __future__ import annotations
import math


def change_set(before: dict, after: dict) -> dict:
    result = {}
    for collection, key in (("nodes", "node_id"), ("links", "link_id"),
                            ("groups", "group_id"), ("canvas_items", "item_id")):
        previous = {item[key]: item for item in before.get(collection, [])}
        current = {item[key]: item for item in after.get(collection, [])}
        result[collection] = {"upserted": [item for identity, item in current.items() if previous.get(identity) != item],
                              "removed_ids": [identity for identity in previous if identity not in current]}
    result["properties"] = {key: after[key] for key in ("name", "description") if before.get(key) != after.get(key)}
    return result


def geometry_feedback(topology: dict) -> dict:
    # Match the footprint used by the existing ELK layout. Actual text widths,
    # edge routing and viewport zoom require rendered inspection.
    nodes = sorted(topology.get("nodes", []), key=lambda node: node["x"])
    overlaps, overlap_count = [], 0
    for index, left in enumerate(nodes):
        for right_index in range(index + 1, len(nodes)):
            right = nodes[right_index]
            if right["x"] - left["x"] >= 140:
                break
            if abs(left["y"] - right["y"]) < 110:
                overlap_count += 1
                if len(overlaps) < 50:
                    overlaps.append([left["node_id"], right["node_id"]])
    return {"basis": "estimated_140x110_node_footprint_not_visual_validation",
            "node_overlap_count": overlap_count, "node_overlap_pairs": overlaps,
            "overlap_pairs_complete": overlap_count == len(overlaps),
            "bounds": ({"left": min(n["x"] for n in nodes) - 70, "top": min(n["y"] for n in nodes) - 55,
                        "right": max(n["x"] for n in nodes) + 70, "bottom": max(n["y"] for n in nodes) + 55} if nodes else None),
            "regions": region_feedback(topology),
            "visual_checks_pending": ["label_width", "edge_routing", "viewport"]}


def apply_optional_layout(nodes: dict, layout: dict, explicit_positions: set[str], items: list[dict] | None = None) -> None:
    if not isinstance(layout, dict) or layout.get("algorithm") not in {"grid", "radial"}:
        raise ValueError("drawing_layout_invalid")
    ids = layout.get("node_ids", list(nodes))
    preserve = layout.get("preserve_node_ids", [])
    if any(not isinstance(value, list) or any(not isinstance(item, str) for item in value) for value in (ids, preserve)):
        raise ValueError("drawing_layout_ids_invalid")
    if any(identity not in nodes for identity in [*ids, *preserve]):
        raise ValueError("drawing_layout_node_not_found")
    protected = set(preserve) | explicit_positions
    protected_groups = {nodes[identity].get("lock_group") for identity in protected if nodes[identity].get("lock_group")}
    protected.update(identity for identity, node in nodes.items() if node.get("lock_group") in protected_groups)
    try:
        origin = layout.get("origin") or {}
        x, y = float(origin.get("x", 0)), float(origin.get("y", 0))
        sx, sy = float(layout.get("spacing_x", 240)), float(layout.get("spacing_y", 190))
        if not all(math.isfinite(v) for v in (x, y, sx, sy)) or min(sx, sy) < 140:
            raise ValueError("drawing_layout_spacing_invalid")
    except (AttributeError, TypeError, ValueError):
        raise ValueError("drawing_layout_geometry_invalid") from None
    if items and any(item.get("kind") in {"rectangle", "ellipse"} for item in items):
        _layout_region_units(nodes, layout, protected, items, ids)
        return
    selected = []
    seen_groups = set()
    for identity in dict.fromkeys(ids):
        group = nodes[identity].get("lock_group")
        if identity in protected or (group and group in seen_groups):
            continue
        selected.append(identity)
        if group:
            seen_groups.add(group)
    columns = max(1, math.ceil(math.sqrt(len(selected))))
    radius = max(sx, sy, math.hypot(140, 110) / (2 * math.sin(math.pi / len(selected)))) if len(selected) > 1 else 0
    for index, identity in enumerate(selected):
        if layout["algorithm"] == "grid":
            dx, dy = (index % columns) * sx, (index // columns) * sy
        else:
            angle = 2 * math.pi * index / max(1, len(selected)) - math.pi / 2
            dx, dy = radius * math.cos(angle), radius * math.sin(angle)
        anchor = nodes[identity]
        tx, ty = round(x + dx) - anchor["x"], round(y + dy) - anchor["y"]
        members = [node for node in nodes.values() if anchor.get("lock_group") and node.get("lock_group") == anchor["lock_group"]] or [anchor]
        for member in members:
            member.update(x=member["x"] + tx, y=member["y"] + ty)


def region_feedback(topology: dict) -> dict:
    from .region_geometry import REGION_KINDS, region_contains
    regions = {item["item_id"]: item for item in topology.get("canvas_items", []) if item["kind"] in REGION_KINDS}
    members = {identity: [] for identity in regions}
    unassigned, missing, outside = [], [], []
    for node in topology.get("nodes", []):
        identity = node.get("region_id")
        if not identity:
            unassigned.append(node["node_id"])
        elif identity not in regions:
            missing.append({"node_id": node["node_id"], "region_id": identity})
        else:
            members[identity].append(node["node_id"])
            if not region_contains(regions[identity], node):
                outside.append({"node_id": node["node_id"], "item_id": identity})
    overlapping, identical = [], []
    overlap_count = identical_count = 0
    boxes = list(regions.values())
    for index, left in enumerate(boxes):
        for right in boxes[index + 1:]:
            if abs(left["x"] - right["x"]) < (left["width"] + right["width"]) / 2 and abs(left["y"] - right["y"]) < (left["height"] + right["height"]) / 2:
                overlap_count += 1
                if len(overlapping) < 50:
                    overlapping.append([left["item_id"], right["item_id"]])
                if all(left[key] == right[key] for key in ("x", "y", "width", "height", "kind")):
                    identical_count += 1
                    if len(identical) < 50:
                        identical.append([left["item_id"], right["item_id"]])
    return {"basis": "estimated_node_footprint_and_region_bounds_not_visual_validation", "members": members,
            "unassigned_node_ids": unassigned, "missing_region_refs": missing, "outside_members": outside,
            "empty_region_ids": [identity for identity, nodes in members.items() if not nodes],
            "overlapping_region_pairs": overlapping, "identical_region_pairs": identical,
            "overlapping_region_count": overlap_count, "identical_region_count": identical_count,
            "region_pairs_complete": overlap_count == len(overlapping) and identical_count == len(identical),
            "migration_issues": topology.get("region_migration_issues", [])}


def _layout_region_units(nodes: dict, layout: dict, protected: set[str], items: list[dict], ids: list[str]) -> None:
    from copy import deepcopy
    from .region_geometry import region_bounds, region_contains, REGION_KINDS
    boxes = {item["item_id"]: item for item in items if item.get("kind") in REGION_KINDS}
    units = {}
    locks = {}
    for identity, node in nodes.items():
        key = node.get("region_id") if node.get("region_id") in boxes else None
        units.setdefault(key, {})[identity] = node
        if node.get("lock_group"):
            locks.setdefault(node["lock_group"], set()).add(key)
    cross = {key for key, regions in locks.items() if len(regions) > 1}
    movable = set(ids) - protected
    occupied = [item for item in boxes.values() if item.get("auto_fit") is not True or any(
        identity not in movable or node.get("lock_group") in cross for identity, node in units.get(item["item_id"], {}).items())]
    # Preserved unassigned nodes are obstacles too, including cross-region locks.
    if None in units and any(identity not in movable or node.get("lock_group") in cross
                             for identity, node in units[None].items()):
        occupied.append(region_bounds(list(units[None].values())))
    origin = layout.get("origin") or {}
    cursor_x, cursor_y = float(origin.get("x", 70)), float(origin.get("y", 70))
    if not math.isfinite(cursor_x) or not math.isfinite(cursor_y):
        raise ValueError("drawing_layout_geometry_invalid")
    for key, members in units.items():
        if any(identity not in movable or node.get("lock_group") in cross for identity, node in members.items()):
            continue
        local = deepcopy(members)
        options = {**layout, "node_ids": list(local), "preserve_node_ids": [], "origin": {"x": 0, "y": 0}}
        apply_optional_layout(local, options, set())
        item = boxes.get(key)
        bounds = region_bounds(list(local.values()), item["kind"] if item else "rectangle")
        if item and item.get("auto_fit") is not True:
            dx, dy = item["x"] - bounds["x"], item["y"] - bounds["y"]
            candidates = [{**node, "x": node["x"] + dx, "y": node["y"] + dy} for node in local.values()]
            if not all(region_contains(item, node) for node in candidates):
                continue
        else:
            changed = True
            while changed:
                changed = False
                for box in occupied:
                    if (cursor_x < box["x"] + box["width"] / 2 + 80 and cursor_x + bounds["width"] + 80 > box["x"] - box["width"] / 2
                            and cursor_y < box["y"] + box["height"] / 2 + 80 and cursor_y + bounds["height"] + 80 > box["y"] - box["height"] / 2):
                        cursor_x = box["x"] + box["width"] / 2 + 80
                        changed = True
            dx, dy = cursor_x + bounds["width"] / 2 - bounds["x"], cursor_y + bounds["height"] / 2 - bounds["y"]
            occupied.append({**bounds, "x": bounds["x"] + dx, "y": bounds["y"] + dy})
            cursor_x += bounds["width"] + 80
        for identity, node in local.items():
            nodes[identity].update(x=node["x"] + dx, y=node["y"] + dy)
