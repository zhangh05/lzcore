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
 * (`:root` and `[data-theme="dark"]`). The values used to be a second palette
 * (Tailwind emerald/amber/red plus blue for selection), which is exactly the
 * "second brand colour" the design rules forbid.
 */
export const NODE_STATUS_COLORS: Record<NodeRuntimeStatus, string> = {
  ok: "#24733b",
  warning: "#925b08",
  error: "#bd3040",
  unknown: "#7e22ce",
};

export const NODE_STATUS_COLORS_DARK: Record<NodeRuntimeStatus, string> = {
  ok: "#85ce7d",
  warning: "#e2ad4d",
  error: "#ef7180",
  unknown: "#c084fc",
};

export function nodeStatusColors(dark: boolean): Record<NodeRuntimeStatus, string> {
  return dark ? NODE_STATUS_COLORS_DARK : NODE_STATUS_COLORS;
}

/** Transient canvas feedback: selection, drag-to-connect, alignment guides. */
export const CANVAS_ACCENT = { light: "#0f7773", dark: "#7cc9bc" };
/** Group containers are neutral structure; custom drawing colours remain intact. */
export const CANVAS_GROUP = {
  light: { fill: "#f7f9f9", border: "#dae0e3", text: "#535f65" },
  dark: { fill: "#13171a", border: "#343d44", text: "#abb5bd" },
};

/** Compatibility export: drawing colours do not use operational state. */
export { topologyLinkColor } from './topologyDrawingAppearance';
