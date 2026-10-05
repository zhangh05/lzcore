"""Independent NOC business acceptance over the published test API.

Checks inspect real observations and transitions, never application-authored
PASS flags. Random target choices are recorded and replayable via the seed.
"""

from __future__ import annotations

import math
import json
import random
import urllib.error
from collections import Counter


def verify_line_diff(lines, before: str, after: str):
    """Both sides must reconstruct exactly; finding one marker proves little."""
    assert isinstance(lines, list) and lines, "missing line diff"
    old, new = [], []
    for line in lines:
        assert isinstance(line, dict) and line.get("kind") in {"added", "removed", "unchanged"}, "invalid diff line"
        assert isinstance(line.get("text"), str), "diff line has no text"
        if line["kind"] != "added":
            old.append(line["text"])
        if line["kind"] != "removed":
            new.append(line["text"])
    assert old == before.splitlines(), "diff does not reconstruct original configuration"
    assert new == after.splitlines(), "diff does not reconstruct saved configuration"


def restore_configuration(api, path: str, before: dict, changed: str):
    """Read back uncertain writes; never repeat PUT/rollback or erase other work."""
    observed = api(path)
    if observed["content"] == before["content"]:
        return False
    assert observed["content"] == changed, "configuration differs from this test's write; refusing automatic rollback"
    try:
        api(path + "/rollback", {"versionId": before["versionId"]})
    except OSError as exc:
        if isinstance(exc, urllib.error.HTTPError):
            raise
        # A lost rollback response is an unknown write. Resolve through a read,
        # without sending the mutation a second time.
        if api(path)["content"] != before["content"]:
            raise
    assert api(path)["content"] == before["content"], "rollback did not restore original content"
    return True


