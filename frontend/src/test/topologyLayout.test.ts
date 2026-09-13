import { expect, test } from "vitest";
import { layoutTopology, linkHandles } from "../../../extensions/network_operations/frontend/components/topologyLayout";
import type { Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";

test("graph layout keeps links and objects and encloses grouped nodes", async () => {
  const topology: Topology = { topology_id: "t", name: "Network", description: "", version: 2, created_at: "", updated_at: "",
    nodes: ["a", "b", "c"].map((device_id) => ({ device_id, x: 0, y: 0, group_id: "g" })),
    groups: [{ group_id: "g", name: "Site", kind: "region", x: 0, y: 0, width: 100, height: 100 }],
    links: [{ link_id: "ab", source_device_id: "a", target_device_id: "b", source_interface: "GE0/0", target_interface: "GE0/1", kind: "physical", source: "manual", status: "unknown" }],
  };
  const result = await layoutTopology(topology);
  expect(result.links).toEqual(topology.links);
  expect(result.version).toBe(2);
  expect(result.nodes.find((node) => node.device_id === "a")!.x).toBeLessThan(result.nodes.find((node) => node.device_id === "b")!.x);
  const group = result.groups[0];
  for (const node of result.nodes) {
    expect(node.x).toBeGreaterThan(group.x);
    expect(node.y).toBeGreaterThan(group.y);
    expect(node.x + 160).toBeLessThan(group.x + group.width);
    expect(node.y + 130).toBeLessThan(group.y + group.height);
  }
  expect(topology.nodes.every((node) => node.x === 0 && node.y === 0)).toBe(true);
});

test("ports face the adjacent node on horizontal and vertical links", () => {
  expect(linkHandles({ x: 0, y: 0 }, { x: 300, y: 0 })).toEqual({ sourceHandle: "right", targetHandle: "left" });
  expect(linkHandles({ x: 0, y: 300 }, { x: 0, y: 0 })).toEqual({ sourceHandle: "top", targetHandle: "bottom" });
});

test("packs disconnected devices into compact rows instead of a tall column", async () => {
  const topology: Topology = { topology_id: "t", name: "Network", description: "", version: 1, created_at: "", updated_at: "",
    nodes: ["a", "b", "c", "d", "e", "f"].map((device_id) => ({ device_id, x: 0, y: 0 })),
    groups: [],
    links: [{ link_id: "ab", source_device_id: "a", target_device_id: "b", source_interface: "GE0/0", target_interface: "GE0/1", kind: "physical", source: "manual", status: "unknown" }],
  };
  const result = await layoutTopology(topology);
  const maxY = Math.max(...result.nodes.map((node) => node.y + 130));
  expect(maxY).toBeLessThanOrEqual(430);
  expect(result.nodes.find((node) => node.device_id === "a")!.x).toBeLessThan(result.nodes.find((node) => node.device_id === "b")!.x);
});
