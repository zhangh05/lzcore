import { describe, expect, it } from "vitest";
import { portLabelOffsets } from "../../../extensions/network_operations/frontend/components/topologyPortLabels";

describe("port label curve offsets", () => {
  it("keeps single-line labels separate even on short links", () => {
    expect(portLabelOffsets({ x: 0, y: 0 }, { x: 100, y: 0 }).source).toBeCloseTo(22);
    expect(portLabelOffsets({ x: 0, y: 0 }, { x: 100, y: 0 }).target).toBeCloseTo(22);
  });

  it.each([2, 3, 5, 8])("spreads %i parallel links according to their own arc, not a fixed offset", count => {
    const offsets = Array.from({ length: count }, (_, i) => portLabelOffsets(
      { x: 0, y: 0 }, { x: 600, y: 0 }, { x: 300, y: (i - (count - 1) / 2) * 144 },
    ));
    offsets.forEach(offset => {
      expect(offset.source).toBeCloseTo(offset.target, 6);
      expect(offset.source).toBeGreaterThanOrEqual(132);
    });
    expect(offsets[0].source).toBeCloseTo(offsets[count - 1].source, 6);
    if (count > 2) expect(offsets[0].source).toBeGreaterThan(offsets[Math.floor(count / 2)].source);
  });

  it("follows asymmetric clipping and reversed endpoints without swapping ports", () => {
    const a = { x: 48, y: 25 }, b = { x: 420, y: 270 }, c = { x: 180, y: -120 };
    const forward = portLabelOffsets(a, b, c), reverse = portLabelOffsets(b, a, c);
    expect(forward.source).not.toBeCloseTo(forward.target);
    expect(reverse.source).toBeCloseTo(forward.target, 6);
    expect(reverse.target).toBeCloseTo(forward.source, 6);
  });

  it("is invariant under translation/rotation and scales with the drawing", () => {
    const a = { x: 0, y: 0 }, b = { x: 600, y: 0 }, c = { x: 300, y: 144 };
    const transform = (p: typeof a) => ({ x: -p.y * 2 + 57, y: p.x * 2 - 123 });
    const original = portLabelOffsets(a, b, c);
    const transformed = portLabelOffsets(transform(a), transform(b), transform(c));
    expect(transformed.source).toBeCloseTo(original.source * 2, 6);
    expect(transformed.target).toBeCloseTo(original.target * 2, 6);
    expect(portLabelOffsets(a, a)).toEqual({ source: 0, target: 0 });
  });
});
