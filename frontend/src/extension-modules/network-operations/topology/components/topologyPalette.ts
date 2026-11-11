/**
 * Operational state, as opposed to the hand-drawn `status` on a link.
 * A topology an operator cannot read at a glance is just a picture, so this
 * is what the node border encodes; vendor stays in the node background.
 */
export type NodeRuntimeStatus = "ok" | "warning" | "error" | "unknown";
/**
 * Cytoscape paints to a canvas and cannot resolve CSS custom properties, so the
 * product's semantic colours are mirrored here as literals. This is the only
 * place allowed to duplicate them — keep in sync with `styles/tokens.css`
 * and the Arc foundation it resolves through (`components/arc/foundation.css`);
 * the hex values are those oklch colours converted to sRGB. The values used to be a second palette
 * (Tailwind emerald/amber/red plus blue for selection), which is exactly the
 * "second brand colour" the design rules forbid.
 */
export const NODE_STATUS_COLORS: Record<NodeRuntimeStatus, string> = {
  ok: "#00774d",
  warning: "#9f6202",
  error: "#bb2c54",
  unknown: "#943fa2",
};

export const NODE_STATUS_COLORS_DARK: Record<NodeRuntimeStatus, string> = {
  ok: "#55d69f",
  warning: "#f2bd68",
  error: "#f0738f",
  unknown: "#dd8fe9",
};

export function nodeStatusColors(dark: boolean): Record<NodeRuntimeStatus, string> {
  return dark ? NODE_STATUS_COLORS_DARK : NODE_STATUS_COLORS;
}

/** Transient canvas feedback: selection, drag-to-connect, alignment guides. */
export const CANVAS_ACCENT = { light: "#0562ef", dark: "#6ba3ff" };
/** Group containers are neutral structure; custom drawing colours remain intact. */
export const CANVAS_GROUP = {
  light: { fill: "#f8f8f8", border: "#e9e9e9", text: "#585858" },
  dark: { fill: "#151515", border: "#2b2b2b", text: "#ababab" },
};

/** Compatibility export: drawing colours do not use operational state. */
export { topologyLinkColor } from './topologyDrawingAppearance';
