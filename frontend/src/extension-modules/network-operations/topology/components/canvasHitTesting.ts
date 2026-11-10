/** canvasHitTesting is a renderer port independent of React screen state. */
import type { Cy, CyElement, CyNode } from "./canvasRendererTypes";

export function hostScale(host: HTMLElement): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  return {
    x: host.clientWidth ? rect.width / host.clientWidth : 1,
    y: host.clientHeight ? rect.height / host.clientHeight : 1,
  };
}

export function toHostPoint(
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  const scale = hostScale(host);
  return {
    x: (clientX - rect.left) / scale.x,
    y: (clientY - rect.top) / scale.y,
  };
}

export function nodeUnderPointer(
  cy: Cy,
  host: HTMLElement,
  event: MouseEvent,
): boolean {
  const point = toHostPoint(host, event.clientX, event.clientY);
  const pan = cy.pan();
  const zoom = cy.zoom();
  return cy.$("node").some((node) => {
    if (node.id().startsWith("group-")) return false;
    const position = node.position();
    const cx = pan.x + position.x * zoom;
    const cyY = pan.y + position.y * zoom;
    const halfWidth = (node.width() * zoom) / 2 + 4;
    const halfHeight = (node.height() * zoom) / 2 + 4;
    return (
      Math.abs(point.x - cx) <= halfWidth &&
      Math.abs(point.y - cyY) <= halfHeight
    );
  });
}

export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

export function edgeUnderPointer(
  cy: Cy,
  host: HTMLElement,
  event: MouseEvent,
): CyElement | null {
  const point = toHostPoint(host, event.clientX, event.clientY);
  const pan = cy.pan();
  const zoom = cy.zoom();
  const modelX = (point.x - pan.x) / zoom;
  const modelY = (point.y - pan.y) / zoom;
  const renderer = cy.renderer?.();
  if (renderer?.findNearestElements) {
    try {
      const nearest = renderer.findNearestElements(modelX, modelY, false, true);
      const edge = nearest?.find((ele: CyElement) => ele.isEdge?.());
      if (edge) return edge;
    } catch {
      // Fallback safely if renderer internals differ
    }
  }
  // Comprehensive distance check: check midpoint, control points, and endpoints segment
  const maxDist = 24 / zoom;
  let foundEdge: CyElement | null = null;
  let bestDist = Infinity;
  if (cy.edges) {
    cy.edges().forEach((edge) => {
      // Check midpoint
      const mid = edge.midpoint ? edge.midpoint() : null;
      if (mid) {
        const d = Math.hypot(modelX - mid.x, modelY - mid.y);
        if (d <= maxDist && d < bestDist) {
          bestDist = d;
          foundEdge = edge;
        }
      }
      // Check control points if curved
      const controls = edge.controlPoints ? edge.controlPoints() : null;
      if (controls && Array.isArray(controls)) {
        controls.forEach((cp: { x: number; y: number }) => {
          const d = Math.hypot(modelX - cp.x, modelY - cp.y);
          if (d <= maxDist && d < bestDist) {
            bestDist = d;
            foundEdge = edge;
          }
        });
      }
      const s = edge.source ? edge.source() : null;
      const t = edge.target ? edge.target() : null;
      const sPos = s && "position" in s ? (s as CyNode).position() : null;
      const tPos = t && "position" in t ? (t as CyNode).position() : null;
      if (sPos && tPos) {
        const dist = pointToSegmentDistance(
          modelX,
          modelY,
          sPos.x,
          sPos.y,
          tPos.x,
          tPos.y,
        );
        if (dist <= maxDist && dist < bestDist) {
          bestDist = dist;
          foundEdge = edge;
        }
      }
    });
  }
  return foundEdge;
}

export function elementUnderPointer(
  cy: Cy,
  host: HTMLElement,
  event: MouseEvent,
): boolean {
  return (
    nodeUnderPointer(cy, host, event) ||
    Boolean(edgeUnderPointer(cy, host, event))
  );
}
