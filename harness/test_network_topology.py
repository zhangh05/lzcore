"""Drawing-only topology: independent of devices, exclusive drawing Skill."""

from __future__ import annotations

import pytest
from flask import Flask

from extensions.network_operations import backend, service
from extensions.network_operations import topology_service as drawings
from extensions.network_operations.skill_prompt import render_network_skill_prompt
from extensions.runtime import apply_workbench_tool_boundary
from extensions.sdk import ExtensionDataStore


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    ws_id = "test_topo_ws"
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    for col in ("topologies", "skills", "devices", "connections", "topology_asset_backups"):
        for item in store.list(col, limit=500):
            key = item.get("topology_id") or item.get("skill_id") or item.get("device_id") or item.get("connection_id")
            if key:
                store.delete(col, str(key))
    yield ws_id


@pytest.fixture
def app():
    application = Flask(__name__)
    backend.register_routes(application)
    return application


def _drawing(workspace, **overrides):
    payload = {
        "name": "C1",
        "nodes": [
            {"node_id": "pe1", "display_name": "PE1", "device_type": "router", "x": 100, "y": 150},
            {"node_id": "ce1", "display_name": "CE1", "device_type": "switch", "x": 300, "y": 150},
        ],
        "links": [{
            "source_node_id": "pe1", "source_interface": "GE0/1",
            "target_node_id": "ce1", "target_interface": "GE0/0",
            "kind": "physical", "source": "manual", "status": "unknown",
        }],
        "groups": [{"name": "AS65001", "kind": "as", "x": 50, "y": 50, "width": 400, "height": 300}],
        "canvas_items": [{"item_id": "note-core", "kind": "text", "text": "核心区域", "x": 80, "y": 30, "width": 160, "height": 36}],
    }
    payload.update(overrides)
    return drawings.save_topology(workspace, payload)


def test_zone_is_fitted_around_nodes_that_name_it(workspace):
    topo = drawings.save_topology(workspace, {
        "name": "分区",
        "nodes": [
            {"node_id": "a", "display_name": "A", "x": 100, "y": 100, "group_id": "zone1"},
            {"node_id": "b", "display_name": "B", "x": 400, "y": 280, "group_id": "zone1"},
        ],
        "canvas_items": [{
            "item_id": "zone1", "kind": "rectangle", "text": "核心",
            "x": 0, "y": 0, "width": 40, "height": 40,
        }],
    })
    zone = topo["canvas_items"][0]
    assert zone["x"] == 250
    assert zone["y"] == 190
    assert zone["width"] >= 300
    assert zone["height"] >= 180


def test_link_arc_direction_survives_save(workspace):
    topo = _drawing(workspace)
    topo["links"][0]["style"] = {"curve_style": "bezier", "curve_reverse": True, "color": "#336699"}
    saved = drawings.save_topology(workspace, topo)
    assert saved["links"][0]["style"]["curve_reverse"] is True
    assert saved["links"][0]["style"]["curve_style"] == "bezier"
    again = drawings.get_topology(workspace, saved["topology_id"])
    assert again["links"][0]["style"]["curve_reverse"] is True


def test_topology_lifecycle_without_assets(workspace):
    topo = _drawing(workspace)
    assert topo["version"] == 1
    assert [node["node_id"] for node in topo["nodes"]] == ["pe1", "ce1"]
    assert "linked_device_id" not in topo["nodes"][0]
    assert topo["links"][0]["source_interface"] == "GE0/1"
    listed = drawings.list_topologies(workspace)
    assert listed[0]["topology_id"] == topo["topology_id"]
    drawings.delete_topology(workspace, topo["topology_id"])
    assert drawings.get_topology(workspace, topo["topology_id"]) is None


def test_save_rejects_asset_association(workspace):
    with pytest.raises(ValueError, match="topology_asset_association_removed"):
        drawings.save_topology(workspace, {
            "name": "blocked",
            "nodes": [{"node_id": "n1", "linked_device_id": "dev_1", "x": 0, "y": 0}],
        })


