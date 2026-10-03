import { describe, expect, it } from "vitest";
import { topologyLinkColor } from "../../../extensions/network_operations/frontend/components/topologyPalette";
import type { TopologyLink } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";

function createLink(overrides: Partial<TopologyLink> = {}): TopologyLink {
  return {
    link_id: "link-1",
    source_node_id: "node-a",
    source_interface: "GE0/1",
    target_node_id: "node-b",
    target_interface: "GE0/2",
    kind: "physical",
    source: "manual",
    status: "up",
    ...overrides,
  };
}

function resolveLinkVisuals(link: TopologyLink) {
  const defaultEdgeStyle =
    link.status === "down"
      ? "dotted"
      : link.kind === "logical"
        ? "dashed"
        : "solid";
  const defaultEdgeWidth = link.status === "down" ? 3 : 2.5;
  const edgeWidth =
    typeof link.style?.width === "number" && !Number.isNaN(link.style.width)
      ? link.style.width
      : defaultEdgeWidth;

  return {
    edgeColor: topologyLinkColor(link),
    edgeStyle: link.style?.line_style || defaultEdgeStyle,
    edgeWidth,
    curveStyle: link.style?.curve_style || "auto",
    selectedEdgeWidth: Math.max(4, edgeWidth + 1.5),
  };
}

describe("TopologyLink styling and routing resolution", () => {
  it("uses semantic status and kind defaults when no custom style is set", () => {
    const upPhysical = createLink({ status: "up", kind: "physical" });
    const visualsUp = resolveLinkVisuals(upPhysical);
    expect(visualsUp.edgeColor).toBe("#24733b");
    expect(visualsUp.edgeStyle).toBe("solid");
    expect(visualsUp.edgeWidth).toBe(2.5);
    expect(visualsUp.curveStyle).toBe("auto");
    expect(visualsUp.selectedEdgeWidth).toBe(4);

    const logicalLink = createLink({ status: "up", kind: "logical" });
    const visualsLogical = resolveLinkVisuals(logicalLink);
    expect(visualsLogical.edgeStyle).toBe("dashed");

    const downLink = createLink({ status: "down", kind: "physical" });
    const visualsDown = resolveLinkVisuals(downLink);
    expect(visualsDown.edgeColor).toBe("#bd3040");
    expect(visualsDown.edgeStyle).toBe("dotted");
    expect(visualsDown.edgeWidth).toBe(3);
  });

  it("prioritizes custom stroke width, line style, and color", () => {
    const customLink = createLink({
      status: "up",
      kind: "physical",
      style: {
        color: "#2563eb",
        width: 6,
        line_style: "dashed",
        curve_style: "straight",
      },
    });

    const visuals = resolveLinkVisuals(customLink);
    expect(visuals.edgeColor).toBe("#2563eb");
    expect(visuals.edgeStyle).toBe("dashed");
    expect(visuals.edgeWidth).toBe(6);
    expect(visuals.curveStyle).toBe("straight");
    expect(visuals.selectedEdgeWidth).toBe(7.5);
  });

  it("supports orthogonal taxi routing and dotted style", () => {
    const taxiLink = createLink({
      style: {
        curve_style: "taxi",
        line_style: "dotted",
        width: 4,
      },
    });

    const visuals = resolveLinkVisuals(taxiLink);
    expect(visuals.curveStyle).toBe("taxi");
    expect(visuals.edgeStyle).toBe("dotted");
    expect(visuals.edgeWidth).toBe(4);
    expect(visuals.selectedEdgeWidth).toBe(5.5);
  });

  it("allows partial style overrides while retaining defaults for unset fields", () => {
    const onlyColor = createLink({
      status: "up",
      kind: "physical",
      style: { color: "#8b5cf6" },
    });
    const visuals = resolveLinkVisuals(onlyColor);
    expect(visuals.edgeColor).toBe("#8b5cf6");
    expect(visuals.edgeStyle).toBe("solid");
    expect(visuals.edgeWidth).toBe(2.5);
    expect(visuals.curveStyle).toBe("auto");
  });
});
