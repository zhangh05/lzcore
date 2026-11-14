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
 * and the Fluent 2 palette it resolves through (`styles/arc-overrides.css`). The values used to be a second palette
 * (Tailwind emerald/amber/red plus blue for selection), which is exactly the
 * "second brand colour" the design rules forbid.
 */
export const NODE_STATUS_COLORS: Record<NodeRuntimeStatus, string> = {
  ok: "#0e700e",
  warning: "#bc4b09",
  error: "#b10e1c",
  unknown: "#7a49b3",
};

export const NODE_STATUS_COLORS_DARK: Record<NodeRuntimeStatus, string> = {
  ok: "#54b054",
  warning: "#faa06b",
  error: "#dc626d",
  unknown: "#b696e4",
};

export function nodeStatusColors(dark: boolean): Record<NodeRuntimeStatus, string> {
  return dark ? NODE_STATUS_COLORS_DARK : NODE_STATUS_COLORS;
}

/** Transient canvas feedback: selection, drag-to-connect, alignment guides. */
export const CANVAS_ACCENT = { light: "#0f6cbd", dark: "#479ef5" };
/** Group containers are neutral structure; custom drawing colours remain intact. */
export const CANVAS_GROUP = {
  light: { fill: "#f5f5f5", border: "#e0e0e0", text: "#616161" },
  dark: { fill: "#2e2e2e", border: "#3d3d3d", text: "#adadad" },
};

/** Compatibility export: drawing colours do not use operational state. */
export { topologyLinkColor } from './topologyDrawingAppearance';