def test_legacy_discovered_links_become_manual_on_read(workspace):
    store = ExtensionDataStore("network.operations", workspace_id=workspace)
    store.save("topologies", "topo_legacy", {
        "topology_id": "topo_legacy", "name": "旧图", "version": 1, "schema_version": 1,
        "nodes": [{"node_id": "pe1", "display_name": "PE1", "x": 0, "y": 0, "device_type": "router"}],
        "links": [{"link_id": "l1", "source_node_id": "pe1", "target_node_id": "pe1",
                   "source": "discovered", "status": "up", "kind": "physical"}],
        "groups": [], "canvas_items": [],
    })
    topo = drawings.get_topology(workspace, "topo_legacy")
    assert topo["links"][0]["source"] == "manual"
    assert topo["links"][0]["status"] == "unknown"
    assert topo["links"][0]["metadata"]["legacy_discovery"] is True


def test_optimistic_locking(workspace):
    topo = _drawing(workspace)
    drawings.save_topology(workspace, {**topo, "version": topo["version"], "name": "first"})
    with pytest.raises(ValueError, match="topology_version_conflict"):
        drawings.save_topology(workspace, {**topo, "version": topo["version"], "name": "stale"})


def test_rest_api_creates_drawing(workspace, app):
    client = app.test_client()
    res = client.post(
        f"/api/extensions/network.operations/topologies?workspace_id={workspace}",
        json={"name": "REST图", "nodes": [{"node_id": "n1", "display_name": "N1", "x": 0, "y": 0}]},
    )
    assert res.status_code == 201
    body = res.get_json()
    assert body["ok"] is True
    assert body["topology"]["name"] == "REST图"


def test_topology_tool_requires_drawing_skill(workspace):
    from types import SimpleNamespace
    topo = _drawing(workspace)
    blocked = backend.topology_tool(SimpleNamespace(
        arguments={"action": "read", "topology_id": topo["topology_id"]},
        workspace_id=workspace, skill="",
    ))
    assert blocked["error"] == "drawing_skill_required"
    allowed = backend.topology_tool(SimpleNamespace(
        arguments={"action": "read", "topology_id": topo["topology_id"]},
        workspace_id=workspace, skill=f"drawing:{topo['topology_id']}",
    ))
    assert allowed["ok"] is True
    assert allowed["topology"]["topology_id"] == topo["topology_id"]

    ro_read = backend.topology_tool(SimpleNamespace(
        arguments={"action": "read", "topology_id": topo["topology_id"]},
        workspace_id=workspace, skill=f"drawing:{topo['topology_id']}:ro",
    ))
    assert ro_read["ok"] is True
    assert ro_read["topology"]["topology_id"] == topo["topology_id"]

    ro_patch = backend.topology_tool(SimpleNamespace(
        arguments={"action": "patch", "topology_id": topo["topology_id"], "version": topo["version"], "name": "forbidden"},
        workspace_id=workspace, skill=f"drawing:{topo['topology_id']}:ro",
    ))
    assert ro_patch["ok"] is False
    assert ro_patch["error"] == "topology_edit_not_permitted"


