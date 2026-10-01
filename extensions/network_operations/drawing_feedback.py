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
            "visual_checks_pending": ["label_width", "edge_routing", "viewport"]}


def apply_optional_layout(nodes: dict, layout: dict, explicit_positions: set[str]) -> None:
    if not isinstance(layout, dict) or layout.get("algorithm") not in {"grid", "radial"}:
        raise ValueError("drawing_layout_invalid")
    ids = layout.get("node_ids", list(nodes))
    preserve = layout.get("preserve_node_ids", [])
    if any(not isinstance(value, list) or any(not isinstance(item, str) for item in value) for value in (ids, preserve)):
        raise ValueError("drawing_layout_ids_invalid")
    if any(identity not in nodes for identity in [*ids, *preserve]):
        raise ValueError("drawing_layout_node_not_found")
    protected = set(preserve) | explicit_positions
    selected = list(dict.fromkeys(identity for identity in ids if identity not in protected))
    try:
        origin = layout.get("origin") or {}
        x, y = float(origin.get("x", 0)), float(origin.get("y", 0))
        sx, sy = float(layout.get("spacing_x", 240)), float(layout.get("spacing_y", 190))
        if not all(math.isfinite(v) for v in (x, y, sx, sy)) or min(sx, sy) < 140:
            raise ValueError("drawing_layout_spacing_invalid")
    except (AttributeError, TypeError, ValueError):
        raise ValueError("drawing_layout_geometry_invalid") from None
    columns = max(1, math.ceil(math.sqrt(len(selected))))
    radius = max(sx, sy, math.hypot(140, 110) / (2 * math.sin(math.pi / len(selected)))) if len(selected) > 1 else 0
    for index, identity in enumerate(selected):
        if layout["algorithm"] == "grid":
            dx, dy = (index % columns) * sx, (index // columns) * sy
        else:
            angle = 2 * math.pi * index / max(1, len(selected)) - math.pi / 2
            dx, dy = radius * math.cos(angle), radius * math.sin(angle)
        nodes[identity].update(x=round(x + dx), y=round(y + dy))
