type Point = { x: number; y: number };

/** Keep labels at the same curve parameter across a parallel bundle, rather
 * than the same distance from its endpoints (which crowds the outer arcs).
 * Cytoscape expects arc-length offsets, not a fraction of the curve. */
export function portLabelOffsets(start: Point, end: Point, control?: Point) {
  const point = (t: number): Point => control ? {
    x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
    y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
  } : { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) };
  const length = (from: number, to: number) => {
    let previous = point(from);
    let total = 0;
    for (let i = 1; i <= 24; i++) {
      const next = point(from + (to - from) * i / 24);
      total += Math.hypot(next.x - previous.x, next.y - previous.y);
      previous = next;
    }
    return total;
  };
  return { source: length(0, 0.22), target: length(0.78, 1) };
}
