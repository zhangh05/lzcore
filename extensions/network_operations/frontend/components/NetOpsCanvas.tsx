import type { Topology, TopologyLink } from "./TopologyWorkspace";
import TopologyFlowCanvas from "./flow/TopologyFlowCanvas";

export type CanvasMode = "select" | "connect";
export type Position = { element_id: string; x: number; y: number };

/** Imperative handles the surrounding workspace needs (export, focus, view). */
export type CanvasApi = {
  exportPNG: (options?: { full?: boolean; scale?: number; background?: string }) => string;
  exportSVG: (options?: { full?: boolean }) => string;
  fit: () => void;
  resize: () => void;
  zoomBy: (delta: number) => void;
  focusIds: (ids: string[], zoom?: number) => void;
  selectAll: () => string[];
  clearSelection: () => void;
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (view: { x: number; y: number; zoom: number }) => void;
  startConnectFrom?: (nodeId: string) => void;
  getElementPosition?: (id: string, kind: "node" | "link" | "canvas_item") => { x: number; y: number } | null;
};

export type CanvasContextTarget = { x: number; y: number; kind: "node" | "link" | "canvas_item" | "canvas"; id: string };

/**
 * Operational state, as opposed to the hand-drawn `status` on a link.
 */
export type NodeRuntimeStatus = "ok" | "warning" | "error" | "unknown";

export const NODE_STATUS_COLORS: Record<NodeRuntimeStatus, string> = {
  ok: "#147a55",
  warning: "#a16207",
  error: "#bd3040",
  unknown: "#6c7c7e",
};

export const NODE_STATUS_COLORS_DARK: Record<NodeRuntimeStatus, string> = {
  ok: "#77ca9c",
  warning: "#e2ad4d",
  error: "#ef7180",
  unknown: "#95a3b3",
};

export function nodeStatusColors(dark: boolean): Record<NodeRuntimeStatus, string> {
  return dark ? NODE_STATUS_COLORS_DARK : NODE_STATUS_COLORS;
}

/** Transient canvas feedback: selection, drag-to-connect, alignment guides. */
export const CANVAS_ACCENT = { light: "#0f7773", dark: "#72c3ba" };

/** Group containers are structure, not signal: accent-soft fill, hairline border. */
export const CANVAS_GROUP = {
  light: { fill: "#f8fafc", border: "#cbd5e1", text: "#475569" },
  dark: { fill: "#17202a", border: "#263442", text: "#95a3b3" },
};

/**
 * Shrink vendor-bloated interface names down to the dense tokens operators
 * actually scan for (GE0/0/1, Eth1/2, Lo0).
 */
export function compactInterfaceLabel(value: string): string {
  return String(value || "")
    .trim()
    .replace(/hundred\s*-?\s*gig(?:abit)?ethernet/gi, "100GE")
    .replace(/forty\s*-?\s*gig(?:abit)?ethernet/gi, "40GE")
    .replace(/twenty\s*-?\s*five\s*-?\s*gig(?:abit)?ethernet/gi, "25GE")
    .replace(/(?:ten|10)\s*-?\s*gig(?:abit)?ethernet/gi, "XGE")
    .replace(/gigabit\s*ethernet/gi, "GE")
    .replace(/bridge\s*-?\s*aggregation/gi, "BAGG")
    .replace(/port\s*-?\s*channel/gi, "Po")
    .replace(/vlan\s*-?\s*interface/gi, "Vlanif")
    .replace(/loopback/gi, "Lo")
    .replace(/ethernet/gi, "Eth")
    .replace(/\s+/g, "");
}

/** A link description is diagram text only when its owner explicitly opts in. */
export function canvasLinkDescription(link: Pick<TopologyLink, "label" | "metadata">): string {
  return link.metadata?.show_description ? String(link.label || "") : "";
}

export type NetOpsCanvasProps = {
  topology: Topology;
  mode: CanvasMode;
  interactionMode?: "view" | "edit";
  gridEnabled: boolean;
  showInterfaces: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectCanvasItem: (itemId: string) => void;
  onSelectLink: (linkId: string) => void;
  onClearSelection: () => void;
  onSelectionChange: (elementIds: string[]) => void;
  onMoveElements: (positions: Position[]) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  armedNodeType?: string | null;
  onPlaceNodeType: (deviceType: string, position: { x: number; y: number }) => void;
  onDisarmNodeType: () => void;
  onReady?: (api: CanvasApi | null) => void;
  onContextMenu?: (target: CanvasContextTarget) => void;
  onOpenInspector?: () => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  dimmedNodeIds?: string[];
};

export default function NetOpsCanvas(props: NetOpsCanvasProps) {
  return <TopologyFlowCanvas {...props} />;
}
