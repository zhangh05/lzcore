import type { Cy, CyEdge } from "./canvasRendererTypes";
import { portLabelOffsets } from "./topologyPortLabels";

export type installCanvasPortGeometryPorts = {
  cy: Cy;
};

export function installCanvasPortGeometry({
  cy,
}: installCanvasPortGeometryPorts) {
  const portGeometry = new Map<CyEdge, string>();
  cy.on("render", () => {
    const live = new Set<CyEdge>();
    cy.edges().forEach((edge) => {
      live.add(edge);
      const start = edge.sourceEndpoint();
      const end = edge.targetEndpoint();
      const controls = edge.controlPoints();
      // Self-loops have two quadratics, not the single parallel-link arc.
      if (!start || !end || (controls && controls.length > 1)) return;
      const coordinates = [
        start.x,
        start.y,
        end.x,
        end.y,
        ...(controls || []).flatMap((p) => [p.x, p.y]),
      ];
      if (!coordinates.every(Number.isFinite)) return;
      const key = coordinates.join(",");
      if (portGeometry.get(edge) === key) return;
      portGeometry.set(edge, key);
      const offsets = portLabelOffsets(start, end, controls?.[0]);
      const maxOffset = 22;
      const srcOffset = Math.min(offsets.source, maxOffset);
      const tgtOffset = Math.min(offsets.target, maxOffset);
      edge.style({
        "source-text-offset": srcOffset,
        "target-text-offset": tgtOffset,
      });
    });
    for (const edge of portGeometry.keys())
      if (!live.has(edge)) portGeometry.delete(edge);
  });
}
