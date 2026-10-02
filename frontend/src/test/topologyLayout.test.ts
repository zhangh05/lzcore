import { expect, test } from "vitest";
import { layoutTopology, linkHandles } from "../../../extensions/network_operations/frontend/components/topologyLayout";
import type { Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";
import { canvasLinkDescription, compactInterfaceLabel } from "../../../extensions/network_operations/frontend/components/NetOpsCanvas";

test("graph layout keeps links and objects and encloses grouped nodes", async () => {
  const topology: Topology = { topology_id: "t", name: "Network", description: "", version: 2, created_at: "", updated_at: "",
    nodes: ["a", "b", "c"].map((node_id) => ({ node_id, x: 0, y: 0, region_id: "g" })),
    groups: [],
    canvas_items: [{ item_id: "g", kind: "rectangle", text: "Site", auto_fit: true, x: 0, y: 0, width: 100, height: 100 }, { item_id: "note", kind: "text", text: "核心区域", x: 20, y: 20, width: 120, height: 36 }],
    links: [{ link_id: "ab", source_node_id: "a", target_node_id: "b", source_interface: "GE0/0", target_interface: "GE0/1", kind: "physical", source: "manual", status: "unknown" }],
  };
  const result = await layoutTopology(topology);
  expect(result.links).toEqual(topology.links);
  expect(result.canvas_items?.find(item => item.item_id === "note")).toEqual(topology.canvas_items?.find(item => item.item_id === "note"));
  expect(result.version).toBe(2);
  expect(result.nodes.find((node) => node.node_id === "a")!.x).toBeLessThan(result.nodes.find((node) => node.node_id === "b")!.x);
  const group = result.canvas_items!.find(item => item.item_id === "g")!;
  for (const node of result.nodes) {
    expect(node.x).toBeGreaterThan(group.x - group.width / 2);
    expect(node.y).toBeGreaterThan(group.y - group.height / 2);
    expect(node.x + 70).toBeLessThan(group.x + group.width / 2);
    expect(node.y + 55).toBeLessThan(group.y + group.height / 2);
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
  const maxY = Math.max(...result.nodes.map((node) => node.y + 55));
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
      { node_id: "core1", display_name: "Core-SW", role: "core", region_id: "zone-dc", x: 100, y: 100 },
      { node_id: "access1", display_name: "Access-SW", role: "access", region_id: "zone-dc", x: 100, y: 120 },
    ],
    groups: [],
    canvas_items: [
      { item_id: "zone-dc", kind: "rectangle", text: "数据中心区", auto_fit: true, x: 100, y: 110, width: 200, height: 160 },
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


test("automatic layout preserves fixed-link geometry and manually fixed region bounds", async () => {
  const topology: Topology = {topology_id:"rigid", name:"联动", description:"", version:1, created_at:"", updated_at:"",
    nodes:[{node_id:"a", x:100, y:100, lock_group:"rigid"}, {node_id:"b", x:420, y:230, lock_group:"rigid"}, {node_id:"c", x:500, y:500}],
    links:[], groups:[], canvas_items:[{item_id:"manual", kind:"rectangle", text:"手工框", x:250, y:250, width:600, height:500, auto_fit:false}]};
  for (const algorithm of ["grid", "radial", "hierarchy-h"] as const) {
    const result = await layoutTopology(topology, algorithm);
    expect(result.nodes[1].x-result.nodes[0].x).toBe(320);
    expect(result.nodes[1].y-result.nodes[0].y).toBe(130);
    expect(result.canvas_items).toEqual(topology.canvas_items);
    expect(result.nodes.map(node=>node.node_id)).toEqual(["a", "b", "c"]);
  }
});