def test_drawing_skill_is_exclusive_and_has_own_prompt(workspace):
    topo = _drawing(workspace)
    context = service.resolve_workbench_selection(workspace, {
        "skill_id": f"drawing:{topo['topology_id']}",
        "resource_ids": [topo["topology_id"]],
    })
    assert context["tool_scope"] == "exclusive"
    assert context["allowed_tool_ids"] == ["network.operations.topology"]
    assert context["allow_edit"] is True
    prompt = render_network_skill_prompt(context)
    assert "Only edit the selected drawing" in prompt

    ro_context = service.resolve_workbench_selection(workspace, {
        "skill_id": f"drawing:{topo['topology_id']}",
        "resource_ids": [topo["topology_id"]],
        "allow_edit": False,
    })
    assert ro_context["skill_id"] == f"drawing:{topo['topology_id']}:ro"
    assert ro_context["allow_edit"] is False
    ro_prompt = render_network_skill_prompt(ro_context)
    assert "READ-ONLY mode" in ro_prompt
    assert "Do not attempt to modify, patch" in ro_prompt

    bounded = apply_workbench_tool_boundary(
        {
            "network.operations.topology": {"tool_id": "network.operations.topology"},
            "network.operations.device.manage": {"tool_id": "network.operations.device.manage"},
            "exec.run": {"tool_id": "exec.run"},
        },
        context,
    )
    assert set(bounded) == {"network.operations.topology"}
    catalog = service.workbench_skill_catalog(workspace)
    assert all(not str(item.get("skill_id") or "").startswith("drawing:") for item in catalog)
    from extensions.network_operations.topology_skill import skill_catalog
    assert any(item["skill_id"] == f"drawing:{topo['topology_id']}" for item in skill_catalog(workspace))


def test_network_skill_cannot_carry_topology_tool(workspace):
    assert "network.operations.topology" not in service.SKILL_TOOL_IDS
    device = service.save_device(workspace, {"name": "R1", "host": "10.0.0.1"})
    connection = service.save_connection(
        workspace,
        {"device_id": device["device_id"], "protocol": "telnet", "auth_method": "none"},
        auto_test=False,
    )
    with pytest.raises(ValueError, match="unsupported tool"):
        service.save_skill(workspace, {
            "name": "blocked",
            "device_ids": [device["device_id"]],
            "connection_ids": [connection["connection_id"]],
            "allowed_tool_ids": ["network.operations.topology"],
        })
    skill = service.save_skill(workspace, {
        "name": "ops",
        "device_ids": [device["device_id"]],
        "connection_ids": [connection["connection_id"]],
    })
    context = service.resolve_workbench_selection(workspace, {"skill_id": skill["skill_id"]})
    assert context["extension_id"] == "network.operations"
    assert "network.operations.topology" not in context["allowed_tool_ids"]
    prompt = render_network_skill_prompt(context)
    assert "Do not use exec.run, curl, Python HTTP clients" in prompt


def test_drawing_selection_in_agent_app_binds_drawing_skill_to_topology_tool(workspace, monkeypatch, tmp_path):
    from agent.app.service import get_default_agent_app
    import agent.runtime.ssot_runtime as runtime
    from types import SimpleNamespace

    topo = _drawing(workspace)
    selection = {
        "extension_id": "network.operations",
        "skill_id": f"drawing:{topo['topology_id']}",
        "resource_ids": [topo["topology_id"]],
    }

    real_build_engine = runtime._build_engine
    captured_engine = {}

    def fake_build_engine(**kwargs):
        engine = real_build_engine(**kwargs)
        captured_engine["engine"] = engine

        async def fake_run(**run_kwargs):
            # Simulate the model executing the topology tool
            handler = engine.tool_runtime._handlers["network.operations.topology"]
            res = await handler({
                "action": "read",
                "topology_id": topo["topology_id"],
            })
            from core.runtime_engine.models import ToolResult
            tool_res = ToolResult(
                node_id="1",
                tool="network.operations.topology",
                success=res.get("ok", False),
                data=res,
            )
            return SimpleNamespace(
                success=True,
                final_response=f"读取成功 version={res.get('version')}",
                node_results={"1": tool_res},
                errors=[],
                metadata={"execution_outcome": "complete", "cognitive": {"outcome": "stop_completed"}},
            )

        engine.run = fake_run
        return engine

    monkeypatch.setattr(runtime, "_build_engine", fake_build_engine)
    monkeypatch.setattr(runtime, "persist_run_record", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime, "_record_experience_and_maybe_reflect", lambda **_kwargs: None)

    app = get_default_agent_app()
    result = app.submit_user_message(
        user_input="请读取当前图纸。",
        workspace_id=workspace,
        metadata={"workbench_selection": selection},
    )

    assert result.ok is True
    assert "读取成功" in result.final_response
    assert "network.operations.topology" in captured_engine["engine"].tool_runtime._handlers
    # Verify exclusive boundary was applied (e.g. exec.run should NOT be in registered handlers)
    assert "exec.run" not in captured_engine["engine"].tool_runtime._handlers


