"""Independent inventory field, identity and relationship acceptance."""

from __future__ import annotations

import ipaddress
import math
import re


def field(row, *names):
    for name in names:
        if name in row:
            return row[name]
    raise AssertionError("missing inventory field: " + "/".join(names))


def number(row, *names, minimum=0, maximum=math.inf):
    value = field(row, *names)
    assert type(value) in (int, float) and math.isfinite(value), "invalid numeric inventory field: " + names[0]
    assert minimum <= value <= maximum, "inventory field outside range: " + names[0]
    return value


def verify_inventory(devices, interfaces):
    assert len(devices) >= 50 and len(interfaces) >= 300, "inventory below baseline"
    device_ids = [field(row, "id") for row in devices]
    interface_ids = [field(row, "id") for row in interfaces]
    assert all(isinstance(identifier, str) and identifier for identifier in device_ids + interface_ids)
    assert len(set(device_ids)) == len(devices), "duplicate device identity"
    assert len(set(interface_ids)) == len(interfaces), "duplicate interface identity"
    roles, sites = set(), set()
    aliases = {
        "core": "core", "核心": "core", "核心交换机": "core",
        "router": "router", "路由": "router", "路由器": "router",
        "aggregation": "aggregation", "distribution": "aggregation", "汇聚": "aggregation",
        "access": "access", "接入": "access", "wan": "wan", "wan-router": "wan",
        "firewall": "firewall", "防火墙": "firewall", "wireless": "wireless", "无线": "wireless",
        "server": "server", "服务器": "server",
    }
    for row in devices:
        for key, names in {
            "name": ("name",), "vendor": ("vendor", "manufacturer"), "model": ("model",),
            "serial": ("serial", "serialNumber"), "version": ("version", "firmware"),
            "status": ("status",),
        }.items():
            assert isinstance(field(row, *names), str) and field(row, *names), "empty device field: " + key
        ipaddress.ip_address(field(row, "ip"))
        role = str(field(row, "role")).lower()
        assert role, "empty device role"
        if role in aliases:
            roles.add(aliases[role])
        site = field(row, "siteId", "site")
        if isinstance(site, dict):
            site = field(site, "id", "name")
        assert isinstance(site, str) and site, "missing stable site"
        sites.add(site)
        for names in (("uptime",), ("temperature", "temp")):
            number(row, *names)
        for names in (("cpu", "CPU"), ("memory", "mem")):
            number(row, *names, maximum=100)
        assert type(field(row, "lastSeen")) in (int, float, str), "invalid lastSeen"
        assert isinstance(field(row, "tags"), list), "invalid tags"
    assert roles == set(aliases.values()), "required device roles missing: " + ",".join(sorted(set(aliases.values()) - roles))
    assert len(sites) >= 4, "fewer than four sites"
    for row in interfaces:
        assert field(row, "deviceId") in device_ids, "interface references missing device"
        for names in (("adminStatus", "admin"), ("operStatus", "oper")):
            assert str(field(row, *names)).lower() in {"up", "down", "unknown", "testing", "disabled"}, "invalid interface state"
        number(row, "speed", minimum=1)
        number(row, "mtu", "MTU", minimum=1)
        assert str(field(row, "duplex")).lower() in {"full", "half", "auto", "unknown"}
        assert re.fullmatch(r"(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}", str(field(row, "mac", "MAC")), re.IGNORECASE), "invalid interface MAC"
        address = field(row, "ip", "IP")
        if address:
            ipaddress.ip_interface(address)
        for key in ("rxBytes", "txBytes", "rxPackets", "txPackets", "rxBps", "txBps", "rxPps", "txPps", "errors", "crc", "discards", "noBuffers"):
            number(row, key)
        number(row, "utilization", maximum=1)
        assert type(field(row, "lastChange")) in (int, float, str), "invalid lastChange"
    return {"devices": len(devices), "interfaces": len(interfaces), "roles": sorted(roles), "sites": sorted(sites), "complete_fields": True}
