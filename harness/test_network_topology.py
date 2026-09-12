"""Harness tests for network.operations topology models, APIs and canonical tool."""

from __future__ import annotations

import pytest
from flask import Flask

from extensions.network_operations import backend, service
from extensions.network_operations.skill_prompt import render_network_skill_prompt
from extensions.sdk import ExtensionDataStore
from core.tools.client import ToolRuntimeClient
from core.tools.context import ToolRuntimeContext
from core.tools.registry import ToolRegistry
from core.tools.schemas import ToolInvocation, ToolSpec


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    ws_id = "test_topo_ws"
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    # clean up previous data
    for col in ("topologies", "skills", "devices", "connections", "regions", "observations", "references"):
        for item in store.list(col, limit=500):
            key = (
                item.get("topology_id") or item.get("skill_id") or item.get("device_id")
                or item.get("connection_id") or item.get("region_id") or item.get("observation_id")
                or item.get("reference_id")
            )
            if key:
                store.delete(col, str(key))
    yield ws_id
    # cleanup after
    for col in ("topologies", "skills", "devices", "connections", "regions", "observations", "references"):
        for item in store.list(col, limit=500):
            key = (
                item.get("topology_id") or item.get("skill_id") or item.get("device_id")
                or item.get("connection_id") or item.get("region_id") or item.get("observation_id")
                or item.get("reference_id")
            )
            if key:
                store.delete(col, str(key))


@pytest.fixture
def app():
    application = Flask(__name__)
    backend.register_routes(application)
    return application


def test_topology_lifecycle_and_validation(workspace):
    dev1 = service.save_device(workspace, {"name": "PE1", "host": "192.168.1.1", "vendor": "h3c", "device_type": "router"})
    dev2 = service.save_device(workspace, {"name": "CE1", "host": "192.168.1.2", "vendor": "cisco", "device_type": "switch"})

    topo = service.save_topology(workspace, {
        "name": "C1",
        "description": "Customer 1 topology",
        "nodes": [
            {"device_id": dev1["device_id"], "x": 100.0, "y": 150.0, "display_name": "Core-PE1"},
            {"device_id": dev2["device_id"], "x": 300.0, "y": 150.0, "display_name": "Edge-CE1"},
        ],
        "links": [
            {
                "source_device_id": dev1["device_id"],
                "source_interface": "GE0/1",
                "target_device_id": dev2["device_id"],
                "target_interface": "GE0/0",
                "kind": "physical",
                "source": "manual",
                "status": "unknown",
            }
        ],
        "groups": [
            {"name": "AS65001", "kind": "as", "x": 50, "y": 50, "width": 400, "height": 300}
        ],
    })

    assert topo["name"] == "C1"
    assert topo["version"] == 1
    assert len(topo["nodes"]) == 2
    assert len(topo["links"]) == 1
    assert topo["links"][0]["source_interface"] == "GE0/1"
    assert topo["links"][0]["target_interface"] == "GE0/0"
    assert topo["links"][0]["label"] == "GE0/1 ↔ GE0/0"
    assert len(topo["groups"]) == 1

    # Duplicate device rejection
    with pytest.raises(ValueError, match="duplicate device entity"):
        service.save_topology(workspace, {
            "name": "Duplicate Test",
            "nodes": [
                {"device_id": dev1["device_id"]},
                {"device_id": dev1["device_id"]},
            ],
        })

    # Unknown device rejection
    with pytest.raises(ValueError, match="unknown device"):
        service.save_topology(workspace, {
            "name": "Unknown Device Test",
            "nodes": [
                {"device_id": "non-existent-device-id"},
            ],
        })

    # Link with unknown node rejection
    with pytest.raises(ValueError, match="must reference existing nodes"):
        service.save_topology(workspace, {
            "name": "Bad Link Test",
            "nodes": [
                {"device_id": dev1["device_id"]},
            ],
            "links": [
                {
                    "source_device_id": dev1["device_id"],
                    "target_device_id": dev2["device_id"],
                    "source_interface": "GE0/1",
                    "target_interface": "GE0/0",
                }
            ],
        })