def run_noc_acceptance(api, array, check, seed):
    rng = random.Random(seed)

    def sample():
        interfaces = array("/api/interfaces", "interfaces")
        assert interfaces, "no interfaces to validate"
        return rng.choice(interfaces)

    def value(row, key):
        assert key in row, f"missing real interface field: {key}"
        number = row[key]
        assert (
            isinstance(number, (int, float))
            and not isinstance(number, bool)
            and math.isfinite(number)
            and number >= 0
        ), f"invalid {key}: {number}"
        return number

    def counters():
        before = {row["id"]: row for row in array("/api/interfaces", "interfaces")}
        api("/api/test/step", {"seconds": 15})
        after = {row["id"]: row for row in array("/api/interfaces", "interfaces")}
        keys = ("rxBytes", "txBytes", "rxPackets", "txPackets", "crc", "noBuffers")
        ids = rng.sample(sorted(before), min(12, len(before)))
        for identifier in ids:
            for key in keys:
                assert value(after[identifier], key) >= value(
                    before[identifier], key
                ), f"counter regressed without reset: {identifier}/{key}"
            for key in ("rxBps", "txBps", "rxPps", "txPps"):
                value(after[identifier], key)
            row = after[identifier]
            for key in ("rxBps", "txBps"):
                assert value(row, key) <= value(row, "speed") * 1.05, "rate exceeds line speed"
            assert value(row, "utilization") <= 1, "utilization outside 0..1"
        return {"seed": seed, "interfaces": ids, "verified_fields": keys}

    check("independent_interface_counters_and_rates", counters)

    def fault_case(kind, changed_field):
        row = sample()
        before = value(row, changed_field)
        fault = api(
            "/api/faults",
            {"type": kind, "deviceId": row["deviceId"], "interfaceId": row["id"]},
        )
        assert fault.get("id"), "fault has no durable ID"
        try:
            api("/api/test/step", {"seconds": 30})
            changed = next(
                item
                for item in array("/api/interfaces", "interfaces")
                if item["id"] == row["id"]
            )
            assert value(changed, changed_field) > before, (
                f"{kind} failed to affect its own counter"
            )
            if kind == "HighPPS":
                assert value(changed, "utilization") < 0.5, (
                    "high PPS incorrectly modeled as high bandwidth"
                )
        finally:
            api("/api/faults/" + str(fault["id"]) + "/restore", {})
        api("/api/test/step", {"seconds": 20})
        return {
            "seed": seed,
            "fault": kind,
            "interface": row["id"],
            "counter_before": before,
        }

    for kind, field in (
        ("noBuffers", "noBuffers"),
        ("CRC", "crc"),
        ("HighPPS", "rxPps"),
    ):
        check(
            "independent_fault_" + kind,
            lambda kind=kind, field=field: fault_case(kind, field),
        )

    def dedup_and_restore():
        row = sample()
        faults = []
        try:
            for _ in range(3):
                faults.append(
                    api(
                        "/api/faults",
                        {
                            "type": "InterfaceDown",
                            "deviceId": row["deviceId"],
                            "interfaceId": row["id"],
                        },
                    )["id"]
                )
            api("/api/test/step", {"seconds": 30})
            alerts = [
                item
                for item in array("/api/alerts", "alerts")
                if item.get("interfaceId") == row["id"]
                and item.get("state") in ("Firing", "Acknowledged")
            ]
            assert alerts, "interface down produced no active alert"
            assert len({item["fingerprint"] for item in alerts}) == len(alerts), (
                "duplicate active alert fingerprints"
            )
            target = next(item for item in alerts if item["rule"] == "InterfaceDown")
            api("/api/alerts/" + str(target["id"]) + "/ack", {})
            acknowledged = next(
                item
                for item in array("/api/alerts", "alerts")
                if item["id"] == target["id"]
            )
            assert acknowledged["state"] == "Acknowledged"
        finally:
            for fid in set(faults):
                api("/api/faults/" + str(fid) + "/restore", {})
        api("/api/test/step", {"seconds": 30})
        recovered = next(
            item
            for item in array("/api/alerts", "alerts")
            if item["id"] == target["id"]
        )
        assert recovered["state"] == "Resolved", (
            "restoring fault did not resolve acknowledged alert"
        )
        return {
            "interface": row["id"],
            "alert": target["id"],
            "final_state": recovered["state"],
        }

    check("independent_alert_dedup_ack_and_recovery", dedup_and_restore)

    def dependency_rca():
        topology = api("/api/topology")
        devices = array("/api/devices", "devices")
        roots = [
            row
            for row in devices
            if str(row.get("role", "")).lower() in ("core", "wan", "核心", "wan-router")
        ]
        assert roots, "no dependency roots"
        root = rng.choice(roots)
        incident = api("/api/faults", {"type": "DeviceDown", "deviceId": root["id"]})
        try:
            api("/api/test/step", {"seconds": 40})
            alerts = array("/api/alerts", "alerts")
            causal = [
                item
                for item in alerts
                if item.get("rootCauseDeviceId") == root["id"]
                and item.get("state") in ("Firing", "Acknowledged")
            ]
            assert causal, "root cause not linked to actual injected dependency root"
            linked = {
                edge.get("source", edge.get("sourceDeviceId"))
                for edge in topology["links"]
            } | {
                edge.get("target", edge.get("targetDeviceId"))
                for edge in topology["links"]
            }
            assert root["id"] in linked, (
                "RCA root absent from topology dependency graph"
            )
            assert any(item.get("deviceId") != root["id"] for item in causal), (
                "no downstream dependency propagation"
            )
            return {"seed": seed, "root": root["id"], "dependent_alerts": len(causal)}
        finally:
            api("/api/faults/" + str(incident["id"]) + "/restore", {})

    check("independent_topology_dependency_rca", dependency_rca)

    def configuration():
        device = rng.choice(array("/api/devices", "devices"))["id"]
        path = "/api/config/" + str(device)
        before = api(path)
        assert isinstance(before["content"], str)
        original_lines = before["content"].splitlines()
        changed_lines = ["acceptance-replaced-" + str(seed), *original_lines[1:], "acceptance-added-" + str(seed)]
        changed = "\n".join(changed_lines)
        audit_before = Counter(json.dumps(item, sort_keys=True) for item in array("/api/audit", "audit"))
        restored = False
        try:
            saved = api(
                path,
                {"content": changed, "reason": "independent acceptance"},
                method="PUT",
            )
            observed = api(path)
            assert observed["content"] == changed, "configuration write not read back"
            assert observed["versionId"] == saved["versionId"] != before["versionId"], "configuration version did not advance"
            diff = api(
                path
                + "/diff?from="
                + str(before["versionId"])
                + "&to="
                + str(saved["versionId"])
            )
            verify_line_diff(diff["lines"], before["content"], changed)
        finally:
            restored = restore_configuration(api, path, before, changed)
        assert restored, "configuration test made no reversible change"
        audit = array("/api/audit", "audit")
        audit_after = Counter(json.dumps(item, sort_keys=True) for item in audit)
        assert any(
            audit_after[json.dumps(item, sort_keys=True)] > audit_before[json.dumps(item, sort_keys=True)]
            and item.get("deviceId") == device and item.get("action") == "config.rollback"
            for item in audit
        ), "rollback omitted from audit"
        return {"device": device, "restored_version": before["versionId"]}

    check("independent_configuration_diff_rollback_audit", configuration)

    def permissions():
        token = api("/api/test/identity", {"role": "viewer"})["token"]
        row = sample()
        try:
            api(
                "/api/faults",
                {"type": "CRC", "deviceId": row["deviceId"], "interfaceId": row["id"]},
                headers={"Authorization": "Bearer " + token},
            )
        except urllib.error.HTTPError as exc:
            assert exc.code == 403, f"expected permission denial, got {exc.code}"
            return {"viewer_write": "403"}
        raise AssertionError("viewer can write fault state")

    check("independent_server_write_permissions", permissions)
