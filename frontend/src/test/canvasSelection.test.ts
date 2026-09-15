/**
 * What the Agent is told the user selected.
 *
 * The bug this pins down: box-selecting several devices and asking about
 * "these" reached the model as "the whole topology", so the Agent answered
 * about a scope the user had not chosen.
 */

import { describe, expect, it } from "vitest";
import { buildCanvasSelection } from "../../../extensions/network_operations/frontend/components/canvasSelection";

const devices = [
  { device_id: "d1", name: "PE1", host: "10.0.0.1", vendor: "h3c", device_type: "router" },
  { device_id: "d2", name: "PE2", host: "10.0.0.2", vendor: "h3c", device_type: "router" },
  { device_id: "d3", name: "CE1", host: "10.0.0.3", vendor: "huawei", device_type: "switch" },
] as never;

const topology = {
  topology_id: "t1",
  name: "生产网",
  version: 1,
  nodes: [
    { node_id: "n1", linked_device_id: "d1", display_name: "核心PE1", x: 0, y: 0 },
    { node_id: "n2", linked_device_id: "d2", display_name: "核心PE2", x: 200, y: 0 },
    { node_id: "n3", linked_device_id: "d3", display_name: "接入CE1", x: 400, y: 0 },
    { node_id: "note", display_name: "Internet", x: 600, y: 0 },
  ],
  links: [
    { link_id: "l1", source_node_id: "n1", target_node_id: "n2", source_interface: "", target_interface: "" },
    { link_id: "l2", source_node_id: "n2", target_node_id: "n3", source_interface: "", target_interface: "" },
  ],
  groups: [{ group_id: "g1", name: "生产DC", kind: "datacenter", x: 0, y: 0, width: 100, height: 100 }],
  canvas_items: [{ item_id: "i1", kind: "text", text: "核心业务说明", x: 0, y: 0, width: 10, height: 10 }],
} as never;

describe("agent canvas context", () => {
  it("reports the whole drawing when nothing is selected", () => {
    expect(buildCanvasSelection(topology, devices, [], null)).toEqual({ device_ids: [], link_ids: [], label: "整张拓扑" });
  });

  it("carries every device of a multi-selection, not just the inspector's one", () => {
    const selection = buildCanvasSelection(topology, devices, ["n1", "n2", "n3"], { type: "node", nodeId: "n1" });
    expect(selection.device_ids.sort()).toEqual(["d1", "d2", "d3"]);
    expect(selection.label).toBe("已选 3 个节点 · 0 条链路");
  });

  it("includes the endpoints of selected links", () => {
    const selection = buildCanvasSelection(topology, devices, ["n1", "l2"], null);
    expect(selection.device_ids.sort()).toEqual(["d1", "d2", "d3"]);
    expect(selection.link_ids).toEqual(["l2"]);
    expect(selection.label).toBe("已选 1 个节点 · 1 条链路");
  });

  it("ignores unlinked nodes instead of inventing a device", () => {
    const selection = buildCanvasSelection(topology, devices, ["n1", "note"], null);
    expect(selection.device_ids).toEqual(["d1"]);
    expect(selection.label).toBe("已选 2 个节点 · 0 条链路");
  });

  it("names a single selected node by its device", () => {
    expect(buildCanvasSelection(topology, devices, ["n2"], null)).toEqual({
      device_ids: ["d2"], link_ids: [], label: "PE2",
    });
  });

  it("marks a single node that has no asset behind it", () => {
    expect(buildCanvasSelection(topology, devices, ["note"], null)).toEqual({
      device_ids: [], link_ids: [], label: "Internet（未关联）",
    });
  });

  it("falls back to the inspector when the canvas reports no selection", () => {
    // e.g. the inspector is open after a reload, before any canvas gesture
    expect(buildCanvasSelection(topology, devices, [], { type: "node", nodeId: "n3" })).toEqual({
      device_ids: ["d3"], link_ids: [], label: "CE1",
    });
  });

  it("prefers the canvas selection over a stale inspector selection", () => {
    const selection = buildCanvasSelection(topology, devices, ["n3"], { type: "node", nodeId: "n1" });
    expect(selection.device_ids).toEqual(["d3"]);
  });

  it("describes a link by both endpoint names", () => {
    expect(buildCanvasSelection(topology, devices, ["l1"], null)).toEqual({
      device_ids: ["d1", "d2"], link_ids: ["l1"], label: "核心PE1 ↔ 核心PE2",
    });
  });

  it("describes a group by its nodes' devices and a drawing item by its text", () => {
    expect(buildCanvasSelection(topology, devices, [], { type: "group", groupId: "g1" })).toEqual({
      device_ids: [], link_ids: [], label: "生产DC",
    });
    expect(buildCanvasSelection(topology, devices, [], { type: "canvas_item", itemId: "i1" })).toEqual({
      device_ids: [], link_ids: [], label: "核心业务说明",
    });
  });

  it("survives a missing topology", () => {
    expect(buildCanvasSelection(null, devices, ["n1"], null)).toEqual({ device_ids: [], link_ids: [], label: "整张拓扑" });
  });
});