def test_topology_optimistic_locking(workspace):
    dev1 = service.save_device(workspace, {"name": "R1", "host": "10.0.0.1", "vendor": "h3c"})
    topo = service.save_topology(workspace, {
        "name": "Topo Locked",
        "nodes": [{"device_id": dev1["device_id"], "x": 0, "y": 0}],
    })
    assert topo["version"] == 1

    # Conflict with stale version
    with pytest.raises(ValueError, match="topology_version_conflict"):
        service.save_topology(workspace, {
            "topology_id": topo["topology_id"],
            "name": "Topo Locked Updated",
            "version": 999,
        })

    # Successful update with correct version
    updated = service.save_topology(workspace, {
        "topology_id": topo["topology_id"],
        "name": "Topo Locked Updated",
        "version": 1,
        "nodes": [{"device_id": dev1["device_id"], "x": 10, "y": 20}],
    })
    assert updated["version"] == 2
    assert updated["name"] == "Topo Locked Updated"


def test_node_deletion_does_not_delete_device_or_connections(workspace):
    dev1 = service.save_device(workspace, {"name": "SwitchA", "host": "10.1.1.1", "vendor": "h3c"})
    conn1 = service.save_connection(workspace, {"device_id": dev1["device_id"], "protocol": "ssh", "port": 22, "username": "admin", "password": "pw"}, auto_test=False)
    dev2 = service.save_device(workspace, {"name": "SwitchB", "host": "10.1.1.2", "vendor": "huawei"})
    conn2 = service.save_connection(workspace, {"device_id": dev2["device_id"], "protocol": "ssh", "port": 22, "username": "admin", "password": "pw"}, auto_test=False)

    topo = service.save_topology(workspace, {
        "name": "TwoSwitches",
        "nodes": [
            {"device_id": dev1["device_id"]},
            {"device_id": dev2["device_id"]},
        ],
        "links": [
            {
                "source_device_id": dev1["device_id"],
                "source_interface": "Eth0/1",
                "target_device_id": dev2["device_id"],
                "target_interface": "Eth0/1",
            }
        ],
    })
    assert len(topo["nodes"]) == 2
    assert len(topo["links"]) == 1

    # Delete node from topology
    updated_topo = service.remove_topology_node(workspace, topo["topology_id"], dev1["device_id"])
    assert len(updated_topo["nodes"]) == 1
    assert updated_topo["nodes"][0]["device_id"] == dev2["device_id"]
    # The connected link was removed from topology
    assert len(updated_topo["links"]) == 0

    # Underlying device and connection still exist!
    assert service.get_device(workspace, dev1["device_id"]) is not None
    assert service.get_connection(workspace, conn1["connection_id"]) is not None


def test_topology_deletion_cleans_skill_references(workspace):
    dev = service.save_device(workspace, {"name": "SW1", "host": "10.2.2.1", "vendor": "cisco"})
    conn = service.save_connection(workspace, {"device_id": dev["device_id"], "protocol": "ssh", "port": 22, "username": "u", "password": "p"}, auto_test=False)
    topo = service.save_topology(workspace, {
        "name": "TopoForSkill",
        "nodes": [{"device_id": dev["device_id"]}],
    })

    skill = service.save_skill(workspace, {
        "name": "SkillWithTopo",
        "device_ids": [dev["device_id"]],
        "connection_ids": [conn["connection_id"]],
        "topology_id": topo["topology_id"],
    })
    assert skill["topology_id"] == topo["topology_id"]

    # Delete topology
    assert service.delete_topology(workspace, topo["topology_id"]) is True

    # Skill has reference cleared, no dangling reference
    reloaded_skill = service.get_skill(workspace, skill["skill_id"])
    assert reloaded_skill is not None
    assert reloaded_skill.get("topology_id") == ""


