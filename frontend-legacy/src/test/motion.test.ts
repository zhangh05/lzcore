import { afterEach, describe, expect, it, vi } from "vitest";
import { motionScrollBehavior, prefersReducedMotion, REDUCED_MOTION_QUERY } from "../utils/motion";

function stubMatchMedia(reduce: boolean) {
  const matchMedia = vi.fn((query: string) => ({ matches: reduce && query === REDUCED_MOTION_QUERY, media: query }));
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

afterEach(() => vi.unstubAllGlobals());

describe("reduced-motion contract", () => {
  it("reads the same media query the CSS and stream reveal use, at call time", () => {
    const mm = stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionScrollBehavior()).toBe("auto");
    expect(mm).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(motionScrollBehavior()).toBe("smooth");
  });

  it("defaults to full motion when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});
