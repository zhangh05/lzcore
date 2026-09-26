import { describe, expect, it } from "vitest";
import { dataUriToBlob, exportTopologyToSvg } from "../../../extensions/network_operations/frontend/components/topologyExport";
import type { Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";

describe("topologyExport", () => {
  const sampleTopology: Topology = {
    topology_id: "topo-test",
    name: "测试-中型企业网络",
    description: "测试拓扑",
    version: 1,
    created_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:00:00Z",
    nodes: [
      {
        node_id: "node-core-1",
        display_name: "CORE-SW-01",
        device_type: "switch_core",
        x: 300,
        y: 200,
        ip: "10.0.0.1",
        vendor: "Huawei",
        model: "S12700",
        role: "core",
      },
      {
        node_id: "node-core-2",
        display_name: "CORE-SW-02",
        device_type: "switch_core",
        x: 500,
        y: 200,
        ip: "10.0.0.2",
        vendor: "Huawei",
        model: "S12700",
        role: "core",
      },
    ],
    links: [
      {
        link_id: "link-core-1-2",
        source_node_id: "node-core-1",
        source_interface: "10GE1/0/1",
        target_node_id: "node-core-2",
        target_interface: "10GE1/0/1",
        kind: "physical",
        source: "manual",
        status: "up",
        label: "40Gbps Trunk",
      },
    ],
    canvas_items: [
      {
        item_id: "item-zone-core",
        kind: "rectangle",
        text: "核心交换区",
        x: 400,
        y: 200,
        width: 380,
        height: 180,
      },
    ],
    groups: [],
  };

  it("exports valid SVG with nodes, links, IP addresses, and zones", () => {
    const svg = exportTopologyToSvg(sampleTopology, { showInterfaces: true });
    expect(svg).toContain("<?xml");
    expect(svg).toContain("<svg");
    expect(svg).toContain("CORE-SW-01");
    expect(svg).toContain("CORE-SW-02");
    expect(svg).toContain("10.0.0.1");
    expect(svg).toContain("10.0.0.2");
    expect(svg).toContain("核心交换区");
    expect(svg).toContain("10GE1/0/1");
    expect(svg).toContain("40Gbps Trunk");
    expect(svg).toContain("</svg>");
  });

  it("includes whiteboard data in SVG when provided", () => {
    const svg = exportTopologyToSvg(sampleTopology, {
      whiteboardData: {
        strokes: [
          {
            id: "stroke-1",
            tool: "pen",
            color: "#ef4444",
            size: 6,
            points: [{ x: 100, y: 100 }, { x: 150, y: 150 }],
          },
        ],
        notes: [
          {
            id: "note-1",
            x: 200,
            y: 200,
            text: "重点关注链路状态",
            color: "#eab308",
          },
        ],
      },
    });
    expect(svg).toContain("#ef4444");
    expect(svg).toContain("重点关注链路状态");
  });

  it("converts data URI to Blob correctly", () => {
    // 1x1 transparent png data URI
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const blob = dataUriToBlob(dataUri);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);
  });
});
