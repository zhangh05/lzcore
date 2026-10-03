import { describe, expect, it } from 'vitest';
import { attractToLine, nearbySnapTargets, resolveDragAxis, type SnapBody, type SnapTarget } from '../../../extensions/network_operations/frontend/components/topologyDragSnap';

const moving: SnapBody = { id: 'a', x: 200, y: 100, halfW: 38, halfH: 30, region: 'r' };
const target: SnapTarget = { key: 'reference', line: 100, offset: 0, source: 'b', priority: 0 };

describe('gentle pointer attraction', () => {
  it('has a continuous monotone path, bounded correction and identical screen-space behaviour at every zoom', () => {
    for (const zoom of [.15, .25, .6, 1, 1.3, 4]) {
      let previous = -Infinity;
      for (let step = -700; step <= 700; step++) {
        const screen = step / 100;
        const result = attractToLine(100 + screen / zoom, 100, zoom);
        const shown = (result.position - 100) * zoom;
        expect(shown).toBeGreaterThanOrEqual(previous - 1e-9);
        if (previous !== -Infinity) expect(shown - previous).toBeLessThan(.025);
        expect(Math.abs(shown - screen)).toBeLessThan(2.5);
        expect(result.aligned).toBe(Math.abs(screen) <= 1 + 1e-9);
        previous = shown;
      }
      expect(attractToLine(100 + 5 / zoom, 100, zoom).position).toBeCloseTo(100 + 5 / zoom, 10);
    }
  });
  it('keeps the acquired target through competition and releases it outside the five-pixel radius', () => {
    const competitor = { ...target, key: 'competing', line: 102 };
    expect(resolveDragAxis(102, 1, [target, competitor], target.key, false).target?.key).toBe(target.key);
    expect(resolveDragAxis(105.1, 1, [target], target.key, false)).toMatchObject({ position: 105.1, target: null });
    expect(resolveDragAxis(101.5, 1, [target], null, false).aligned).toBe(false);
    expect(resolveDragAxis(100.5, 1, [target], null, false)).toMatchObject({ position: 100, aligned: true });
  });
  it('rejects far objects and edge-to-centre pairings, permits genuinely adjacent edge contact', () => {
    const near = { ...moving, id: 'near', x: 350 };
    const far = { ...moving, id: 'far', x: 1200 };
    const refs = nearbySnapTargets('y', moving, [near, far], 1);
    expect(new Set(refs.map(t => t.source))).toEqual(new Set(['near']));
    expect(refs.map(t => [t.offset, t.line - near.y])).toEqual([[-30, -30], [0, 0], [30, 30]]);
    const adjacent = { ...moving, id: 'adjacent', x: 278 };
    expect(nearbySnapTargets('x', moving, [adjacent], 1)).toContainEqual(expect.objectContaining({ offset: 38, line: 240 }));
  });
  it('does not force grid steps, even with grid attraction enabled', () => {
    for (const raw of [111.9, 112.1, 116, 120]) expect(resolveDragAxis(raw, 1, [], null, true).position).toBe(raw);
    expect(resolveDragAxis(127.5, 1, [], null, false).position).toBe(127.5);
    expect(resolveDragAxis(127.5, 1, [], null, true).position).toBe(128);
    expect(resolveDragAxis(125, 1, [], null, true).position).toBeGreaterThan(125);
    expect(resolveDragAxis(125, 1, [], null, true).aligned).toBe(false);
    for (const zoom of [.15, .25, .6, 1.3, 4]) {
      let key: string | null = null, previous = 0;
      for (let pixel = 0; pixel <= 200; pixel += .25) {
        const result = resolveDragAxis(pixel / zoom, zoom, [], key, true);
        expect(Math.abs(result.position * zoom - pixel)).toBeLessThan(2.5);
        expect(Math.abs(result.position * zoom - previous)).toBeLessThan(3);
        previous = result.position * zoom; key = result.target?.key || null;
      }
    }
  });
});
