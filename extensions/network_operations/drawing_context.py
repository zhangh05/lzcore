"""Drawing-only context derived from persisted objects, never client captions."""
from __future__ import annotations

COLLECTIONS = (("node_ids", "nodes", "node_id"), ("link_ids", "links", "link_id"),
               ("canvas_item_ids", "canvas_items", "item_id"), ("group_ids", "groups", "group_id"))


def drawing_subset(topology, selection, include_neighbors=True):
    selected = {}
    unavailable = {}
    for field, collection, key in COLLECTIONS:
        ids = selection.get(field, [])
        if not isinstance(ids, list) or any(not isinstance(value, str) for value in ids):
            raise ValueError("canvas_selection_invalid")
        wanted = set(ids)
        selected[collection] = [item for item in topology.get(collection, []) if item[key] in wanted]
        found = {item[key] for item in selected[collection]}
        unavailable[field] = list(dict.fromkeys(value for value in ids if value not in found))
    node_ids = {item["node_id"] for item in selected["nodes"]}
    for link in selected["links"]:
        node_ids.update((link["source_node_id"], link["target_node_id"]))
    zones = {item.get("zone") for item in selected["canvas_items"] if item.get("zone")}
    group_ids = {item["group_id"] for item in selected["groups"]}
    node_ids.update(item["node_id"] for item in topology.get("nodes", [])
                    if item.get("zone") in zones or item.get("group_id") in group_ids)
    lock_groups = {item.get("lock_group") for item in topology.get("nodes", []) if item["node_id"] in node_ids and item.get("lock_group")}
    node_ids.update(item["node_id"] for item in topology.get("nodes", []) if item.get("lock_group") in lock_groups)
    if include_neighbors:
        incident = [link for link in topology.get("links", [])
                    if link["source_node_id"] in node_ids or link["target_node_id"] in node_ids]
        node_ids.update(endpoint for link in incident for endpoint in (link["source_node_id"], link["target_node_id"]))
    selected["nodes"] = [item for item in topology.get("nodes", []) if item["node_id"] in node_ids]
    selected_link_ids = {item["link_id"] for item in selected["links"]}
    selected["links"] = [link for link in topology.get("links", []) if link["link_id"] in selected_link_ids
                         or (include_neighbors and link["source_node_id"] in node_ids and link["target_node_id"] in node_ids)]
    member_zones = {item.get("zone") for item in selected["nodes"] if item.get("zone")}
    item_ids = {item["item_id"] for item in selected["canvas_items"]}
    selected["canvas_items"] = [item for item in topology.get("canvas_items", [])
                                if item["item_id"] in item_ids or item.get("zone") in member_zones]
    member_groups = {item.get("group_id") for item in selected["nodes"] if item.get("group_id")}
    selected["groups"] = [item for item in topology.get("groups", []) if item["group_id"] in group_ids | member_groups]
    return {**{key: topology.get(key) for key in ("topology_id", "name", "description", "version")}, **selected}, unavailable


def selection_context(topology, selection):
    subset, _ = drawing_subset(topology, selection)
    # All selected objects and their rigid groups are retained. Extra neighbours
    # are bounded only in automatic prompt context; scoped read has no such cap.
    direct = set(selection.get("node_ids", []))
    direct_links = set(selection.get("link_ids", []))
    for link in subset["links"]:
        if link["link_id"] in direct_links:
            direct.update((link["source_node_id"], link["target_node_id"]))
    zones = {item.get("zone") for item in subset["canvas_items"] if item["item_id"] in set(selection.get("canvas_item_ids", [])) and item.get("zone")}
    groups = set(selection.get("group_ids", []))
    direct.update(item["node_id"] for item in subset["nodes"] if item.get("zone") in zones or item.get("group_id") in groups)
    locks = {item.get("lock_group") for item in subset["nodes"] if item["node_id"] in direct and item.get("lock_group")}
    required = [item for item in subset["nodes"] if item["node_id"] in direct or item.get("lock_group") in locks]
    required_ids = {item["node_id"] for item in required}
    extra = [item for item in subset["nodes"] if item["node_id"] not in required_ids]
    subset["nodes"] = required + extra[:40]
    kept = {item["node_id"] for item in subset["nodes"]}
    links = [item for item in subset["links"] if item["source_node_id"] in kept and item["target_node_id"] in kept]
    subset["links"] = [item for item in links if item["link_id"] in direct_links] + [item for item in links if item["link_id"] not in direct_links][:80]
    subset["context_complete"] = len(extra) <= 40 and len(subset["links"]) == len(links)
    subset["snapshot_complete"] = False
    return subset