def test_topology_compare_with_unknown_evidence(workspace):
    dev1 = service.save_device(workspace, {"name": "Router1", "host": "10.3.3.1", "vendor": "h3c"})
    dev2 = service.save_device(workspace, {"name": "Router2", "host": "10.3.3.2", "vendor": "h3c"})
    dev3 = service.save_device(workspace, {"name": "UnconnectedDev", "host": "10.3.3.3", "vendor": "h3c"})

    topo = service.save_topology(workspace, {
        "name": "CompareTest",
        "nodes": [
            {"device_id": dev1["device_id"]},
            {"device_id": dev2["device_id"]},
        ],
        "links": [
            {
                "source_device_id": dev1["device_id"],
                "source_interface": "GE0/1",
                "target_device_id": dev2["device_id"],
                "target_interface": "GE0/2",
                "status": "unknown",
            }
        ],
    })

    result = service.compare_topology(workspace, topo["topology_id"])
    assert result["ok"] is True
    # dev3 is in workspace but not in topology
    assert dev3["device_id"] in result["devices_in_scope_not_in_topology"]
    # With no evidence, status must be unknown and cannot be falsely flagged as error
    assert result["summary"]["unknown_evidence_links"] == 1
    assert result["summary"]["mismatched_links"] == 0
    assert result["link_comparisons"][0]["comparison_status"] == "unknown"


def test_topology_rest_api(app, workspace):
    client = app.test_client()
    dev = service.save_device(workspace, {"name": "RestDev", "host": "10.4.4.1", "vendor": "h3c"})

    # POST create
    res = client.post("/api/extensions/network.operations/topologies", json={
        "workspace_id": workspace,
        "name": "RestTopo",
        "nodes": [{"device_id": dev["device_id"]}],
    })
    assert res.status_code == 201
    data = res.get_json()
    assert data["ok"] is True
    topo_id = data["topology"]["topology_id"]
    version = data["topology"]["version"]

    # GET list
    res = client.get(f"/api/extensions/network.operations/topologies?workspace_id={workspace}")
    assert res.status_code == 200
    assert len(res.get_json()["topologies"]) >= 1

    # GET single
    res = client.get(f"/api/extensions/network.operations/topologies/{topo_id}?workspace_id={workspace}")
    assert res.status_code == 200
    assert res.get_json()["topology"]["name"] == "RestTopo"

    # PUT conflict 409
    res = client.put(f"/api/extensions/network.operations/topologies/{topo_id}", json={
        "workspace_id": workspace,
        "name": "RestTopo Updated",
        "version": version + 10,
    })
    assert res.status_code == 409

    # PUT success
    res = client.put(f"/api/extensions/network.operations/topologies/{topo_id}", json={
        "workspace_id": workspace,
        "name": "RestTopo Updated",
        "version": version,
    })
    assert res.status_code == 200
    assert res.get_json()["topology"]["version"] == version + 1

    # Compare GET
    res = client.get(f"/api/extensions/network.operations/topologies/{topo_id}/compare?workspace_id={workspace}")
    assert res.status_code == 200
    assert res.get_json()["ok"] is True

    # DELETE node
    res = client.delete(f"/api/extensions/network.operations/topologies/{topo_id}/nodes/{dev['device_id']}", json={
        "workspace_id": workspace,
    })
    assert res.status_code == 200
    assert len(res.get_json()["topology"]["nodes"]) == 0

    # DELETE topology
    res = client.delete(f"/api/extensions/network.operations/topologies/{topo_id}", json={
        "workspace_id": workspace,
    })
    assert res.status_code == 200
    assert res.get_json()["ok"] is True


