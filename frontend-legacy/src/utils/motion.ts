/**
 * The app's reduced-motion contract: the `(prefers-reduced-motion: reduce)`
 * media query that the CSS (transitions/animations) and the streaming text
 * reveal (realtime/turnTransport) already honour. Read at the moment of the
 * action so an OS-level change applies without a reload. JS-driven motion
 * (smooth scrolling, reveal pacing) must go through here, because the global
 * CSS rule cannot reach it.
 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false);
}

/** "smooth" normally, "auto" (instant) when the user asked for reduced motion. */
export function motionScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
