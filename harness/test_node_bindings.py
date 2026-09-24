"""Node bindings stay outside drawings, Skills, and model prompts."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from flask import Flask

from extensions.network_operations import backend, service
from extensions.network_operations import node_bindings
from extensions.network_operations import topology_service as drawings
from extensions.network_operations.skill_prompt import render_network_skill_prompt
from extensions.sdk import ExtensionDataStore


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    ws_id = "test_binding_ws"
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    for collection in ("topologies", "devices", "connections", "observations", "node_bindings"):
        for item in store.list(collection, limit=500):
            key = (
                item.get("topology_id")
                or item.get("device_id")
                or item.get("connection_id")
                or item.get("observation_id")
                or item.get("binding_id")
            )
            record_id = f"{item.get('topology_id')}__{item.get('node_id')}" if collection == "node_bindings" else str(key or "")
            if record_id:
                store.delete(collection, record_id)
    yield ws_id


@pytest.fixture
def app():
    application = Flask(__name__)
    backend.register_routes(application)
    return application


def _drawing(workspace: str) -> dict:
    return drawings.save_topology(workspace, {
        "name": "绑定图",
        "nodes": [
            {"node_id": "pe1", "display_name": "PE1", "device_type": "router", "x": 10, "y": 10},
        ],
    })


def _device(workspace: str, name: str = "PE1-asset") -> dict:
    return service.save_device(workspace, {
        "name": name,
        "host": "10.0.0.8",
        "vendor": "h3c",
        "device_type": "router",
    })


def test_bind_projects_latest_facts_without_joining_the_drawing(workspace):
    topo = _drawing(workspace)
    device = _device(workspace)
    store = ExtensionDataStore("network.operations", workspace)
    store.save("connections", "connection_pe1", {
        "connection_id": "connection_pe1",
        "device_id": device["device_id"],
        "protocol": "ssh",
        "port": 22,
        "status": "connected",
        "last_tested_at": "2026-09-23T01:00:00Z",
        "password_ref": "secret-must-not-leak",
    })
    store.save("observations", "obs_pe1", {
        "observation_id": "obs_pe1",
        "observed_at": "2026-09-23T02:00:00Z",
        "completeness": "complete",
        "target_ids": ["connection_pe1"],
        "snapshot": {"connection_pe1": {"status": "succeeded", "output": "display current-configuration"}},
    })

    bound = node_bindings.bind_node(workspace, topo["topology_id"], "pe1", device["device_id"], actor="operator")
    overlay = node_bindings.list_overlay(workspace, topo["topology_id"])

    assert bound["device_id"] == device["device_id"]
    assert overlay[0]["device_state"] == "bound"
    assert overlay[0]["connection"]["status"] == "connected"
    assert overlay[0]["observation"]["observed_at"] == "2026-09-23T02:00:00Z"
    assert overlay[0]["observation"]["completeness"] == "complete"
    assert "output" not in overlay[0]["observation"]
    assert "password_ref" not in str(overlay)
    saved = drawings.get_topology(workspace, topo["topology_id"])
    assert "device_id" not in saved["nodes"][0]
    assert "linked_device_id" not in saved["nodes"][0]


def test_missing_device_stays_unbound_from_the_symbol(workspace):
    topo = _drawing(workspace)
    device = _device(workspace)
    node_bindings.bind_node(workspace, topo["topology_id"], "pe1", device["device_id"])
    assert service.delete_device(workspace, device["device_id"]) is True
    overlay = node_bindings.list_overlay(workspace, topo["topology_id"])
    assert overlay[0]["device_state"] == "missing"
    assert overlay[0]["device"] is None
    assert drawings.get_topology(workspace, topo["topology_id"])["nodes"][0]["node_id"] == "pe1"


def test_removing_a_node_drops_its_binding_only(workspace):
    topo = _drawing(workspace)
    topo = drawings.save_topology(workspace, {
        **topo,
        "version": topo["version"],
        "nodes": [
            *topo["nodes"],
            {"node_id": "ce1", "display_name": "CE1", "device_type": "switch", "x": 40, "y": 40},
        ],
    })
    first = _device(workspace, "PE1-asset")
    second = _device(workspace, "CE1-asset")
    node_bindings.bind_node(workspace, topo["topology_id"], "pe1", first["device_id"])
    node_bindings.bind_node(workspace, topo["topology_id"], "ce1", second["device_id"])
    drawings.remove_topology_node(workspace, topo["topology_id"], "pe1", expected_version=topo["version"])
    remaining = {item["node_id"] for item in node_bindings.list_overlay(workspace, topo["topology_id"])}
    assert remaining == {"ce1"}


def test_binding_never_enters_skill_prompts_or_the_drawing_tool(workspace):
    topo = _drawing(workspace)
    device = _device(workspace)
    node_bindings.bind_node(workspace, topo["topology_id"], "pe1", device["device_id"])
    drawing = backend.topology_tool(SimpleNamespace(
        arguments={"action": "read", "topology_id": topo["topology_id"]},
        workspace_id=workspace,
        skill=f"drawing:{topo['topology_id']}",
    ))
    assert drawing["ok"] is True
    assert "bindings" not in drawing
    assert "overlay" not in drawing
    assert "device_id" not in drawing["topology"]["nodes"][0]
    drawing_prompt = render_network_skill_prompt({
        "skill_id": f"drawing:{topo['topology_id']}",
        "topology": {"topology_id": topo["topology_id"], "name": topo["name"], "version": topo["version"]},
        "allow_edit": False,
    })
    device_prompt = render_network_skill_prompt({
        "skill_id": "skill_devices",
        "skill_name": "设备巡检",
        "allowed_tool_ids": ["network.operations.device.manage"],
        "device_ids": [device["device_id"]],
        "connection_ids": [],
        "devices": [{"device_id": device["device_id"], "name": device["name"], "host": device["host"]}],
        "connections": [],
    })
    assert "bind_" not in drawing_prompt
    assert "node_bindings" not in drawing_prompt
    assert "bind_" not in device_prompt
    assert "associated_topology_scope" not in device_prompt


def test_overlay_route_is_not_a_drawing_write(workspace, app):
    topo = _drawing(workspace)
    device = _device(workspace)
    client = app.test_client()
    saved = client.put(
        f"/api/extensions/network.operations/topologies/{topo['topology_id']}/nodes/pe1/binding?workspace_id={workspace}",
        json={"device_id": device["device_id"]},
    )
    assert saved.status_code == 200
    listed = client.get(
        f"/api/extensions/network.operations/topologies/{topo['topology_id']}/overlay?workspace_id={workspace}",
    )
    assert listed.status_code == 200
    assert listed.get_json()["overlays"][0]["device_id"] == device["device_id"]
    removed = client.delete(
        f"/api/extensions/network.operations/topologies/{topo['topology_id']}/nodes/pe1/binding?workspace_id={workspace}",
    )
    assert removed.status_code == 200
    assert removed.get_json()["deleted"] is True
    assert node_bindings.list_overlay(workspace, topo["topology_id"]) == []