def test_topology_canonical_tool_via_runtime_client(workspace):
    dev1 = service.save_device(workspace, {"name": "ToolPE1", "host": "10.5.5.1", "vendor": "h3c"})
    conn1 = service.save_connection(workspace, {"device_id": dev1["device_id"], "protocol": "ssh", "port": 22, "username": "u", "password": "p"}, auto_test=False)
    dev2 = service.save_device(workspace, {"name": "ToolCE1", "host": "10.5.5.2", "vendor": "huawei"})
    conn2 = service.save_connection(workspace, {"device_id": dev2["device_id"], "protocol": "ssh", "port": 22, "username": "u", "password": "p"}, auto_test=False)

    # Register tool in ToolRegistry
    reg = backend.register()
    tool_entry = next(t for t in reg["tools"] if t["tool_id"] == "network.operations.topology")
    registry = ToolRegistry()
    spec = ToolSpec(
        tool_id=tool_entry["tool_id"],
        name=tool_entry["name"],
        description=tool_entry["description"],
        category=tool_entry["category"],
        risk_level=tool_entry["risk_level"],
        permission_action=tool_entry["permission_action"],
        input_schema=tool_entry["input_schema"],
    )
    registry.register_tool(spec, tool_entry["handler"])
    client = ToolRuntimeClient(registry)

    ctx = ToolRuntimeContext(workspace_id=workspace, requested_by="turn_runner")

    # 1. Create topology via tool
    result = client.invoke(
        "network.operations.topology",
        arguments={
            "workspace_id": workspace,
            "action": "create",
            "name": "ToolTopo",
            "nodes": [
                {"device_id": dev1["device_id"], "x": 100, "y": 100},
                {"device_id": dev2["device_id"], "x": 200, "y": 100},
            ],
            "links": [
                {
                    "source_device_id": dev1["device_id"],
                    "source_interface": "GE0/1",
                    "target_device_id": dev2["device_id"],
                    "target_interface": "GE0/0",
                    "kind": "physical",
                    "status": "up",
                }
            ],
        },
        context=ctx,
    )
    assert result.status == "succeeded"
    topo_id = result.output["topology"]["topology_id"]

    # 2. Read topology via tool
    result = client.invoke(
        "network.operations.topology",
        arguments={
            "workspace_id": workspace,
            "action": "read",
            "topology_id": topo_id,
        },
        context=ctx,
    )
    assert result.status == "succeeded"
    assert len(result.output["nodes"]) == 2
    assert len(result.output["links"]) == 1

    # 3. Compare via tool
    result = client.invoke(
        "network.operations.topology",
        arguments={
            "workspace_id": workspace,
            "action": "compare",
            "topology_id": topo_id,
        },
        context=ctx,
    )
    assert result.status == "succeeded"
    assert result.output["ok"] is True

    # 4. Scope restriction: Create a skill only containing dev1
    skill = service.save_skill(workspace, {
        "name": "ScopedSkill",
        "device_ids": [dev1["device_id"]],
        "connection_ids": [conn1["connection_id"]],
        "allowed_tool_ids": ["network.operations.device.manage", "network.operations.topology"],
        "topology_id": topo_id,
    })

    # Read under Skill scope: dev2 is out of scope, so only dev1 node is returned!
    # And link between dev1 and dev2 is excluded from scoped read.
    skill_ctx = ToolRuntimeContext(workspace_id=workspace, skill=skill["skill_id"], requested_by="turn_runner")
    scope_result = client.invoke(
        "network.operations.topology",
        arguments={"action": "read", "topology_id": topo_id},
        context=skill_ctx,
    )
    assert scope_result.status == "succeeded"
    assert scope_result.output["ok"] is True
    assert len(scope_result.output["nodes"]) == 1
    assert scope_result.output["nodes"][0]["device_id"] == dev1["device_id"]
    assert len(scope_result.output["links"]) == 0

    # Write out-of-scope under Skill scope: attempting to add dev2 node must fail
    write_result = client.invoke(
        "network.operations.topology",
        arguments={
            "action": "update",
            "topology_id": topo_id,
            "nodes": [{"device_id": dev2["device_id"]}],
        },
        context=skill_ctx,
    )
    assert write_result.output["ok"] is False
    assert write_result.output["error"] == "device_not_allowed_by_skill"

    # 5. Skill context compact summary
    selection = service.resolve_workbench_selection(workspace, {"skill_id": skill["skill_id"]})
    assert selection["topology"] is not None
    assert selection["topology"]["topology_id"] == topo_id
    assert selection["topology"]["node_count"] == 2
    assert selection["topology"]["link_count"] == 1

    prompt = render_network_skill_prompt(selection)
    assert topo_id in prompt
    assert "network.operations.topology" in prompt
