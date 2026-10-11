"""Inventory counts alone must not hide missing fields or broken references."""

from copy import deepcopy

import pytest

from scripts.benchmark_noc_inventory import verify_inventory


def inventory():
    roles = ("core", "router", "aggregation", "access", "wan", "firewall", "wireless", "server")
    devices = [{"id": f"d{i}", "name": f"device{i}", "ip": f"10.0.0.{i+1}",
                "vendor": "vendor", "model": "model", "serial": f"serial{i}", "version": "1.0",
                "status": "up", "role": roles[i % 8], "siteId": f"site{i % 4}",
                "uptime": 10, "temperature": 40, "cpu": 20, "memory": 30,
                "lastSeen": 1000, "tags": []} for i in range(50)]
    interfaces = [{"id": f"i{i}", "deviceId": f"d{i % 50}", "adminStatus": "up", "operStatus": "up",
                   "speed": 1e9, "mtu": 1500, "duplex": "full", "mac": "aa:bb:cc:dd:ee:ff", "ip": "",
                   "lastChange": 1000, "utilization": 0.1,
                   **{key: 1 for key in ("rxBytes", "txBytes", "rxPackets", "txPackets", "rxBps", "txBps",
                                         "rxPps", "txPps", "errors", "crc", "discards", "noBuffers")}}
                  for i in range(300)]
    return devices, interfaces


def test_complete_inventory_and_permitted_field_aliases():
    devices, interfaces = inventory()
    devices[0]["site"] = {"id": devices[0].pop("siteId")}
    interfaces[0]["admin"] = interfaces[0].pop("adminStatus")
    assert verify_inventory(devices, interfaces)["complete_fields"]


@pytest.mark.parametrize("mutation", [
    lambda d, i: d[0].pop("serial"),
    lambda d, i: i[0].pop("noBuffers"),
    lambda d, i: d[0].update(id=d[1]["id"]),
    lambda d, i: i[0].update(deviceId="missing"),
    lambda d, i: i[0].update(rxBytes=float("nan")),
    lambda d, i: i[0].update(utilization=1.1),
    lambda d, i: i[0].update(errors=True),
    lambda d, i: i[0].update(mac="broken"),
    lambda d, i: [r.update(siteId="single") for r in d],
    lambda d, i: [r.update(role="access") for r in d],
])
def test_large_inventory_rejects_incomplete_or_invalid_observations(mutation):
    devices, interfaces = deepcopy(inventory())
    mutation(devices, interfaces)
    with pytest.raises((AssertionError, ValueError)):
        verify_inventory(devices, interfaces)
