"""Neighbour table parsing for topology discovery.

Discovery is best effort across vendors, so the important behaviour to pin
down is not just what it recognises but what it refuses to guess at: a wrong
link on a topology is worse than a missing one.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from artifacts.store import save_artifact  # noqa: E402
from extensions.network_operations import service  # noqa: E402
from extensions.sdk import ExtensionDataStore  # noqa: E402
from storage.time_utils import now_iso  # noqa: E402

from extensions.network_operations.service import parse_neighbor_output  # noqa: E402


def test_h3c_verbose_blocks():
    output = "\n".join([
        "Local Interface: GE1/0/1",
        "Chassis ID    : 0023-8956-7a01",
        "Port ID       : GE1/0/2",
        "System Name   : Access-02",
        "",
        "Local Interface: GE1/0/2",
        "Chassis ID    : 0023-8956-7a02",
        "Port ID       : GE1/0/3",
        "System Name   : Access-03",
    ])
    assert parse_neighbor_output(output) == [
        {"local_interface": "GE1/0/1", "remote_name": "Access-02", "remote_interface": "GE1/0/2"},
        {"local_interface": "GE1/0/2", "remote_name": "Access-03", "remote_interface": "GE1/0/3"},
    ]


def test_huawei_brief_table():
    output = "\n".join([
        "Local Interface    Chassis ID      Port ID      System Name",
        "GE1/0/1            0023-89ab-cd01  GE1/0/2     Access-02",
        "XGE1/0/1           0023-89ab-cd02  XGE1/0/1    Core-01",
    ])
    parsed = parse_neighbor_output(output)
    assert [(n["local_interface"], n["remote_name"]) for n in parsed] == [
        ("GE1/0/1", "Access-02"),
        ("XGE1/0/1", "Core-01"),
    ]


def test_cisco_cdp_brief_table_joins_spaced_interface():
    output = "\n".join([
        "Capability Codes: R - Router, T - Trans Bridge",
        "Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID",
        "Access-02.corp   Gig 1/0/1         140          S I       WS-C2960  Gig 1/0/2",
        "Core-01          Gig 1/0/2         130          R S I     C9300-24  Te 1/1/1",
    ])
    parsed = parse_neighbor_output(output)
    assert parsed == [
        {"local_interface": "Gig1/0/1", "remote_name": "Access-02.corp", "remote_interface": "Gig1/0/2"},
        {"local_interface": "Gig1/0/2", "remote_name": "Core-01", "remote_interface": "Te1/1/1"},
    ]


def test_cisco_lldp_brief_table():
    output = "\n".join([
        "Device ID           Local Intf     Hold-time  Capability      Port ID",
        "SW-Access-05        Gi1/0/24       120        B,R             Gi1/0/1",
    ])
    assert parse_neighbor_output(output) == [
        {"local_interface": "Gi1/0/24", "remote_name": "SW-Access-05", "remote_interface": "Gi1/0/1"},
    ]


def test_unrelated_output_yields_nothing():
    output = "display version\nHuawei Versatile Routing Platform Software\n"
    assert parse_neighbor_output(output) == []


def test_empty_output_yields_nothing():
    assert parse_neighbor_output("") == []
    assert parse_neighbor_output(None) == []


# --------------------------------------------------------------------------
# End-to-end discovery: evidence already collected → candidate links
# --------------------------------------------------------------------------

_COLLECTIONS = ("topologies", "devices", "observations", "references")
_KEY_FIELDS = ("topology_id", "device_id", "observation_id", "reference_id")


def _purge(ws_id: str) -> None:
    store = ExtensionDataStore("network.operations", workspace_id=ws_id)
    for col in _COLLECTIONS:
        for item in store.list(col, limit=500):
            for field in _KEY_FIELDS:
                key = item.get(field)
                if key:
                    store.delete(col, str(key))
                    break


@pytest.fixture
def workspace(monkeypatch):
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-extension-master-key")
    ws_id = "test_topo_discovery_ws"
    _purge(ws_id)
    yield ws_id
    _purge(ws_id)


def _seed_neighbor_evidence(workspace_id: str, device_id: str, output: str) -> str:
    """Store an inspection artifact that looks like a collected LLDP run."""
    record = save_artifact(
        workspace_id,
        content=json.dumps({"raw_outputs": {"display lldp neighbor": {"output": output}}}),
        artifact_type="network_inspection",
        title="lldp evidence",
        module="network.operations",
    )
    assert record is not None
    from core.runtime_engine.context_contract import normalize_observation_descriptor
    observation = normalize_observation_descriptor({
        "observation_id": f"obs_{device_id[-6:]}",
        "source_kind": "network_inspection",
        "source_id": "task-test",
        "artifact_id": record.artifact_id,
        "observed_at": now_iso(),
        "completeness": "complete",
        "scope_key": device_id,
        "target_ids": [device_id],
        "created_at": now_iso(),
    })
    service._store(workspace_id).save("observations", observation["observation_id"], observation)
    return record.artifact_id


def test_discovery_offers_neighbours_observed_but_never_drawn(workspace):
    pe1 = service.save_device(workspace, {"name": "PE1", "host": "10.9.1.1", "vendor": "h3c"})
    pe2 = service.save_device(workspace, {"name": "PE2", "host": "10.9.1.2", "vendor": "h3c"})
    outside = service.save_device(workspace, {"name": "OFFNET", "host": "10.9.9.9", "vendor": "h3c"})
    topo = service.save_topology(workspace, {
        "name": "Discovery canvas",
        "nodes": [
            {"node_id": "pe1", "linked_device_id": pe1["device_id"]},
            {"node_id": "pe2", "linked_device_id": pe2["device_id"]},
        ],
    })
    _seed_neighbor_evidence(workspace, pe1["device_id"], "\n".join([
        "Local Interface: GE1/0/1",
        "System Name   : PE2",
        "Port ID       : GE1/0/2",
        "",
        "Local Interface: GE1/0/9",
        "System Name   : OFFNET",
        "Port ID       : GE1/0/1",
    ]))

    result = service.discover_topology_neighbors(workspace, topo["topology_id"])
    assert result["scanned_devices"] == 1
    assert [(c["source_node_id"], c["target_node_id"]) for c in result["candidates"]] == [("pe1", "pe2")]
    candidate = result["candidates"][0]
    assert candidate["source_interface"] == "GE1/0/1"
    assert candidate["target_interface"] == "GE1/0/2"
    assert candidate["target_device_id"] == pe2["device_id"]
    # A neighbour that is not on the canvas cannot be drawn, so it is never offered.
    assert outside["device_id"] not in {c["target_device_id"] for c in result["candidates"]}


def test_discovery_skips_pairs_already_on_the_canvas(workspace):
    pe1 = service.save_device(workspace, {"name": "PE1", "host": "10.9.2.1", "vendor": "h3c"})
    pe2 = service.save_device(workspace, {"name": "PE2", "host": "10.9.2.2", "vendor": "h3c"})
    topo = service.save_topology(workspace, {
        "name": "Already drawn",
        "nodes": [
            {"node_id": "pe1", "linked_device_id": pe1["device_id"]},
            {"node_id": "pe2", "linked_device_id": pe2["device_id"]},
        ],
        "links": [{"source_node_id": "pe1", "target_node_id": "pe2"}],
    })
    _seed_neighbor_evidence(workspace, pe1["device_id"], "\n".join([
        "Local Interface: GE1/0/1",
        "System Name   : PE2",
        "Port ID       : GE1/0/2",
    ]))
    result = service.discover_topology_neighbors(workspace, topo["topology_id"])
    assert result["candidates"] == []
    assert result["note"] == "no_unrecorded_neighbours_in_collected_evidence"


def test_discovery_reports_when_nothing_can_be_scanned(workspace):
    topo = service.save_topology(workspace, {
        "name": "Symbols only",
        "nodes": [{"node_id": "internet", "display_name": "Internet"}],
    })
    result = service.discover_topology_neighbors(workspace, topo["topology_id"])
    assert result == {
        "topology_id": topo["topology_id"],
        "candidates": [],
        "scanned_devices": 0,
        "note": "topology_has_no_linked_devices",
    }
