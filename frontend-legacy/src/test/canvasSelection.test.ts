import { describe, expect, it } from "vitest";
import { buildCanvasSelection } from "../../../extensions/network_operations/frontend/components/canvasSelection";

const topology = {
  topology_id: "t1",
  name: "生产网",
  version: 1,
  nodes: [
    { node_id: "n1", display_name: "核心PE1", x: 0, y: 0 },
    { node_id: "n2", display_name: "核心PE2", x: 200, y: 0 },
    { node_id: "n3", display_name: "接入CE1", x: 400, y: 0 },
  ],
  links: [
    { link_id: "l1", source_node_id: "n1", target_node_id: "n2" },
    { link_id: "l2", source_node_id: "n2", target_node_id: "n3" },
  ],
  groups: [{ group_id: "g1", name: "生产DC", kind: "datacenter", x: 0, y: 0, width: 100, height: 100 }],
  canvas_items: [{ item_id: "i1", kind: "text", text: "核心业务说明", x: 0, y: 0, width: 10, height: 10 }],
} as never;

describe("agent canvas context", () => {
  it("reports the whole drawing when nothing is selected", () => {
    expect(buildCanvasSelection(topology, [], null)).toEqual({
      node_ids: [], link_ids: [], canvas_item_ids: [], group_ids: [], label: "整张图纸",
    });
  });

  it("carries every selected drawing object", () => {
    const selection = buildCanvasSelection(topology, ["n1", "n2", "n3"], { type: "node", nodeId: "n1" });
    expect(selection.node_ids.sort()).toEqual(["n1", "n2", "n3"]);
    expect(selection.label).toBe("已选 3 个图纸对象");
  });

  it("falls back to the inspector when the canvas reports no selection", () => {
    expect(buildCanvasSelection(topology, [], { type: "node", nodeId: "n3" }).node_ids).toEqual(["n3"]);
  });

  it("describes a drawing item by its text", () => {
    expect(buildCanvasSelection(topology, [], { type: "canvas_item", itemId: "i1" }).label).toBe("核心业务说明");
  });

  it("survives a missing topology", () => {
    expect(buildCanvasSelection(null, ["n1"], null).label).toBe("整张图纸");
  });
});
