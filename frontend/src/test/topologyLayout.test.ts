import { expect, test } from "vitest";
import { layoutTopology, linkHandles } from "../../../extensions/network_operations/frontend/components/topologyLayout";
import type { Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";
import { canvasLinkDescription, compactInterfaceLabel } from "../../../extensions/network_operations/frontend/components/NetOpsCanvas";

test("graph layout keeps links and objects and encloses grouped nodes", async () => {
  const topology: Topology = { topology_id: "t", name: "Network", description: "", version: 2, created_at: "", updated_at: "",
    nodes: ["a", "b", "c"].map((node_id) => ({ node_id, x: 0, y: 0, group_id: "g" })),
    groups: [{ group_id: "g", name: "Site", kind: "region", x: 0, y: 0, width: 100, height: 100 }],
    canvas_items: [{ item_id: "note", kind: "text", text: "核心区域", x: 20, y: 20, width: 120, height: 36 }],
    links: [{ link_id: "ab", source_node_id: "a", target_node_id: "b", source_interface: "GE0/0", target_interface: "GE0/1", kind: "physical", source: "manual", status: "unknown" }],
  };
  const result = await layoutTopology(topology);
  expect(result.links).toEqual(topology.links);
  expect(result.canvas_items).toEqual(topology.canvas_items);
  expect(result.version).toBe(2);
  expect(result.nodes.find((node) => node.node_id === "a")!.x).toBeLessThan(result.nodes.find((node) => node.node_id === "b")!.x);
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

test("canvas interface labels preserve the port while removing vendor-name noise", () => {
  expect(compactInterfaceLabel("GigabitEthernet0/0/1")).toBe("GE0/0/1");
  expect(compactInterfaceLabel("Ten-GigabitEthernet 1/0/1")).toBe("XGE1/0/1");
  expect(compactInterfaceLabel("Bridge-Aggregation 12")).toBe("BAGG12");
  expect(compactInterfaceLabel("GE0/0")).toBe("GE0/0");
});

test("link descriptions stay in link details until the owner opts into canvas text", () => {
  expect(canvasLinkDescription({ label: "CE1 接入线路", metadata: {} })).toBe("");
  expect(canvasLinkDescription({ label: "CE1 接入线路", metadata: { show_description: true } })).toBe("CE1 接入线路");
});

test("packs disconnected devices into compact rows instead of a tall column", async () => {
  const topology: Topology = { topology_id: "t", name: "Network", description: "", version: 1, created_at: "", updated_at: "",
    nodes: ["a", "b", "c", "d", "e", "f"].map((node_id) => ({ node_id, x: 0, y: 0 })),
    groups: [],
    links: [{ link_id: "ab", source_node_id: "a", target_node_id: "b", source_interface: "GE0/0", target_interface: "GE0/1", kind: "physical", source: "manual", status: "unknown" }],
  };
  const result = await layoutTopology(topology);
  const maxY = Math.max(...result.nodes.map((node) => node.y + 130));
  expect(maxY).toBeLessThanOrEqual(430);
  expect(result.nodes.find((node) => node.node_id === "a")!.x).toBeLessThan(result.nodes.find((node) => node.node_id === "b")!.x);
});
