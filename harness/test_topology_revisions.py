"""Topology revision history: snapshot, diff and restore.

The canvas saves on every drag, so the behaviour that matters is *what does not
become a revision*.  History is only useful when it holds structural edits.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extensions.network_operations import service  # noqa: E402
from extensions.sdk import ExtensionDataStore  # noqa: E402

_COLLECTIONS = ("topologies", "devices", "topology_revisions")


def _purge(ws_id: str) -> None:
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    for col in _COLLECTIONS:
        for item in store.list(col, limit=500):
            for field in ("topology_id", "device_id", "revision_id"):
                key = item.get(field)
                if key:
                    store.delete(col, str(key))
                    break


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    ws_id = "test_topo_revision_ws"
    _purge(ws_id)
    yield ws_id
    _purge(ws_id)


def _two_node_topology(workspace: str) -> dict:
    first = service.save_device(workspace, {"name": "R1", "host": "10.7.1.1", "vendor": "h3c"})
    second = service.save_device(workspace, {"name": "R2", "host": "10.7.1.2", "vendor": "h3c"})
    return service.save_topology(workspace, {
        "name": "Revision subject",
        "nodes": [
            {"node_id": "r1", "linked_device_id": first["device_id"], "x": 100, "y": 100},
            {"node_id": "r2", "linked_device_id": second["device_id"], "x": 400, "y": 100},
        ],
    })


def test_layout_only_edits_do_not_create_revisions(workspace):
    topo = _two_node_topology(workspace)
    assert len(service.list_topology_revisions(workspace, topo["topology_id"])) == 1

    for step in range(4):
        moved = {
            **topo,
            "version": topo["version"] + step,
            "nodes": [
                {**topo["nodes"][0], "x": 100 + step * 8, "y": 100 + step * 8},
                topo["nodes"][1],
            ],
        }
        service.save_topology(workspace, moved)

    revisions = service.list_topology_revisions(workspace, topo["topology_id"])
    assert len(revisions) == 1
    # cheap listing: metadata only, never the whole snapshot
    assert "snapshot" not in revisions[0]
    assert revisions[0]["summary"] == {"nodes": 2, "links": 0, "groups": 0, "canvas_items": 0}


def test_structural_edits_are_recorded_and_diffed(workspace):
    topo = _two_node_topology(workspace)
    linked = service.save_topology(workspace, {
        **topo,
        "version": topo["version"],
        "links": [{"link_id": "l1", "source_node_id": "r1", "target_node_id": "r2", "status": "unknown"}],
    })
    assert len(service.list_topology_revisions(workspace, linked["topology_id"])) == 2

    first = service.list_topology_revisions(workspace, linked["topology_id"])[-1]
    diff = service.compare_topology_revision(workspace, topo["topology_id"], first["revision_id"])
    assert diff["summary"]["links_added"] == 1
    assert diff["links_added"][0]["label"] == "R1 ↔ R2"
    assert diff["summary"]["nodes_added"] == 0


def test_diff_reports_status_and_removal_changes(workspace):
    topo = _two_node_topology(workspace)
    linked = service.save_topology(workspace, {
        **topo,
        "version": topo["version"],
        "links": [{"link_id": "l1", "source_node_id": "r1", "target_node_id": "r2", "status": "unknown"}],
    })
    baseline = service.list_topology_revisions(workspace, linked["topology_id"])[0]

    service.save_topology(workspace, {
        **linked,
        "version": linked["version"],
        "links": [{"link_id": "l1", "source_node_id": "r1", "target_node_id": "r2", "status": "down"}],
    })
    changed = service.compare_topology_revision(workspace, topo["topology_id"], baseline["revision_id"])
    assert changed["summary"]["links_changed"] == 1
    assert changed["links_changed"][0]["changes"]["status"] == {"from": "unknown", "to": "down"}

    emptied = service.save_topology(workspace, {
        **linked,
        "version": linked["version"] + 1,
        "links": [],
    })
    removed = service.compare_topology_revision(workspace, topo["topology_id"], baseline["revision_id"])
    assert removed["summary"]["links_removed"] == 1
    assert emptied["links"] == []


def test_restore_rewrites_structure_as_a_new_version_and_keeps_current_layout(workspace):
    topo = _two_node_topology(workspace)
    linked = service.save_topology(workspace, {
        **topo,
        "version": topo["version"],
        "links": [{"link_id": "l1", "source_node_id": "r1", "target_node_id": "r2", "status": "unknown"}],
    })
    # Move a node, then drop the link: a later restore must not teleport it back.
    service.save_topology(workspace, {
        **linked,
        "version": linked["version"],
        "nodes": [{**linked["nodes"][0], "x": 900, "y": 700}, linked["nodes"][1]],
        "links": [],
    })
    revisions = service.list_topology_revisions(workspace, linked["topology_id"])
    baseline = next(item for item in revisions if item["version"] == linked["version"])

    restored = service.restore_topology_revision(workspace, topo["topology_id"], baseline["revision_id"])
    assert len(restored["links"]) == 1
    assert restored["version"] > linked["version"] + 1
    positions = {node["node_id"]: (node["x"], node["y"]) for node in restored["nodes"]}
    assert positions["r1"] == (900.0, 700.0)
    # History is append-only: restoring never erases how we got here.
    assert len(service.list_topology_revisions(workspace, linked["topology_id"])) == 4


def test_revision_history_is_removed_with_the_topology(workspace):
    topo = _two_node_topology(workspace)
    assert service.list_topology_revisions(workspace, topo["topology_id"])
    service.delete_topology(workspace, topo["topology_id"])
    assert service.list_topology_revisions(workspace, topo["topology_id"]) == []


def test_history_gets_a_baseline_for_drawings_that_predate_it(workspace):
    topo = _two_node_topology(workspace)
    store = ExtensionDataStore("network.operations", workspace_id=workspace)
    for revision in service._topology_revisions(workspace, topo["topology_id"]):
        store.delete("topology_revisions", str(revision["revision_id"]))

    revisions = service.list_topology_revisions(workspace, topo["topology_id"])
    assert len(revisions) == 1
    assert revisions[0]["summary"] == {"nodes": 2, "links": 0, "groups": 0, "canvas_items": 0}
    # The baseline is created once, not on every read.
    assert len(service.list_topology_revisions(workspace, topo["topology_id"])) == 1


def test_missing_topology_has_no_history(workspace):
    assert service.list_topology_revisions(workspace, "topo_does_not_exist") == []


def test_history_stays_bounded(workspace):
    topo = _two_node_topology(workspace)
    current = topo
    for index in range(service.TOPOLOGY_REVISION_LIMIT + 6):
        current = service.save_topology(workspace, {
            **current,
            "version": current["version"],
            "nodes": current["nodes"] + [
                {"node_id": f"extra-{index}", "display_name": f"N{index}", "x": index * 10, "y": 0}
            ],
        })
    revisions = service.list_topology_revisions(workspace, topo["topology_id"])
    assert len(revisions) == service.TOPOLOGY_REVISION_LIMIT
    # The retained window is the newest one.
    assert revisions[0]["version"] == current["version"]


def test_each_drawing_keeps_its_own_history(workspace):
    """Two busy drawings in one workspace must not mix or starve each other.

    A shared collection read behind a cap would drop one drawing's history as
    soon as the workspace total grew; per-drawing collections keep every
    drawing's retention window intact.
    """
    first = _two_node_topology(workspace)
    second = service.save_topology(workspace, {"name": "Second canvas", "nodes": []})

    for drawing, prefix in ((first, "a"), (second, "b")):
        current = drawing
        for index in range(6):
            current = service.save_topology(workspace, {
                **current,
                "version": current["version"],
                "nodes": current["nodes"] + [
                    {"node_id": f"{prefix}-{index}", "display_name": f"{prefix}{index}", "x": index * 12, "y": 0}
                ],
            })

    first_revisions = service.list_topology_revisions(workspace, first["topology_id"])
    second_revisions = service.list_topology_revisions(workspace, second["topology_id"])
    assert len(first_revisions) == 7
    assert len(second_revisions) == 7
    assert all(item["summary"]["nodes"] == 2 + index for index, item in enumerate(reversed(first_revisions)))

    # A revision id is meaningless without the drawing it belongs to.
    foreign = first_revisions[0]["revision_id"]
    assert service.get_topology_revision(workspace, second["topology_id"], foreign) is None
    assert service.get_topology_revision(workspace, first["topology_id"], foreign) is not None
