import { useEffect } from "react";
import type { Cy } from "./canvasRendererTypes";
import { CANVAS_ACCENT, CANVAS_GROUP } from "./topologyPalette";

export type useCanvasThemePorts = {
  cyRef: import("react").MutableRefObject<Cy | null>;
  rendererReady: boolean;
  setTheme: import("react").Dispatch<import("react").SetStateAction<string>>;
  theme: string;
};

/**
 * Canvas label colours follow the app's semantic tokens. Cytoscape needs a
 * concrete colour, so the token is resolved through a probe element after the
 * data-theme attribute has changed (the theme state below is driven by that
 * attribute). The literal is only the fallback for a missing token.
 */
function resolveToken(token: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${token}, ${fallback})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value || fallback;
}

export function useCanvasTheme({
  cyRef,
  rendererReady,
  setTheme,
  theme,
}: useCanvasThemePorts) {
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.getAttribute("data-theme") || "light"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const dark = theme === "dark";
    const labelText = resolveToken(
      "--lz-color-text-primary",
      dark ? "#f1f5f9" : "#0f172a",
    );
    const labelSurface = resolveToken(
      "--lz-color-bg-surface",
      dark ? "#1e293b" : "#ffffff",
    );
    const labelBorder = resolveToken(
      "--lz-color-border-default",
      dark ? "#334155" : "#cbd5e1",
    );
    cy.style()
      .selector("node:selected")
      .style({
        "underlay-color": dark ? CANVAS_ACCENT.dark : CANVAS_ACCENT.light,
      })
      .update();
    cy.style()
      .selector(".node-connecting")
      .style({
        "border-color": dark ? CANVAS_ACCENT.dark : CANVAS_ACCENT.light,
      })
      .update();
    cy.style()
      .selector("node")
      .style({
        color: labelText,
        "text-background-opacity": 0,
        "text-border-width": 0,
      })
      .selector("node[vendorTint]")
      .style({ "background-color": dark ? "#1c242c" : "data(vendorTint)" })
      .selector("edge")
      .style({
        color: labelText,
        "text-background-shape": "roundrectangle",
        "text-background-color": labelSurface,
        "text-background-opacity": 0.95,
        "text-border-width": 1,
        "text-border-color": labelBorder,
        "text-border-opacity": 0.9,
        "text-background-padding": "2px 6px",
      })
      .selector(".canvas-item")
      .style({ "text-background-color": labelSurface })
      .selector(".lz-group")
      .style({
        "background-color": dark
          ? CANVAS_GROUP.dark.fill
          : CANVAS_GROUP.light.fill,
        "border-color": dark
          ? CANVAS_GROUP.dark.border
          : CANVAS_GROUP.light.border,
        color: dark ? CANVAS_GROUP.dark.text : CANVAS_GROUP.light.text,
      })
      .update();
    try {
      const r = (cy as any).renderer?.();
      if (r && r.data) {
        if (r.data.eleTxrCache) r.data.eleTxrCache.getElement = () => null;
        if (r.data.lyrTxrCache) r.data.lyrTxrCache.getLayers = () => null;
        if (r.data.lblTxrCache) r.data.lblTxrCache.getElement = () => null;
        if (r.data.slbTxrCache) r.data.slbTxrCache.getElement = () => null;
        if (r.data.tlbTxrCache) r.data.tlbTxrCache.getElement = () => null;
      }
    } catch {
      // Fallback safely
    }
  }, [rendererReady, theme]);
}
