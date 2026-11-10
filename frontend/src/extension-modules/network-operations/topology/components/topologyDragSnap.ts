/** Screen-space attraction with a continuous entry/exit curve. */
export type SnapTarget = { key: string; line: number; offset: number; source: string | null; priority: number };
export type SnapBody = { id: string; x: number; y: number; halfW: number; halfH: number; region?: string | null };

export function attractToLine(raw: number, destination: number, zoom: number) {
  const distance = Math.abs(raw - destination) * zoom;
  if (distance >= 5) return { position: raw, aligned: false };
  if (distance <= 1 + 1e-9) return { position: destination, aligned: true };
  const t = (distance - 1) / 4;
  const weight = 1 - t * t * (3 - 2 * t);
  return { position: raw + (destination - raw) * weight, aligned: false };
}

export function nearbySnapTargets(axis: 'x' | 'y', moving: SnapBody, others: SnapBody[], zoom: number, longRange = false): SnapTarget[] {
  const half = axis === 'x' ? moving.halfW : moving.halfH;
  const cross = axis === 'x' ? 'y' : 'x';
  const crossHalf = axis === 'x' ? 'halfH' : 'halfW';
  return others.flatMap(other => {
    const gap = Math.max(0, Math.abs(other[cross] - moving[cross]) - other[crossHalf] - moving[crossHalf]) * zoom;
    if (!longRange && gap > 180) return [];
    const otherHalf = axis === 'x' ? other.halfW : other.halfH;
    const priority = moving.region && moving.region === other.region ? 0 : 1;
    const result = [-1, 0, 1].map(edge => ({ key: `${other.id}:${axis}:${edge}:${edge}`, source: other.id,
      line: other[axis] + edge * otherHalf, offset: edge * half, priority }));
    // Opposite edges only pair when the bodies actually approach each other,
    // with overlapping perpendicular spans. Never pair an edge with a centre.
    const alongGap = Math.abs(other[axis] - moving[axis]) - half - otherHalf;
    if (gap === 0 && Math.abs(alongGap) * zoom <= 12) {
      const side = other[axis] > moving[axis] ? 1 : -1;
      result.push({ key: `${other.id}:${axis}:${side}:${-side}`, source: other.id,
        line: other[axis] - side * otherHalf, offset: side * half, priority: priority + 1 });
    }
    return result;
  });
}

export function alignmentPreviewTarget(raw: number, zoom: number, targets: SnapTarget[], previousKey: string | null, radius = 12) {
  const candidates = targets.filter(target => Math.abs(target.line - target.offset - raw) * zoom < radius);
  const held = candidates.find(target => target.key === previousKey);
  return held || candidates.sort((a, b) => Math.abs(a.line - a.offset - raw) - Math.abs(b.line - b.offset - raw)
    || a.priority - b.priority || a.key.localeCompare(b.key))[0];
}

export function resolveDragAxis(raw: number, zoom: number, targets: SnapTarget[], previousKey: string | null, grid: boolean) {
  const target = alignmentPreviewTarget(raw, zoom, targets, previousKey, 5);
  const nearestGridLine = Math.round(raw / 32) * 32;
  const previousGridLine = previousKey?.startsWith('grid:') ? Number(previousKey.slice(5)) : nearestGridLine;
  const gridLine = Math.abs(previousGridLine - raw) * zoom < 5 ? previousGridLine : nearestGridLine;
  const chosen = target || (grid && Math.abs(gridLine - raw) * zoom < 5
    ? { key: `grid:${gridLine}`, source: null, line: gridLine, offset: 0, priority: 2 } : undefined);
  if (!chosen) return { position: raw, aligned: false, target: null };
  return { ...attractToLine(raw, chosen.line - chosen.offset, zoom), target: chosen };
}