def test_multiturn_drawing_permission_toggle_between_ro_and_rw(workspace, monkeypatch):
    """Verify that multiple consecutive turns on the same session cleanly transition permissions."""
    from agent.app.service import get_default_agent_app
    import agent.runtime.ssot_runtime as runtime
    from types import SimpleNamespace
    from core.runtime_engine.models import ToolResult

    topo = _drawing(workspace)
    session_id = "s-multiturn-topo-test"
    captured_actions = []

    real_build_engine = runtime._build_engine

    def fake_build_engine(**kwargs):
        engine = real_build_engine(**kwargs)

        async def fake_run(**run_kwargs):
            handler = engine.tool_runtime._handlers["network.operations.topology"]
            current_action = captured_actions[-1] if captured_actions else {}

            if current_action.get("should_patch"):
                res = await handler({
                    "action": "patch",
                    "topology_id": topo["topology_id"],
                    "version": current_action.get("version", 1),
                    "node_updates": [{"node_id": "pc1", "display_name": "PC1", "x": 500, "y": 500}],
                })
            else:
                res = await handler({
                    "action": "read",
                    "topology_id": topo["topology_id"],
                })

            tool_res = ToolResult(
                node_id="1",
                tool="network.operations.topology",
                success=res.get("ok", False),
                data=res,
            )
            return SimpleNamespace(
                success=res.get("ok", False),
                final_response=f"执行结果 ok={res.get('ok')} err={res.get('error')}",
                node_results={"1": tool_res},
                errors=[] if res.get("ok") else [res.get("error", "error")],
                metadata={"execution_outcome": "complete", "cognitive": {"outcome": "stop_completed"}},
            )

        engine.run = fake_run
        return engine

    monkeypatch.setattr(runtime, "_build_engine", fake_build_engine)
    monkeypatch.setattr(runtime, "persist_run_record", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime, "_record_experience_and_maybe_reflect", lambda **_kwargs: None)

    app = get_default_agent_app()

    # --- Turn 1: Read-only mode, agent attempts patch -> BLOCKED ---
    captured_actions.append({"should_patch": True, "version": 1})
    res_t1 = app.submit_user_message(
        user_input="请帮我修改图纸",
        session_id=session_id,
        workspace_id=workspace,
        metadata={
            "workbench_selection": {
                "extension_id": "network.operations",
                "skill_id": f"drawing:{topo['topology_id']}:ro",
                "resource_ids": [topo["topology_id"]],
                "allow_edit": False,
            }
        },
    )
    assert res_t1.ok is False
    assert "topology_edit_not_permitted" in res_t1.errors
    # Topology version on disk remains 1
    assert drawings.get_topology(workspace, topo["topology_id"])["version"] == 1

    # --- Turn 2: User switches to edit mode -> PATCH SUCCEEDS ---
    captured_actions.append({"should_patch": True, "version": 1})
    res_t2 = app.submit_user_message(
        user_input="我已勾选允许修改，请添加 PC1",
        session_id=session_id,
        workspace_id=workspace,
        metadata={
            "workbench_selection": {
                "extension_id": "network.operations",
                "skill_id": f"drawing:{topo['topology_id']}",
                "resource_ids": [topo["topology_id"]],
                "allow_edit": True,
            }
        },
    )
    assert res_t2.ok is True
    updated_topo = drawings.get_topology(workspace, topo["topology_id"])
    assert updated_topo["version"] == 2
    assert any(n["node_id"] == "pc1" for n in updated_topo["nodes"])

    # --- Turn 3: User switches back to read-only mode -> READ SUCCEEDS, PATCH BLOCKED ---
    captured_actions.append({"should_patch": False})
    res_t3 = app.submit_user_message(
        user_input="请分析当前图纸（已包含PC1）",
        session_id=session_id,
        workspace_id=workspace,
        metadata={
            "workbench_selection": {
                "extension_id": "network.operations",
                "skill_id": f"drawing:{topo['topology_id']}:ro",
                "resource_ids": [topo["topology_id"]],
                "allow_edit": False,
            }
        },
    )
    assert res_t3.ok is True
    assert drawings.get_topology(workspace, topo["topology_id"])["version"] == 2


