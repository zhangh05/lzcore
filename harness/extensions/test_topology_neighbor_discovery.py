"""Legacy neighbour discovery is gone; drawings no longer invent device links."""

from __future__ import annotations

import pytest

from extensions.network_operations import service
from extensions.network_operations import topology_service as drawings


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    yield "test_topo_discovery_ws"


def test_discover_api_is_removed():
    assert not hasattr(service, "discover_topology_neighbors")
    assert not hasattr(service, "parse_neighbor_output")
    assert not hasattr(drawings, "discover_topology_neighbors")


def test_drawing_skill_prompt_forbids_discovery(workspace):
    topo = drawings.save_topology(workspace, {
        "name": "独立图纸",
        "nodes": [{"node_id": "n1", "display_name": "SW1", "x": 0, "y": 0}],
    })
    context = service.resolve_workbench_selection(workspace, {
        "skill_id": f"drawing:{topo['topology_id']}",
        "resource_ids": [topo["topology_id"]],
    })
    from extensions.network_operations.skill_prompt import render_network_skill_prompt
    text = render_network_skill_prompt(context)
    assert "discover" in text.lower()
    assert "real devices" in text.lower()
