from __future__ import annotations

import math
import pytest
from flask import Flask

from extensions.network_operations import backend
from extensions.network_operations import topology_service as drawings
from extensions.sdk import ExtensionDataStore
from storage.atomic_io import atomic_write_json


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-batch2-master-key")
    ws_id = "test_batch2_topo_ws"
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    for col in ("topologies", "skills", "devices", "connections"):
        for item in store.list(col, limit=500):
            key = item.get("topology_id") or item.get("device_id")
            if key:
                store.delete(col, str(key))
    yield ws_id


@pytest.fixture
def app():
    application = Flask(__name__)
    backend.register_routes(application)
    return application


def test_topology_signature_includes_all_network_fields(workspace):
    # P0-5: changing vendor, model, role, vlan, or location must change signature and trigger revision
    topo = drawings.save_topology(workspace, {
        "name": "AttrTest",
        "nodes": [{"node_id": "sw1", "display_name": "Switch 1", "vendor": "Cisco", "model": "Catalyst 9300", "role": "core", "vlan": "10,20", "location": "DC-Rack-A"}],
    })
    sig1 = drawings._topology_structure_signature(topo)

    # Change vendor
    topo2 = {**topo, "version": topo["version"], "nodes": [{**topo["nodes"][0], "vendor": "Huawei"}]}
    sig2 = drawings._topology_structure_signature(topo2)
    assert sig1 != sig2

    # Change model
    topo3 = {**topo, "version": topo["version"], "nodes": [{**topo["nodes"][0], "model": "CloudEngine 6800"}]}
    sig3 = drawings._topology_structure_signature(topo3)
    assert sig1 != sig3

    # Change role
    topo4 = {**topo, "version": topo["version"], "nodes": [{**topo["nodes"][0], "role": "access"}]}
    sig4 = drawings._topology_structure_signature(topo4)
    assert sig1 != sig4

    # Change vlan
    topo5 = {**topo, "version": topo["version"], "nodes": [{**topo["nodes"][0], "vlan": "100"}]}
    sig5 = drawings._topology_structure_signature(topo5)
    assert sig1 != sig5

    # Change location
    topo6 = {**topo, "version": topo["version"], "nodes": [{**topo["nodes"][0], "location": "Branch-B"}]}
    sig6 = drawings._topology_structure_signature(topo6)
    assert sig1 != sig6


def test_put_without_version_fails_with_409(workspace, app):
    # P0-6: PUT without version or with mismatched version must return 409
    client = app.test_client()
    created = drawings.save_topology(workspace, {
        "name": "ConcurTest",
        "nodes": [{"node_id": "r1", "display_name": "R1", "x": 0, "y": 0}],
    })
    topo_id = created["topology_id"]

    # PUT without version
    res = client.put(
        f"/api/extensions/network.operations/topologies/{topo_id}?workspace_id={workspace}",
        json={"name": "ConcurTestUpdated", "nodes": created["nodes"]},
    )
    assert res.status_code == 409
    assert res.get_json()["error"] == "topology_version_conflict"

    # PUT with stale version
    res_stale = client.put(
        f"/api/extensions/network.operations/topologies/{topo_id}?workspace_id={workspace}",
        json={"name": "ConcurTestUpdated", "version": 999, "nodes": created["nodes"]},
    )
    assert res_stale.status_code == 409
    assert res_stale.get_json()["error"] == "topology_version_conflict"

    # PUT with correct version succeeds
    res_ok = client.put(
        f"/api/extensions/network.operations/topologies/{topo_id}?workspace_id={workspace}",
        json={"name": "ConcurTestUpdated", "version": created["version"], "nodes": created["nodes"]},
    )
    assert res_ok.status_code == 200
    assert res_ok.get_json()["ok"] is True


def test_coordinates_nan_and_infinity_sanitized(workspace, tmp_path):
    # P0-7: NaN and Inf coords sanitized, and atomic_write_json forbids NaN
    saved = drawings.save_topology(workspace, {
        "name": "NanTest",
        "nodes": [{"node_id": "n_nan", "display_name": "NanNode", "x": float("nan"), "y": float("inf")}],
        "groups": [{"group_id": "g_nan", "name": "NanGroup", "x": float("nan"), "y": float("-inf"), "width": float("nan"), "height": float("inf")}],
        "canvas_items": [{"item_id": "i_nan", "text": "NanItem", "x": float("nan"), "y": float("inf"), "width": float("nan"), "height": float("nan")}],
    })
    node = saved["nodes"][0]
    assert math.isfinite(node["x"]) and node["x"] == 0.0
    assert math.isfinite(node["y"]) and node["y"] == 0.0

    grp = saved["groups"][0]
    assert math.isfinite(grp["x"]) and grp["x"] == 0.0
    assert math.isfinite(grp["y"]) and grp["y"] == 0.0
    assert math.isfinite(grp["width"]) and grp["width"] == 320.0
    assert math.isfinite(grp["height"]) and grp["height"] == 240.0

    item = saved["canvas_items"][0]
    assert math.isfinite(item["x"]) and item["x"] == 0.0
    assert math.isfinite(item["y"]) and item["y"] == 0.0
    assert math.isfinite(item["width"]) and item["width"] == 180.0
    assert math.isfinite(item["height"]) and item["height"] == 96.0

    # atomic_write_json with NaN raises ValueError
    nan_file = tmp_path / "bad.json"
    with pytest.raises(ValueError):
        atomic_write_json(nan_file, {"coord": float("nan")})


def test_svg_attribute_sanitization(workspace):
    # P1-5: Style fill/border/color containing injection scripts must be stripped
    saved = drawings.save_topology(workspace, {
        "name": "XssTest",
        "canvas_items": [{
            "item_id": "ci_1",
            "kind": "rectangle",
            "style": {
                "fill": '"><script>alert(1)</script><path fill="',
                "border": '#ff0000',
                "color": 'rgba(255, 0, 0, 0.5)',
            },
        }],
    })
    item = saved["canvas_items"][0]
    assert "fill" not in item["style"]
    assert item["style"]["border"] == "#ff0000"
    assert item["style"]["color"] == "rgba(255, 0, 0, 0.5)"