def test_drawing_selection_normalization_and_defense(workspace):
    """Verify normalization of :ro in resource_ids and target_topology_id."""
    from types import SimpleNamespace

    topo = _drawing(workspace)

    # 1. resource_ids containing :ro is normalized
    context = service.resolve_workbench_selection(workspace, {
        "skill_id": f"drawing:{topo['topology_id']}:ro",
        "resource_ids": [f"{topo['topology_id']}:ro"],
    })
    assert context["skill_id"] == f"drawing:{topo['topology_id']}:ro"
    assert context["allow_edit"] is False

    # 2. target_topology_id in tool arguments containing :ro is accepted
    res = backend.topology_tool(SimpleNamespace(
        arguments={"action": "read", "topology_id": f"{topo['topology_id']}:ro"},
        workspace_id=workspace,
        skill=f"drawing:{topo['topology_id']}:ro",
    ))
    assert res["ok"] is True
    assert res["topology"]["topology_id"] == topo["topology_id"]


def test_nodes_lock_group_persistence(workspace):
    """Verify that lock_group is persisted and retrieved on nodes."""
    saved = drawings.save_topology(workspace, {
        "name": "锁定拓扑",
        "nodes": [
            {"node_id": "sw1", "display_name": "SW1", "x": 100, "y": 100, "lock_group": "group_alpha"},
            {"node_id": "sw2", "display_name": "SW2", "x": 200, "y": 100, "lock_group": "group_alpha"},
            {"node_id": "sw3", "display_name": "SW3", "x": 300, "y": 100},
        ],
    })
    topo = drawings.get_topology(workspace, saved["topology_id"])
    nodes_by_id = {n["node_id"]: n for n in topo["nodes"]}
    assert nodes_by_id["sw1"]["lock_group"] == "group_alpha"
    assert nodes_by_id["sw2"]["lock_group"] == "group_alpha"
    assert nodes_by_id["sw3"]["lock_group"] is None


def test_nodes_zone_persistence_and_auto_synthesis(workspace):
    """Verify that node zone is persisted and auto-synthesizes visual zone bounding box."""
    saved = drawings.save_topology(workspace, {
        "name": "智能区域拓扑",
        "nodes": [
            {"node_id": "core1", "display_name": "核心1", "x": 100, "y": 100, "zone": "核心骨干区"},
            {"node_id": "core2", "display_name": "核心2", "x": 300, "y": 100, "zone": "核心骨干区"},
            {"node_id": "edge1", "display_name": "边界", "x": 200, "y": 400},
        ],
    })
    topo = drawings.get_topology(workspace, saved["topology_id"])
    nodes_by_id = {n["node_id"]: n for n in topo["nodes"]}
    assert nodes_by_id["core1"]["zone"] == "核心骨干区"
    assert nodes_by_id["core2"]["zone"] == "核心骨干区"
    assert nodes_by_id["edge1"]["zone"] is None

    # Verify auto-synthesized canvas_item for "核心骨干区"
    items = topo.get("canvas_items") or []
    assert len(items) == 1
    zone_item = items[0]
    assert zone_item["text"] == "核心骨干区"
    assert zone_item["x"] == 200.0  # midpoint of 100 and 300
    assert zone_item["y"] == 100.0  # midpoint of 100 and 100
    assert zone_item["width"] >= 220.0
    assert zone_item["height"] >= 170.0


