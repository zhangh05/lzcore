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

test("layoutTopology automatically resizes canvas item rectangle zones enclosing member nodes", async () => {
  const topology: Topology = {
    topology_id: "t-zone",
    name: "Zone Test",
    description: "",
    version: 1,
    created_at: "",
    updated_at: "",
    nodes: [
      { node_id: "core1", display_name: "Core-SW", role: "core", x: 100, y: 100 },
      { node_id: "access1", display_name: "Access-SW", role: "access", x: 100, y: 120 },
    ],
    groups: [],
    canvas_items: [
      { item_id: "zone-dc", kind: "rectangle", text: "数据中心区", x: 100, y: 110, width: 200, height: 160 },
    ],
    links: [
      { link_id: "l1", source_node_id: "core1", target_node_id: "access1", source_interface: "GE1", target_interface: "GE1", kind: "physical", source: "manual", status: "up" },
    ],
  };

  const result = await layoutTopology(topology, "hierarchy-v");
  const zone = result.canvas_items?.find((item) => item.item_id === "zone-dc");
  expect(zone).toBeDefined();

  const coreNode = result.nodes.find((n) => n.node_id === "core1")!;
  const accessNode = result.nodes.find((n) => n.node_id === "access1")!;

  // Tier-aware check: Core switch should be above access switch in hierarchy-v
  expect(coreNode.y).toBeLessThan(accessNode.y);

  // Auto-fit zone bounds check: Zone must enclose both nodes
  const halfW = zone!.width / 2;
  const halfH = zone!.height / 2;
  for (const node of [coreNode, accessNode]) {
    expect(node.x).toBeGreaterThanOrEqual(zone!.x - halfW);
    expect(node.x).toBeLessThanOrEqual(zone!.x + halfW);
    expect(node.y).toBeGreaterThanOrEqual(zone!.y - halfH);
    expect(node.y).toBeLessThanOrEqual(zone!.y + halfH);
  }
});

