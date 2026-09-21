// React 的合成事件类型与 DOM 原生事件同名，这里显式区分：画布上的原生
// window 监听必须拿到 DOM MouseEvent（带 clientX/clientY 且可用于
// addEventListener），React 回调才用合成事件类型。
import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Topology, TopologyCanvasItem, TopologyLink } from "./TopologyWorkspace";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import { portLabelOffsets } from "./topologyPortLabels";

/** Selecting information must never mutate the drawing by accident. */
type CanvasMode = "select" | "connect";
type Position = { element_id: string; x: number; y: number };

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
 * A topology an operator cannot read at a glance is just a picture, so this
 * is what the node border encodes; vendor stays in the node background.
 */
export type NodeRuntimeStatus = "ok" | "warning" | "error" | "unknown";
/**
 * Cytoscape paints to a canvas and cannot resolve CSS custom properties, so the
 * product's semantic colours are mirrored here as literals. This is the only
 * place allowed to duplicate them — keep in sync with `styles/global.css`
 * (`:root` and `[data-theme="dark"]`). The values used to be a second palette
 * (Tailwind emerald/amber/red plus blue for selection), which is exactly the
 * "second brand colour" the design rules forbid.
 */
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


type Props = {
  topology: Topology;
  mode: CanvasMode;
  gridEnabled: boolean;
  showInterfaces: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectCanvasItem: (itemId: string) => void;
  onSelectLink: (linkId: string) => void;
  onClearSelection: () => void;
  onSelectionChange: (elementIds: string[]) => void;
  onMoveElements: (positions: Position[]) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  /**
   * A drawing-device type picked in the palette and not yet placed. While it is
   * set the canvas is waiting for a click on empty sheet, the way eNSP and HCL
   * behave after you choose a model.
   */
  armedNodeType?: string | null;
  onPlaceNodeType: (deviceType: string, position: { x: number; y: number }) => void;
  /** Called when the user gives up on placing (Esc, or a click on a device). */
  onDisarmNodeType: () => void;
  /** Handed to the workspace once the renderer exists, null when it is gone. */
  onReady?: (api: CanvasApi | null) => void;
  onContextMenu?: (target: CanvasContextTarget) => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  /** node_id -> operational state, derived from the last collection pass. */
  /**
   * node_ids the active filter excludes. They stay on the canvas at low
   * opacity rather than disappearing: a filtered diagram still has to answer
   * "what am I not looking at".
   */
  dimmedNodeIds?: string[];
};

type CyCollection<T> = {
  map: <R>(callback: (element: T) => R) => R[];
  filter: (callback: (element: T) => boolean) => CyCollection<T>;
  forEach: (callback: (element: T) => void) => void;
  some: (callback: (element: T) => boolean) => boolean;
  remove: () => void;
  unselect: () => void;
  select: () => void;
  length: number;
};

type Cy = {
  add: (elements: unknown[]) => void;
  batch: (work: () => void) => void;
  center: (elements?: unknown) => void;
  destroy: () => void;
  elements: () => CyCollection<CyElement>;
  fit: (elements?: unknown, padding?: number) => void;
  getElementById: (id: string) => CyElement;
  nodes: (selector?: string) => CyCollection<CyNode>;
  edges: () => CyCollection<CyEdge>;
  on: (events: string, selectorOrCallback: string | ((event: CyEvent) => void), callback?: (event: CyEvent) => void) => void;
  pan: (position?: { x: number; y: number }) => { x: number; y: number };
  panningEnabled: (enabled?: boolean) => boolean;
  boxSelectionEnabled: (enabled?: boolean) => boolean;
  selectionType: (type?: "single" | "additive") => string;
  userPanningEnabled: (enabled?: boolean) => boolean;
  autoungrabify: (enabled?: boolean) => boolean;
  resize: () => void;
  zoom: (level?: number | { level: number; renderedPosition?: { x: number; y: number } }) => number;
  $: (selector: string) => CyCollection<CyNode>;
  style: () => {
    selector: (selector: string) => { style: (style: Record<string, unknown>) => CyStyleChain };
  };
  animate: (animation: Record<string, unknown>, options?: Record<string, unknown>) => void;
  /** Base64 data URI. Used by the export action. */
  png: (options?: Record<string, unknown>) => string;
  svg: (options?: Record<string, unknown>) => string;
  extent: () => { x1: number; y1: number; x2: number; y2: number };
  container?: () => HTMLElement;
  renderer?: () => { findNearestElements?: (x: number, y: number, visibleOnly?: boolean, isTouch?: boolean) => CyElement[] };
};

type CyElement = {
  id: () => string;
  data: (name: string, value?: unknown) => unknown;
  addClass: (className: string) => void;
  removeClass: (className: string) => void;
  classes: (value?: string) => string;
  select: () => void;
  grabify: () => void;
  ungrabify: () => void;
  remove: () => void;
  isNode: () => boolean;
  isEdge?: () => boolean;
  group: () => string;
  length: number;
  renderedPosition?: () => { x: number; y: number };
  source?: () => CyElement;
  target?: () => CyElement;
};
type CyNode = CyElement & { position: (position?: { x: number; y: number }) => { x: number; y: number }; selected: () => boolean; grabbed: () => boolean; width: () => number; height: () => number };
type CyEdge = CyElement & {
  sourceEndpoint: () => { x: number; y: number };
  targetEndpoint: () => { x: number; y: number };
  controlPoints: () => { x: number; y: number }[] | undefined;
  style: (values: Record<string, number>) => void;
  renderedMidpoint?: () => { x: number; y: number };
  midpoint?: () => { x: number; y: number };
};
type CyStyleChain = { selector: (selector: string) => { style: (style: Record<string, unknown>) => CyStyleChain }; update: () => void };
type CyEvent = { target: { id?: () => string; isNode?: () => boolean; isEdge?: () => boolean; addClass?: (className: string) => void; removeClass?: (className: string) => void; select?: () => void }; originalEvent?: MouseEvent; position?: { x: number; y: number }; renderedPosition?: { x: number; y: number } };

declare global {
  interface Window {
    cytoscape?: (options: Record<string, unknown>) => Cy;
    __lzcoreNetOpsCytoscapeLoad?: Promise<void>;
  }
}

/**
 * The ratio between the container's visual pixels and its own layout pixels.
 *
 * The sheet sits under a `zoom` on <body> (the app's `--ui-scale`, 0.95), so
 * the two spaces are not the same size: `getBoundingClientRect()` reports
 * **visual** pixels, while everything Cytoscape reports — `pan()`, `zoom()`,
 * `renderedPosition()`, `width()` — is in the container's **layout** pixels.
 *
 * Subtracting one from the other without this ratio is off by a factor that
 * grows with distance from the container's origin: measured 0.9497 here, which
 * is ~38px at the bottom of the sheet and ~60px for a device sitting low once
 * its own half-height is taken into account. That is more than a device is
 * tall, so a press squarely on a device was being read as a press on empty
 * canvas and the marquee took the gesture instead of the device.
 *
 * Cytoscape's own hit test is not affected — it works in its own space
 * throughout — which is why plain clicking a device always worked and only the
 * hand-rolled conversions here were wrong.
 */
function hostScale(host: HTMLElement): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  return {
    x: host.clientWidth ? rect.width / host.clientWidth : 1,
    y: host.clientHeight ? rect.height / host.clientHeight : 1,
  };
}

/** A pointer position in the container's own layout pixels. */
function toHostPoint(host: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  const scale = hostScale(host);
  return { x: (clientX - rect.left) / scale.x, y: (clientY - rect.top) / scale.y };
}

/**
 * Is there a device or drawing item under this press?
 *
 * The marquee has to be able to tell "the user pressed on empty canvas" from
 * "the user pressed on a device", because the two want opposite things. Node
 * position is the centre of the body in model units, so the rendered body is
 * `size * zoom` around the rendered centre; the pointer is converted the same
 * way. A few screen pixels of slack are added so that pressing on the border of
 * a device counts as pressing on the device.
 *
 * Labels are deliberately excluded. A device's caption sits below its icon, and
 * counting it would make the visibly empty strip just under a device
 * un-marqueeable — which is exactly where a box tends to be started.
 */
function nodeUnderPointer(cy: Cy, host: HTMLElement, event: MouseEvent): boolean {
  const point = toHostPoint(host, event.clientX, event.clientY);
  const pan = cy.pan();
  const zoom = cy.zoom();
  return cy.$("node").some((node) => {
    if (node.id().startsWith("group-")) return false;
    const position = node.position();
    const cx = pan.x + position.x * zoom;
    const cyY = pan.y + position.y * zoom;
    const halfWidth = (node.width() * zoom) / 2 + 4;
    const halfHeight = (node.height() * zoom) / 2 + 4;
    return Math.abs(point.x - cx) <= halfWidth && Math.abs(point.y - cyY) <= halfHeight;
  });
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function edgeUnderPointer(cy: Cy, host: HTMLElement, event: MouseEvent): CyElement | null {
  const point = toHostPoint(host, event.clientX, event.clientY);
  const pan = cy.pan();
  const zoom = cy.zoom();
  const modelX = (point.x - pan.x) / zoom;
  const modelY = (point.y - pan.y) / zoom;
  const renderer = cy.renderer?.();
  if (renderer?.findNearestElements) {
    const nearest = renderer.findNearestElements(modelX, modelY, false, true);
    const edge = nearest?.find((ele: CyElement) => ele.isEdge?.());
    if (edge) return edge;
  }
  // Fallback geometric distance check (e.g. in unit tests or headless)
  const maxDist = 20 / zoom;
  let foundEdge: CyElement | null = null;
  if (cy.edges) {
    cy.edges().forEach((edge) => {
      if (foundEdge) return;
      const s = edge.source ? edge.source() : null;
      const t = edge.target ? edge.target() : null;
      const sPos = s && "position" in s ? (s as CyNode).position() : null;
      const tPos = t && "position" in t ? (t as CyNode).position() : null;
      if (sPos && tPos) {
        const dist = pointToSegmentDistance(modelX, modelY, sPos.x, sPos.y, tPos.x, tPos.y);
        if (dist <= maxDist) foundEdge = edge;
      }
    });
  }
  return foundEdge;
}

function elementUnderPointer(cy: Cy, host: HTMLElement, event: MouseEvent): boolean {
  return nodeUnderPointer(cy, host, event) || Boolean(edgeUnderPointer(cy, host, event));
}

function loadNetOpsCytoscape(): Promise<void> {
  // The test DOM intentionally blocks external script execution. The semantic
  // controls remain renderable there; the actual Cytoscape runtime is covered
  // by the browser acceptance check.
  if (import.meta.env.MODE === "test") return Promise.resolve();
  if (window.cytoscape) return Promise.resolve();
  if (window.__lzcoreNetOpsCytoscapeLoad) return window.__lzcoreNetOpsCytoscapeLoad;
  window.__lzcoreNetOpsCytoscapeLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/netops-canvas/cytoscape.min.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("netops_canvas_library_load_failed"));
    document.head.appendChild(script);
  });
  return window.__lzcoreNetOpsCytoscapeLoad;
}

/** Keep common vendor interface names compact without throwing away the port. */
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

const canvasItemDefaults: Record<TopologyCanvasItem["kind"], Required<TopologyCanvasItem>["style"]> = {
  rectangle: { fill: "#dff5f0", border: "#58a99b", color: "#0f5149" },
  ellipse: { fill: "#e8f0fe", border: "#6b9be6", color: "#1d4f91" },
  text: { fill: "#ffffff", border: "#ffffff", color: "#334155" },
};

type CanvasElementSpec = { group?: string; classes?: string; data: Record<string, unknown>; position?: { x: number; y: number } };
type AlignGuide = { x1: number; y1: number; x2: number; y2: number };

const SKIPPED_DATA_KEYS = new Set(["id", "source", "target"]);

/**
 * Reconcile the drawing instead of rebuilding it.
 *
 * Tearing the graph down on every edit (including the end of every drag)
 * discarded Cytoscape's selection, animation and layout caches, and made a
 * 200 node diagram stutter for a one pixel move. Element ids are stable and
 * already persisted, so a straight diff is both cheap and correct.
 */
function applyElements(cy: Cy, elements: CanvasElementSpec[], connectingId: string | null, syncPositions: boolean): void {
  const desired = new Map(elements.map((element) => [String(element.data.id), element]));
  const stale: CyElement[] = [];
  const fresh: CanvasElementSpec[] = [];
  cy.batch(() => {
    cy.elements().forEach((existing) => {
      const next = desired.get(existing.id());
      if (!next) {
        stale.push(existing);
        return;
      }
      for (const key of Object.keys(next.data)) {
        if (SKIPPED_DATA_KEYS.has(key) || key.startsWith("_")) continue;
        if (existing.data(key) !== next.data[key]) existing.data(key, next.data[key]);
      }
      const classes = next.classes || "";
      // Preserve the transient connecting marker across reconciliation.
      const effective = existing.id() === connectingId ? `${classes} node-connecting`.trim() : classes;
      if (existing.data("_cls") !== effective) {
        existing.data("_cls", effective);
        existing.classes(effective);
      }
      // Never reposition a node the user is holding. A save round-trip replaces
      // the whole topology — the debounced PUT's reply, and then the list reload
      // that follows it — and neither knows a drag is in progress. Forcing the
      // position back mid-gesture springs the node to wherever the last save put
      // it, and the drag the user is in the middle of is then thrown away. The
      // pointer owns the node until it lets go.
      const dragActive = cy.$("node:grabbed").length > 0;
      if (syncPositions && existing.isNode() && next.position && !(existing as CyNode).grabbed() && !(dragActive && (existing as CyNode).selected())) {
        const current = (existing as CyNode).position();
        if (Math.abs(current.x - next.position.x) > 0.5 || Math.abs(current.y - next.position.y) > 0.5) {
          (existing as CyNode).position(next.position);
        }
      }
    });
    stale.forEach((element) => element.remove());
    elements.forEach((element) => {
      if (!cy.getElementById(String(element.data.id)).length) fresh.push(element);
    });
    if (fresh.length) cy.add(fresh);
  });
}

export default function NetOpsCanvas(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Cy | null>(null);
  const propsRef = useRef(props);
  const connectingFromRef = useRef<string | null>(null);
  const ignoreBoxSelectionTapRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * The selection as it was *before* the click that is currently being handled.
   *
   * Ctrl/⌘ + click has to be able to *remove* an object from the selection, and
   * that needs the pre-click set. It cannot be read off `cy` inside the tap
   * handler, because Cytoscape has already applied its own selection change by
   * the time `tap` fires — the same set would be read back and nothing would
   * ever toggle off. Captured on `mousedown` in the capture phase, which is the
   * only point that is reliably earlier.
   */
  const clickIntentRef = useRef<{ ids: string[]; additive: boolean }>({ ids: [], additive: false });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const initialTopologyIdRef = useRef<string | null>(null);
  // Theme, filtering and probe updates are presentation-only. Only a new
  // diagram snapshot may reconcile the renderer's in-progress positions.
  const reconciledTopologyRef = useRef<Topology | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [marqueeDrag, setMarqueeDrag] = useState(false);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const [miniOpen, setMiniOpen] = useState(false);
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  const guideSignatureRef = useRef("");
  // How far the last alignment snap moved the node away from where the pointer
  // had put it. Cytoscape drags a node incrementally — new position = current
  // position + pointer delta — so a snap silently swallows that much of the
  // pointer's travel. Left uncorrected, a step smaller than the snap window is
  // cancelled every frame and the node sticks to the guide line instead of
  // following the pointer. Carrying the offset lets the next frame subtract it
  // and recover the position the pointer actually asked for.
  const snapResidualRef = useRef({ x: 0, y: 0 });
  const [linkPreview, setLinkPreview] = useState<AlignGuide | null>(null);
  const connectStartRef = useRef<string | null>(null);
  const [theme, setTheme] = useState(() => (typeof document === "undefined" ? "light" : document.documentElement.getAttribute("data-theme") || "light"));
  propsRef.current = props;

  useEffect(() => {
    let disposed = false;
    void loadNetOpsCytoscape().then(() => {
      if (disposed || !hostRef.current || !window.cytoscape) return;
      const cy = window.cytoscape({
        container: hostRef.current,
        layout: { name: "preset" },
        // The sheet itself is fixed. Editing changes object coordinates only.
        panningEnabled: true,
        // Cytoscape 3.28 gates wheel zoom behind userPanningEnabled as well
        // (see the wheel handler in cytoscape.min.js). Keeping panning on for
        // every mode is what makes the wheel work outside layout mode.
        userPanningEnabled: true,
        // Default 1 means one mouse notch (deltaY 100) zooms 10^(100/250)
        // = 2.5x. 0.25 puts a notch near 1.26x, which is the familiar feel.
        wheelSensitivity: 0.25,
        minZoom: 0.15,
        maxZoom: 4,
        boxSelectionEnabled: false,
        pixelRatio: typeof window !== "undefined" ? Math.max(window.devicePixelRatio || 1, 3) : 1,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "text-valign": "bottom",
              "text-halign": "center",
              "text-margin-y": "8px",
              "font-family": 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
              "font-size": 12,
              "font-weight": 650,
              color: "#0f172a",
              "text-wrap": "ellipsis",
              "text-max-width": 132,
              "text-background-opacity": 0,
              "text-border-width": 0,
              width: 94,
              height: 76,
              shape: "roundrectangle",
              "border-width": "data(statusWidth)",
              "border-color": "data(statusColor)",
              "text-opacity": "data(labelOpacity)",
              "z-index": 10,
            },
          },
          // Drawing items deliberately have no vendor field. Keeping this data
          // mapping on asset nodes prevents Cytoscape from warning on every
          // canvas refresh when it encounters a text box or an ellipse.
          { selector: "node[vendorTint]", style: { "background-color": "data(vendorTint)" } },
          // Canvas items and groups deliberately have no device icon. Apply
          // image mappings only to asset nodes so Cytoscape stays warning-free.
          { selector: "node[icon]", style: { "background-image": "data(icon)", "background-fit": "cover", "background-clip": "node", "background-position-x": "50%", "background-position-y": "50%" } },
          { selector: "node:active", style: { "overlay-opacity": 0, "underlay-opacity": 0 } },
          {
            selector: "edge",
            style: {
              width: "data(edgeWidth)",
              opacity: "data(visible)",
              "line-color": "data(edgeColor)",
              "line-style": "data(edgeStyle)",
              "line-cap": "round",
              "line-opacity": 1,
              "curve-style": "bezier",
              "control-point-step-size": 144,
              label: "data(label)",
              "font-family": 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
              "font-size": 11,
              "font-weight": 600,
              "min-zoomed-font-size": 0,
              color: "#0f172a",
              "text-background-color": "#ffffff",
              "text-background-opacity": 0.85,
              "text-background-padding": "1px 3px",
              "text-border-width": 0,
              "text-margin-y": "-14px",
              "source-label": "data(srcPort)",
              "target-label": "data(tgtPort)",
              "source-text-offset": 42,
              "target-text-offset": 42,
              "source-text-margin-y": 0,
              "target-text-margin-y": 0,
            },
          },
          { selector: "edge[curveStyle = 'straight']", style: { "curve-style": "straight" } },
          { selector: "edge[curveStyle = 'taxi']", style: { "curve-style": "taxi", "taxi-direction": "auto", "taxi-turn": 20 } },
          { selector: "edge[curveStyle = 'bezier']", style: { "curve-style": "unbundled-bezier", "control-point-distances": 40, "control-point-weights": 0.5 } },
          { selector: "edge[curveStyle = 'unbundled-bezier']", style: { "curve-style": "unbundled-bezier", "control-point-distances": 40, "control-point-weights": 0.5 } },
          {
            selector: ".canvas-item",
            style: {
              label: "data(label)",
              shape: "data(shape)",
              width: "data(width)",
              height: "data(height)",
              "background-color": "data(fill)",
              "background-opacity": "data(fillOpacity)",
              "border-color": "data(border)",
              "border-width": "data(borderWidth)",
              color: "data(textColor)",
              "font-family": 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
              "font-size": "data(fontSize)",
              "font-weight": 600,
              "text-wrap": "wrap",
              "text-max-width": "data(textMaxWidth)",
              "text-margin-y": 0,
              "text-valign": "center",
              "text-halign": "center",
              "text-opacity": "data(labelOpacity)",
              "z-index": 2,
            },
          },
          // A text box with no border and no fill is an invisible hit area: the
          // user sees blank canvas, right-clicks it, and gets item actions they
          // cannot explain — or aims at the glyphs and misses the box. A faint
          // dashed outline makes the box look like a text box and makes its
          // bounds honest, without the weight of a filled plate.
          //
          // `text-halign` names the side of the node the label hangs off, not the
          // alignment of the text within it. `left` therefore put the whole label
          // outside the box, flush against its left edge — a dashed rectangle with
          // its caption floating beside it. A canvas item *is* its own bound, so
          // the label belongs inside; `text-justification` is the property that
          // left-aligns a wrapped multi-line note within its block.
          {
            selector: ".canvas-item-text",
            style: {
              "background-opacity": 0,
              "border-width": 1,
              "border-style": "dashed",
              "border-opacity": 0.45,
              "text-valign": "center",
              "text-halign": "center",
              "text-justification": "left",
              "font-family": 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
              "font-size": 14,
              "font-weight": 500,
              "text-max-width": "data(textMaxWidth)",
            },
          },
          // Selection adds a halo instead of repainting the border: the border
          // carries operational state, and a selected node must still show
          // whether it is reachable.
          { selector: "node:selected", style: { "border-width": 3, "underlay-color": CANVAS_ACCENT.light, "underlay-opacity": 0.16, "underlay-padding": 7 } },
          { selector: ".node-connecting", style: { "border-width": 3, "border-color": CANVAS_ACCENT.light } },
          // Filtered-out elements stay visible but recede, so the filtered view
          // keeps its context instead of looking like a different diagram.
          // One opacity value only — stacking a second one on the item fill
          // would make a filtered rectangle indistinguishable from empty space.
          { selector: ".filtered-out", style: { opacity: 0.16, "text-opacity": 0.16 } },
          // Selection is a wider stroke plus the accent colour, not a glow: the
          // link stays the same object, it just comes forward.
          { selector: "edge:selected", style: { width: "data(selectedEdgeWidth)", "line-color": CANVAS_ACCENT.light, "z-index": 20 } },
          {
            selector: ".lz-group",
            style: {
              shape: "roundrectangle",
              label: "data(label)",
              "text-valign": "top",
              "text-halign": "left",
              "text-margin-x": 12,
              "text-margin-y": 10,
              color: CANVAS_GROUP.light.text,
              "font-family": 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
              "font-size": 12,
              "font-weight": 650,
              width: "data(width)",
              height: "data(height)",
              "background-color": CANVAS_GROUP.light.fill,
              "background-opacity": 0.5,
              "border-color": CANVAS_GROUP.light.border,
              "border-style": "dashed",
              "border-width": 1,
              "background-image": "none",
              events: "no",
            },
          },
        ],
      });
      cyRef.current = cy;
      // Prevent low-resolution texture caching for text and interface labels:
      // Cytoscape by default rasterizes labels into fixed power-of-two offscreen
      // textures and scales them up with drawImage(), causing blurry text on zoom.
      // Returning null from getElement forces Cytoscape to render vector font glyphs
      // directly via canvas 2D fillText() at the native screen pixel density.
      try {
        const r = (cy as any).renderer?.();
        if (r && r.data) {
          if (r.data.lblTxrCache) r.data.lblTxrCache.getElement = () => null;
          if (r.data.slbTxrCache) r.data.slbTxrCache.getElement = () => null;
          if (r.data.tlbTxrCache) r.data.tlbTxrCache.getElement = () => null;
        }
      } catch {
        // Fallback safely if renderer internals vary
      }
      // Use renderer geometry, including the clipped node boundary and the
      // direction of each edge. A reverse-direction link still labels its own
      // source/target. Native labels remain available to image export/hit tests.
      // Render runs after bundle recalculation (add/remove/drag/layout); cache
      // geometry so pan, zoom and the follow-up style render do no extra work.
      const portGeometry = new Map<CyEdge, string>();
      cy.on("render", () => {
        const live = new Set<CyEdge>();
        cy.edges().forEach((edge) => {
          live.add(edge);
          const start = edge.sourceEndpoint();
          const end = edge.targetEndpoint();
          const controls = edge.controlPoints();
          // Self-loops have two quadratics, not the single parallel-link arc.
          if (!start || !end || (controls && controls.length > 1)) return;
          const coordinates = [start.x, start.y, end.x, end.y, ...(controls || []).flatMap(p => [p.x, p.y])];
          if (!coordinates.every(Number.isFinite)) return;
          const key = coordinates.join(",");
          if (portGeometry.get(edge) === key) return;
          portGeometry.set(edge, key);
          const offsets = portLabelOffsets(start, end, controls?.[0]);
          edge.style({ "source-text-offset": offsets.source, "target-text-offset": offsets.target });
        });
        for (const edge of portGeometry.keys()) if (!live.has(edge)) portGeometry.delete(edge);
      });
      setRendererReady(true);
      const syncViewport = () => setViewport({ ...cy.pan(), zoom: cy.zoom() });
      cy.on("zoom pan", syncViewport);
      /**
       * What a click on `id` should leave selected.
       *
       * Ctrl/⌘ (and Shift) turn the click into a toggle: the object joins the
       * selection, or drops out of it if it was already in. Without a modifier
       * it stays a plain single selection, which is what `selectionType`
       * `"additive"` would otherwise override — and that has to stay on, because
       * it is what keeps everything a marquee encloses.
       *
       * The pre-click set comes from `clickIntentRef`; see its declaration for
       * why it cannot be read from `cy` here.
       */
      const nextSelectionFor = (id: string): string[] => {
        const { ids, additive } = clickIntentRef.current;
        if (!additive) return [id];
        return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
      };
      const applySelection = (ids: string[]) => {
        cy.elements().unselect();
        ids.forEach((entry) => cy.getElementById(entry).select());
        propsRef.current.onSelectionChange(ids);
      };
      cy.on("tap", (event) => {
        const current = propsRef.current;
        if (event.target.isNode?.()) {
          const id = event.target.id?.() || "";
          if (!id) return;
          if (id.startsWith("group-")) return;
          // Clicking an object is a decision about that object, not a
          // placement; it ends the palette's wait rather than dropping a
          // device on top of what was just clicked.
          current.onDisarmNodeType();
          if (id.startsWith("canvas-")) {
            if (current.mode !== "connect") {
              const next = nextSelectionFor(id);
              window.setTimeout(() => applySelection(next), 0);
              // A multi-selection is not about any one object, so it must not
              // pull the inspector onto whichever one happened to be clicked.
              if (!clickIntentRef.current.additive) current.onSelectCanvasItem(id.slice("canvas-".length));
            }
            return;
          }
          if (current.mode === "connect") {
            const source = connectingFromRef.current;
            if (!source) {
              connectingFromRef.current = id;
              event.target.addClass?.("node-connecting");
              return;
            }
            cy.getElementById(source).removeClass("node-connecting");
            connectingFromRef.current = null;
            if (source !== id) current.onConnect(source, id);
            return;
          }
          // Cytoscape must use additive selection for a marquee to retain all
          // enclosed objects.  Restore familiar single-click semantics here —
          // and let Ctrl/⌘/Shift grow or shrink the selection instead.
          const next = nextSelectionFor(id);
          const additive = clickIntentRef.current.additive;
          window.setTimeout(() => applySelection(next), 0);
          // Keep the single-object inspector honest when a toggle happens to
          // leave exactly one object selected. Above that the multi-selection
          // panel takes over and does not care what was clicked last.
          if (!additive) current.onSelectNode(id);
          else if (next.length === 1) current.onSelectNode(next[0]);
          else if (next.length === 0) current.onClearSelection();
          return;
        }
        if (event.target.isEdge?.()) {
          const id = event.target.id?.();
          if (id) {
            cy.elements().unselect();
            cy.getElementById(id).select();
            current.onSelectLink(id);
          }
          current.onDisarmNodeType();
          return;
        }
        // Fallback: If tap event was treated as canvas background but clicked on or near a link
        const host = hostRef.current;
        const native = event.originalEvent;
        if (host && native && native instanceof MouseEvent) {
          const nearEdge = edgeUnderPointer(cy, host, native);
          if (nearEdge) {
            const id = nearEdge.id?.();
            if (id) {
              cy.elements().unselect();
              cy.getElementById(id).select();
              current.onSelectLink(id);
              current.onDisarmNodeType();
              return;
            }
          }
        }
        connectingFromRef.current = null;
        // The release of our own marquee is not an intent to clear selection.
        if (ignoreBoxSelectionTapRef.current) return;
        // A picked palette type turns the next empty-sheet click into a
        // placement, the way eNSP and HCL behave after you choose a model.
        // Cytoscape reports the tap's own model position, which is what the
        // node should land on; the client-coordinate fallback exists only
        // because the field is not guaranteed on every event flavour.
        if (current.armedNodeType) {
          const point = event.position || (() => {
            const nativeEvent = event.originalEvent;
            if (!nativeEvent || !host) return null;
            const local = toHostPoint(host, nativeEvent.clientX, nativeEvent.clientY);
            const pan = cy.pan();
            const zoom = cy.zoom();
            return { x: (local.x - pan.x) / zoom, y: (local.y - pan.y) / zoom };
          })();
          if (point) current.onPlaceNodeType(current.armedNodeType, point);
          return;
        }
        cy.elements().unselect();
        current.onClearSelection();
      });
      cy.on("mouseover", "node, edge", () => {
        if (propsRef.current.mode === "select") {
          const container = cy.container?.();
          if (container) container.style.cursor = "pointer";
        }
      });
      cy.on("mouseout", "node, edge", () => {
        if (propsRef.current.mode === "select") {
          const container = cy.container?.();
          if (container) container.style.cursor = "default";
        }
      });
      cy.on("select unselect", "node", () => {
        propsRef.current.onSelectionChange(cy.$("node:selected").map((node) => node.id()).filter((id) => !id.startsWith("group-")));
      });
      cy.on("cxttap", (event) => {
        if (propsRef.current.armedNodeType) {
          propsRef.current.onDisarmNodeType();
          return;
        }
        if (connectingFromRef.current) {
          cy.getElementById(connectingFromRef.current).removeClass("node-connecting");
          connectingFromRef.current = null;
          return;
        }
        // Cytoscape swallows the native menu only partially; the host element
        // prevents it, and this turns the gesture into workspace actions.
        const native = event.originalEvent;
        if (!native) return;
        const id = event.target?.id?.() || "";
        let kind: CanvasContextTarget["kind"] = "canvas";
        if (event.target?.isEdge?.()) kind = "link";
        else if (event.target?.isNode?.()) kind = id.startsWith("canvas-") ? "canvas_item" : "node";
        propsRef.current.onContextMenu?.({ x: native.clientX, y: native.clientY, kind, id });
      });
      // Smart guides. Aligning by eye is the slowest part of tidying a
      // diagram, so a dragged node snaps to the edges and centres of its
      // neighbours and shows why.
      const NODE_HALF_W = 47;
      const NODE_HALF_H = 38;
      const SNAP = 5;
      cy.on("drag", "node", (event) => {
        const node = event.target as CyNode | undefined;
        // Dragging an object moves it in every mode. The mode decides what a
        // *click* does, not whether the canvas is editable — a drag that snaps
        // back on release is worse than no drag at all.
        if (!node || node.id().startsWith("group-")) return;
        const selectedIds = new Set(cy.$("node:selected").map((item) => item.id()));
        const halfW = Math.max(8, ((node as CyNode).width?.() || 94) / 2);
        const halfH = Math.max(8, ((node as CyNode).height?.() || 76) / 2);
        const others = [
          ...propsRef.current.topology.nodes.filter((item) => item.node_id !== node.id() && !selectedIds.has(item.node_id)).map((item) => ({ x: item.x, y: item.y, halfW: NODE_HALF_W, halfH: NODE_HALF_H })),
          ...(propsRef.current.topology.canvas_items || []).filter((item) => !selectedIds.has(`canvas-${item.item_id}`)).map((item) => ({ x: item.x, y: item.y, halfW: item.width / 2, halfH: item.height / 2 })),
        ];
        const position = node.position();
        // A guide pairs one of this node's three lines (near edge, centre, far
        // edge) with one of a neighbour's. What a pairing gives you is the
        // distance to travel — target - candidate — never a new centre.
        // Assigning the target straight to the centre meant that lining a
        // node's edge up with a neighbour's centre teleported the node by half
        // its own height, which is what made a dragged node float away from
        // the pointer. `line` is where the guide is drawn: the neighbour's
        // line, not the node's centre.
        const snapAxis = (candidates: number[], targets: number[]): { diff: number; shift: number; line: number } | null => {
          let best: { diff: number; shift: number; line: number } | null = null;
          candidates.forEach((candidate) => {
            targets.forEach((target) => {
              const diff = Math.abs(target - candidate);
              if (diff <= SNAP && (!best || diff < best.diff)) {
                best = { diff, shift: target - candidate, line: target };
              }
            });
          });
          return best;
        };
        // Snap the position the pointer asked for, not the one the last snap
        // left behind. Undoing the previous correction first is what stops the
        // snap from compounding: without it a step smaller than SNAP is
        // cancelled every frame and the node welds itself to the guide.
        const residual = snapResidualRef.current;
        const rawX = position.x - residual.x;
        const rawY = position.y - residual.y;
        let nextX = rawX;
        let nextY = rawY;
        let snappedX: ReturnType<typeof snapAxis> = null;
        let snappedY: ReturnType<typeof snapAxis> = null;
        if (others.length) {
          const targetsX = others.flatMap((other) => [other.x - other.halfW, other.x, other.x + other.halfW]);
          const targetsY = others.flatMap((other) => [other.y - other.halfH, other.y, other.y + other.halfH]);
          snappedX = snapAxis([rawX - halfW, rawX, rawX + halfW], targetsX);
          snappedY = snapAxis([rawY - halfH, rawY, rawY + halfH], targetsY);
          nextX = rawX + (snappedX?.shift ?? 0);
          nextY = rawY + (snappedY?.shift ?? 0);
        }
        snapResidualRef.current = { x: nextX - rawX, y: nextY - rawY };
        if (nextX !== position.x || nextY !== position.y) node.position({ x: nextX, y: nextY });

        const lines: AlignGuide[] = [];
        if (snappedX) {
          const near = others.filter((other) => Math.abs(other.x - nextX) <= NODE_HALF_W * 2 + 60);
          const top = Math.min(nextY, ...near.map((other) => other.y)) - NODE_HALF_H - 12;
          const bottom = Math.max(nextY, ...near.map((other) => other.y)) + NODE_HALF_H + 12;
          lines.push({ x1: snappedX.line, y1: top, x2: snappedX.line, y2: bottom });
        }
        if (snappedY) {
          const near = others.filter((other) => Math.abs(other.y - nextY) <= NODE_HALF_H * 2 + 60);
          const leftEdge = Math.min(nextX, ...near.map((other) => other.x)) - NODE_HALF_W - 12;
          const rightEdge = Math.max(nextX, ...near.map((other) => other.x)) + NODE_HALF_W + 12;
          lines.push({ x1: leftEdge, y1: snappedY.line, x2: rightEdge, y2: snappedY.line });
        }
        const signature = lines.map((line) => `${Math.round(line.x1)}:${Math.round(line.y1)}:${Math.round(line.x2)}:${Math.round(line.y2)}`).join("|");
        if (signature !== guideSignatureRef.current) {
          guideSignatureRef.current = signature;
          setAlignGuides(lines);
        }
      });
      cy.on("free dragfree", "node", () => {
        // The correction only describes an in-progress drag; the next grab
        // starts from a position the pointer agrees with.
        snapResidualRef.current = { x: 0, y: 0 };
        if (!guideSignatureRef.current) return;
        guideSignatureRef.current = "";
        setAlignGuides([]);
      });
      cy.on("dragfree", "node", (event) => {
        // Persist what was actually dragged, plus the rest of the selection so a
        // multi-selection still moves together. The dragged node is included even
        // when it was not selected first, otherwise grabbing a node and letting
        // go would leave the canvas disagreeing with the renderer.
        const dragged = (event.target as CyNode | undefined)?.id?.() || "";
        const ids = new Set(cy.$("node:selected").map((node) => node.id()));
        if (dragged) ids.add(dragged);
        const shouldSnap = propsRef.current.gridEnabled;
        const snap = (v: number) => shouldSnap ? Math.round(v / 32) * 32 : Math.round(v);
        const positions = cy.nodes()
          .filter((node) => ids.has(node.id()) && !node.id().startsWith("group-"))
          .map((node) => {
            const raw = node.position();
            const snapped = { x: snap(raw.x), y: snap(raw.y) };
            if (shouldSnap) {
              node.position(snapped);
            }
            return { element_id: node.id(), ...snapped };
          });
        if (positions.length) propsRef.current.onMoveElements(positions);
      });
    }).catch(() => undefined);
    return () => {
      disposed = true;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    // Objects are draggable whenever the canvas is being edited, not only in
    // the layout mode. Requiring a mode switch to move a node made the default
    // mode's drag gesture a dead one: the node moved under the pointer and then
    // snapped back, because the position was never persisted. Connect mode is
    // the exception — there a drag would compete with picking two endpoints.
    const layoutEditing = props.mode !== "connect";
    // Panning stays on in every mode: Cytoscape couples wheel zoom to
    // userPanningEnabled, and dragging empty canvas to pan is what every
    // network map does. Marquee selection moved to Shift + drag.
    cy.panningEnabled(true);
    cy.userPanningEnabled(true);
    // Box selection is left to Cytoscape, which arms it on Ctrl/⌘ + drag and
    // leaves a plain drag to panning. That is the gesture eNSP and HCL both
    // use, and it costs nothing to inherit. It used to be switched off in
    // favour of the hand-rolled Shift marquee below, which left Ctrl/⌘ + drag
    // silently panning the sheet — a gesture users reach for by reflex and
    // that then did the opposite of what was wanted.
    cy.boxSelectionEnabled(true);
    // Additive is what keeps everything a marquee encloses, and what makes the
    // native Ctrl/⌘ box grow the selection instead of replacing it. Ordinary
    // taps are still normalized to a single object in the tap handler above.
    cy.selectionType("additive");
    cy.autoungrabify(!layoutEditing);
    // Existing nodes can retain the previous ungrabbable state when toggling
    // autoungrabify.  Set each editable object explicitly for this mode.
    cy.nodes().forEach((node) => {
      if (node.id().startsWith("group-")) return;
      if (layoutEditing) node.grabify();
      else node.ungrabify();
    });
  }, [rendererReady, props.mode]);

  // Export, focus and viewport control are imperative, so the workspace asks
  // for a handle once instead of pushing every canvas affordance through props.
  useEffect(() => {
    const cy = cyRef.current;
    if (!rendererReady || !cy) {
      propsRef.current.onReady?.(null);
      return;
    }
    (window as unknown as { __netops_cy?: Cy | null }).__netops_cy = cy;
    propsRef.current.onReady?.({
      exportPNG: (options) => cy.png({ full: true, scale: 2, bg: "#ffffff", ...options }),
      exportSVG: (options) => cy.svg({ full: true, ...options }),
      fit: () => {
        cy.fit(undefined, 48);
        if (cy.zoom() > 1.0) {
          cy.zoom(1.0);
          cy.center();
        }
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      resize: () => {
        cy.resize();
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      zoomBy: (delta) => {
        const zoom = Math.min(4, Math.max(0.15, cy.zoom() + delta));
        cy.zoom(zoom);
        setViewport({ ...cy.pan(), zoom });
      },
      focusIds: (ids, zoom) => {
        if (!ids.length) return;
        const collection = cy.$(ids.map((id) => `[id = "${id}"]`).join(","));
        if (!collection.length) return;
        // Locating an object must also select it. Centring the viewport alone
        // left the inspector showing a node that the canvas did not consider
        // selected, so every selection-dependent action (nudge, batch edit,
        // delete) silently did nothing after a search jump.
        const selectable = collection.filter((element) => !element.id().startsWith("group-"));
        cy.elements().unselect();
        selectable.forEach((element) => element.select());
        propsRef.current.onSelectionChange(selectable.map((element) => element.id()));
        // Selecting an object usually opens the inspector, which resizes the
        // container. Centring against a stale size lands the node off screen,
        // so measure again first and zoom about the rendered centre.
        cy.resize();
        const finish = () => setViewport({ ...cy.pan(), zoom: cy.zoom() });
        if (!zoom) {
          cy.animate({ fit: { eles: collection, padding: 90 } }, { duration: 220 });
          window.setTimeout(finish, 280);
          return;
        }
        cy.animate({ center: { eles: collection } }, { duration: 200 });
        window.setTimeout(() => {
          cy.resize();
          const host = hostRef.current;
          cy.zoom({ level: zoom, renderedPosition: { x: (host?.clientWidth || 0) / 2, y: (host?.clientHeight || 0) / 2 } });
          finish();
        }, 230);
      },
      selectAll: () => {
        const ids = cy.$("node").map((node) => node.id()).filter((id) => !id.startsWith("group-"));
        cy.elements().unselect();
        ids.forEach((id) => cy.getElementById(id).select());
        propsRef.current.onSelectionChange(ids);
        return ids;
      },
      clearSelection: () => {
        cy.elements().unselect();
        propsRef.current.onSelectionChange([]);
        propsRef.current.onClearSelection();
      },
      getViewport: () => ({ ...cy.pan(), zoom: cy.zoom() }),
      setViewport: (view) => {
        cy.zoom(view.zoom);
        cy.pan({ x: view.x, y: view.y });
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      startConnectFrom: (nodeId: string) => {
        const targetNode = cy.getElementById(nodeId);
        if (targetNode && targetNode.length) {
          connectingFromRef.current = nodeId;
          targetNode.addClass("node-connecting");
        }
      },
      getElementPosition: (id: string, kind: "node" | "link" | "canvas_item") => {
        if (!cy) return null;
        if (kind === "node") {
          const node = cy.getElementById(id);
          if (!node || !node.length) return null;
          const rp = node.renderedPosition ? node.renderedPosition() : null;
          return rp ? { x: rp.x, y: rp.y } : null;
        }
        if (kind === "link") {
          const edge = cy.getElementById(id) as CyEdge;
          if (!edge || !edge.length) return null;
          if (edge.renderedMidpoint) {
            const mid = edge.renderedMidpoint();
            if (mid) return { x: mid.x, y: mid.y };
          }
          const s = edge.source ? edge.source().renderedPosition?.() : null;
          const t = edge.target ? edge.target().renderedPosition?.() : null;
          if (s && t) return { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
          return null;
        }
        if (kind === "canvas_item") {
          const item = cy.getElementById(`canvas-${id}`);
          if (!item || !item.length) return null;
          const rp = item.renderedPosition ? item.renderedPosition() : null;
          return rp ? { x: rp.x, y: rp.y } : null;
        }
        return null;
      },
    });
    return () => {
      propsRef.current.onReady?.(null);
      (window as unknown as { __netops_cy?: Cy | null }).__netops_cy = null;
    };
  }, [rendererReady]);

  // Sync viewport changes out to parent for popover bubble positioning
  useEffect(() => {
    propsRef.current.onViewportChange?.(viewport);
  }, [viewport]);

  // Clean up in-progress connection indicator when mode exits "connect"
  useEffect(() => {
    if (props.mode !== "connect" && connectingFromRef.current) {
      cyRef.current?.getElementById(connectingFromRef.current)?.removeClass("node-connecting");
      connectingFromRef.current = null;
    }
  }, [props.mode]);

  // The canvas is drawn, not styled, so its colours have to follow the theme
  // explicitly. Without this a dark UI keeps a white diagram in the middle.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.getAttribute("data-theme") || "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const dark = theme === "dark";
    cy.style().selector("node:selected").style({ "underlay-color": dark ? CANVAS_ACCENT.dark : CANVAS_ACCENT.light }).update();
    cy.style().selector(".node-connecting").style({ "border-color": dark ? CANVAS_ACCENT.dark : CANVAS_ACCENT.light }).update();
    cy.style().selector("edge:selected").style({ "line-color": dark ? CANVAS_ACCENT.dark : CANVAS_ACCENT.light }).update();
    cy.style()
      .selector("node")
      .style({
        color: dark ? "#f1f5f9" : "#0f172a",
        "text-background-opacity": 0,
        "text-border-width": 0,
      })
      .selector("node[vendorTint]")
      .style({ "background-color": dark ? "#1c242c" : "data(vendorTint)" })
      .selector("edge")
      .style({
        color: dark ? "#f8fafc" : "#0f172a",
        "text-background-color": dark ? "#0f1519" : "#ffffff",
        "text-background-opacity": 0.85,
        "text-border-width": 0,
      })
      .selector(".canvas-item")
      .style({ "text-background-color": dark ? "#111820" : "#ffffff" })
      .selector(".lz-group")
      .style({
        "background-color": dark ? CANVAS_GROUP.dark.fill : CANVAS_GROUP.light.fill,
        "border-color": dark ? CANVAS_GROUP.dark.border : CANVAS_GROUP.light.border,
        color: dark ? CANVAS_GROUP.dark.text : CANVAS_GROUP.light.text,
      })
      .update();
    try {
      const r = (cy as any).renderer?.();
      if (r && r.data) {
        if (r.data.lblTxrCache) r.data.lblTxrCache.getElement = () => null;
        if (r.data.slbTxrCache) r.data.slbTxrCache.getElement = () => null;
        if (r.data.tlbTxrCache) r.data.tlbTxrCache.getElement = () => null;
      }
    } catch {
      // Fallback safely
    }
  }, [rendererReady, theme]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const statusPalette = nodeStatusColors(theme === "dark");
    const linkColors = { ok: statusPalette.ok, danger: statusPalette.error, unknown: statusPalette.unknown };
    const dimmed = new Set(props.dimmedNodeIds || []);
    const dimClass = (id: string, base: string) => (dimmed.has(id) ? `${base} filtered-out`.trim() : base);
    const elements: CanvasElementSpec[] = [
      ...props.topology.groups.map((group) => ({ group: "nodes", classes: "lz-group", data: { id: `group-${group.group_id}`, label: group.name, width: group.width, height: group.height }, position: { x: group.x + group.width / 2, y: group.y + group.height / 2 }, locked: true })),
      ...props.topology.nodes.map((node) => {
        const type = node.device_type || "switch";
        // The border carries operational state because that is what an
        // operator scans for; vendor stays as a background tint so neither
        // signal is lost.
        const status: NodeRuntimeStatus = "unknown";
        const statusColor = statusPalette[status];
        const vendorTint = "#fbfcfd";
        return { group: "nodes", classes: dimClass(node.node_id, "drawing-node"), data: { id: node.node_id, label: node.display_name || "未命名设备", status, statusColor, statusWidth: 2, vendorTint, icon: netOpsIconForDeviceType(type) }, position: { x: node.x, y: node.y } };
      }),
      ...(props.topology.canvas_items || []).map((item) => {
        const style = { ...canvasItemDefaults[item.kind], ...item.style };
        const isText = item.kind === "text";
        return { group: "nodes", classes: dimClass(`canvas-${item.item_id}`, `canvas-item canvas-item-${item.kind}`), data: { id: `canvas-${item.item_id}`, label: item.text, shape: item.kind === "ellipse" ? "ellipse" : "roundrectangle", width: item.width, height: item.height, fill: style.fill, border: style.border, textColor: style.color, fillOpacity: isText ? 0 : 0.24, borderWidth: isText ? 0 : 1.5, fontSize: isText ? 14 : 12, labelOpacity: 1, textMaxWidth: Math.max(24, item.width - 16) }, position: { x: item.x, y: item.y } };
      }),
      // Do not let stale/imported links with a missing endpoint reach the
      // renderer. Cytoscape rejects those elements and can otherwise leave a
      // blank canvas even though the surviving drawing is valid.
      //
      // `label`, `srcPort` and `tgtPort` are deliberately absent: they are owned
      // by the interface-label effect below, which is the only thing that knows
      // the zoom and the 接口标签 switch. Listing them here made reconciliation
      // write them back as empty strings, and that effect only re-runs when
      // `props.topology.links` changes identity — so any reconciliation that
      // left `links` alone silently blanked every interface label until the
      // next zoom. Measured: idling on the page, the labels vanished on their
      // own after 6.4s and never returned.
      ...props.topology.links
        .filter((link) => props.topology.nodes.some((node) => node.node_id === link.source_node_id) && props.topology.nodes.some((node) => node.node_id === link.target_node_id))
        .map((link) => {
          const defaultEdgeColor = link.status === "down" ? linkColors.danger : link.status === "up" ? linkColors.ok : linkColors.unknown;
          const defaultEdgeStyle = link.status === "down" ? "dotted" : link.kind === "logical" ? "dashed" : "solid";
          const defaultEdgeWidth = link.status === "down" ? 3 : 2.5;
          const edgeWidth = typeof link.style?.width === "number" && !Number.isNaN(link.style.width) ? link.style.width : defaultEdgeWidth;
          return {
            group: "edges",
            // A link is only as visible as its endpoints; dimming one end and
            // leaving the edge bright would draw attention to nothing.
            classes: dimmed.has(link.source_node_id) || dimmed.has(link.target_node_id) ? "filtered-out" : "",
            data: {
              id: link.link_id,
              source: link.source_node_id,
              target: link.target_node_id,
              visible: 1,
              edgeColor: link.style?.color || defaultEdgeColor,
              // The state is carried by shape and weight as well as colour, so a
              // down link is still identifiable when the red is not — colour-blind
              // readers, greyscale prints, and screenshots pasted into a report.
              edgeStyle: link.style?.line_style || defaultEdgeStyle,
              edgeWidth,
              curveStyle: link.style?.curve_style || "auto",
              selectedEdgeWidth: Math.max(4, edgeWidth + 1.5),
            },
          };
        }),
    ];
    applyElements(cy, elements, connectingFromRef.current, reconciledTopologyRef.current !== props.topology);
    reconciledTopologyRef.current = props.topology;
    if (initialTopologyIdRef.current !== props.topology.topology_id) {
      initialTopologyIdRef.current = props.topology.topology_id;
      window.setTimeout(() => {
        cy.resize();
        cy.fit(undefined, 48);
        if (cy.zoom() > 1.0) {
          cy.zoom(1.0);
          cy.center();
        }
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      }, 0);
    }
  }, [rendererReady, props.topology, props.dimmedNodeIds, theme]);



  // Interface labels are display-only controls. Updating edge data in place
  // keeps positions, selection, and the fixed sheet intact.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const linksById = new Map(props.topology.links.map((link) => [link.link_id, link]));
    // Zoomed far out, interface names are noise: they overlap and hide the
    // shape of the network. Level of detail is driven by the viewport.
    const showPorts = props.showInterfaces && viewport.zoom >= 0.55;
    cy.batch(() => {
      cy.$("edge").forEach((edge) => {
        const link = linksById.get(edge.id());
        if (!link) return;
        edge.data("label", canvasLinkDescription(link));
        edge.data("srcPort", showPorts ? compactInterfaceLabel(link.source_interface) : "");
        edge.data("tgtPort", showPorts ? compactInterfaceLabel(link.target_interface) : "");
        edge.data("visible", 1);
      });
    });
  }, [rendererReady, props.topology.links, props.showInterfaces, viewport.zoom]);

  // Level of detail: past a zoom-out threshold, labels stop being readable
  // and start being the reason the diagram looks like a mess.
  //
  // `props.topology` is a dependency on purpose. `labelOpacity` is owned here
  // rather than in the element spec, so this effect has to re-assert it after
  // every reconciliation — otherwise a reconcile that happens to run while the
  // view is zoomed out puts the labels straight back on. It is declared after
  // the elements effect, so within one commit it has the last word.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const opacity = viewport.zoom < 0.32 ? 0 : 1;
    cy.batch(() => {
      cy.$("node").forEach((node) => {
        if (node.data("labelOpacity") !== opacity) node.data("labelOpacity", opacity);
      });
    });
  }, [rendererReady, viewport.zoom, props.topology]);

  useEffect(() => {
    if (props.mode === "connect") return;
    const source = connectingFromRef.current;
    if (source) cyRef.current?.getElementById(source).removeClass("node-connecting");
    connectingFromRef.current = null;
  }, [props.mode]);

  /**
   * Capture the selection *before* the click that is about to be handled.
   *
   * Ctrl/⌘ + click toggles, and a toggle needs to know whether the object was
   * already in the selection. By the time Cytoscape emits `tap` it has already
   * applied its own selection change, so the answer read at that point is
   * always "yes" and the object could never be removed. A capture-phase
   * listener on `document` is the only place that is reliably earlier than the
   * renderer's own handlers — it runs before the event reaches the container
   * Cytoscape listens on.
   *
   * The modifier is read from the same event, so a Ctrl+click that is released
   * before the mouse-up still counts as a toggle.
   */
  useEffect(() => {
    const snapshot = (event: MouseEvent) => {
      const cy = cyRef.current;
      if (!cy || event.button !== 0) return;
      clickIntentRef.current = {
        ids: cy.$("node:selected").map((node) => node.id()).filter((id) => !id.startsWith("group-")),
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
      };
    };
    document.addEventListener("mousedown", snapshot, true);
    return () => document.removeEventListener("mousedown", snapshot, true);
  }, []);

  // Shift and Space track key events. Space enables canvas hand-panning,
  // while plain left-drag on empty canvas is direct marquee box selection.
  useEffect(() => {
    const isInput = (t: EventTarget | null) =>
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isInput(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setSpaceHeld(false);
        panStartRef.current = null;
        setIsPanning(false);
      }
    };
    const release = () => {
      setSpaceHeld(false);
      panStartRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Middle-mouse drag (button === 1) or Space + left-drag pans the canvas smoothly
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onMouseDown = (event: MouseEvent) => {
      const isMiddle = event.button === 1;
      const isSpaceDrag = event.button === 0 && spaceHeld;
      if (!isMiddle && !isSpaceDrag) return;
      if (!(event.target instanceof Node) || !host.contains(event.target)) return;

      const cy = cyRef.current;
      if (!cy) return;

      event.preventDefault();
      event.stopPropagation();

      const pan = cy.pan();
      panStartRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      setIsPanning(true);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!panStartRef.current) return;
      const cy = cyRef.current;
      if (!cy) return;

      event.preventDefault();
      const dx = event.clientX - panStartRef.current.clientX;
      const dy = event.clientY - panStartRef.current.clientY;
      cy.pan({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      });
      setViewport({ ...cy.pan(), zoom: cy.zoom() });
    };

    const onMouseUp = (event: MouseEvent) => {
      if (panStartRef.current) {
        event.preventDefault();
        panStartRef.current = null;
        setIsPanning(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [spaceHeld]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData("application/x-lzcore-node-type");
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!nodeType || !cy || !host) return;
    const local = toHostPoint(host, event.clientX, event.clientY);
    const pan = cy.pan();
    const zoom = cy.zoom();
    props.onPlaceNodeType(nodeType, { x: (local.x - pan.x) / zoom, y: (local.y - pan.y) / zoom });
  };

  /**
   * Overview map. It answers "where am I" on a diagram that no longer fits on
   * screen, which is the moment a topology stops being readable.
   */
  const miniTransformRef = useRef<{ minX: number; minY: number; scale: number; offX: number; offY: number } | null>(null);
  useEffect(() => {
    const canvas = miniRef.current;
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!canvas || !cy || !host || !miniOpen) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = 160;
    const height = 110;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const points: Array<{ x: number; y: number }> = [];
    props.topology.nodes.forEach((node) => points.push({ x: node.x - 47, y: node.y - 38 }, { x: node.x + 47, y: node.y + 38 }));
    (props.topology.canvas_items || []).forEach((item) => points.push({ x: item.x - item.width / 2, y: item.y - item.height / 2 }, { x: item.x + item.width / 2, y: item.y + item.height / 2 }));
    if (!points.length) return;
    const minX = Math.min(...points.map((p) => p.x)) - 40;
    const maxX = Math.max(...points.map((p) => p.x)) + 40;
    const minY = Math.min(...points.map((p) => p.y)) - 40;
    const maxY = Math.max(...points.map((p) => p.y)) + 40;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    const offX = (width - (maxX - minX) * scale) / 2;
    const offY = (height - (maxY - minY) * scale) / 2;
    miniTransformRef.current = { minX, minY, scale, offX, offY };
    const tx = (x: number) => offX + (x - minX) * scale;
    const ty = (y: number) => offY + (y - minY) * scale;
    ctx.strokeStyle = "#c3d2db";
    ctx.lineWidth = 0.8;
    const byId = new Map(props.topology.nodes.map((node) => [node.node_id, node]));
    props.topology.links.forEach((link) => {
      const source = byId.get(link.source_node_id);
      const target = byId.get(link.target_node_id);
      if (!source || !target) return;
      ctx.beginPath();
      ctx.moveTo(tx(source.x), ty(source.y));
      ctx.lineTo(tx(target.x), ty(target.y));
      ctx.stroke();
    });
    ctx.fillStyle = "#0f9d8c";
    props.topology.nodes.forEach((node) => ctx.fillRect(tx(node.x) - 2.5, ty(node.y) - 2, 5, 4));
    const pan = cy.pan();
    const zoom = cy.zoom();
    const viewX = tx(-pan.x / zoom);
    const viewY = ty(-pan.y / zoom);
    const viewW = (host.clientWidth / zoom) * scale;
    const viewH = (host.clientHeight / zoom) * scale;
    ctx.fillStyle = "rgba(12,138,122,0.09)";
    ctx.fillRect(viewX, viewY, viewW, viewH);
    ctx.strokeStyle = "#0c8a7a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(viewX, viewY, viewW, viewH);
  }, [rendererReady, props.topology, viewport, miniOpen]);

  const jumpFromMinimap = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = miniRef.current;
    const cy = cyRef.current;
    const host = hostRef.current;
    const transform = miniTransformRef.current;
    if (!canvas || !cy || !host || !transform) return;
    // The minimap canvas is a fixed 160x110 layout px, and `transform` is built
    // from those numbers — so the click has to be converted into the same space.
    const local = toHostPoint(canvas, event.clientX, event.clientY);
    const modelX = (local.x - transform.offX) / transform.scale + transform.minX;
    const modelY = (local.y - transform.offY) / transform.scale + transform.minY;
    const zoom = cy.zoom();
    cy.pan({ x: host.clientWidth / 2 - modelX * zoom, y: host.clientHeight / 2 - modelY * zoom });
    setViewport({ ...cy.pan(), zoom });
  };

  /**
   * Drag to connect. Picking two nodes in sequence works, but every diagram
   * tool people know draws the link from one device to the other, and the
   * React Flow canvas used to have connection handles before the migration.
   */
  useEffect(() => {
    if (props.mode !== "connect") return;
    const nodeAtClient = (clientX: number, clientY: number) => {
      const cy = cyRef.current;
      const host = hostRef.current;
      if (!cy || !host) return null;
      const local = toHostPoint(host, clientX, clientY);
      const pan = cy.pan();
      const zoom = cy.zoom();
      const modelX = (local.x - pan.x) / zoom;
      const modelY = (local.y - pan.y) / zoom;
      return propsRef.current.topology.nodes.find((node) => Math.abs(node.x - modelX) <= 47 && Math.abs(node.y - modelY) <= 38) || null;
    };
    const pointInHost = (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) return null;
      // Layout pixels, because these are used as CSS offsets inside the host.
      return toHostPoint(host, clientX, clientY);
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const node = nodeAtClient(event.clientX, event.clientY);
      if (!node) return;
      const point = pointInHost(event.clientX, event.clientY);
      if (!point) return;
      connectStartRef.current = node.node_id;
      setLinkPreview({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
    };
    const onMove = (event: MouseEvent) => {
      if (!connectStartRef.current) return;
      const point = pointInHost(event.clientX, event.clientY);
      if (!point) return;
      setLinkPreview((current) => (current ? { ...current, x2: point.x, y2: point.y } : current));
    };
    const onUp = (event: MouseEvent) => {
      const source = connectStartRef.current;
      connectStartRef.current = null;
      setLinkPreview(null);
      if (!source) return;
      const target = nodeAtClient(event.clientX, event.clientY);
      if (target && target.node_id !== source) propsRef.current.onConnect(source, target.node_id);
    };
    // Capture phase: Cytoscape owns the bubble-phase handlers on this element
    // and stops propagation of the gestures it recognises.
    const host = hostRef.current;
    host?.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      host?.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [props.mode]);

  const updateZoom = (delta: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const zoom = Math.min(4, Math.max(0.15, cy.zoom() + delta));
    cy.zoom(zoom);
    setViewport({ ...cy.pan(), zoom });
  };
  const fitCanvas = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.fit(undefined, 48);
    setViewport({ ...cy.pan(), zoom: cy.zoom() });
  };
  // Grid paper is a stable visual reference, independent of fit/zoom actions.
  const gridSize = 32;

  const clientPoint = (event: { clientX: number; clientY: number }) => {
    const host = hostRef.current;
    if (!host) return null;
    // Layout pixels, because the marquee box is a CSS offset inside the host.
    return toHostPoint(host, event.clientX, event.clientY);
  };
  const modelPoint = (point: { x: number; y: number }) => {
    const cy = cyRef.current;
    if (!cy) return null;
    const pan = cy.pan();
    const zoom = cy.zoom();
    return { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom };
  };
  const applyMarqueeSelection = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    const first = modelPoint(start);
    const last = modelPoint(end);
    const cy = cyRef.current;
    if (!first || !last || !cy) return;
    const left = Math.min(first.x, last.x);
    const right = Math.max(first.x, last.x);
    const top = Math.min(first.y, last.y);
    const bottom = Math.max(first.y, last.y);
    const ids = [
      ...props.topology.nodes.filter((node) => node.x >= left && node.x <= right && node.y >= top && node.y <= bottom).map((node) => node.node_id),
      ...(props.topology.canvas_items || []).filter((item) => item.x >= left && item.x <= right && item.y >= top && item.y <= bottom).map((item) => `canvas-${item.item_id}`),
    ];
    ignoreBoxSelectionTapRef.current = true;
    cy.elements().unselect();
    ids.forEach((id) => cy.getElementById(id).select());
    props.onSelectionChange(ids);
    window.setTimeout(() => { ignoreBoxSelectionTapRef.current = false; }, 0);
  };
  // Direct marquee selection on empty canvas left-drag (eNSP style).
  // Space+left-drag or middle-mouse click handles canvas panning.
  const marqueeArmed = props.mode === "select" && !props.armedNodeType && !spaceHeld;
  useEffect(() => {
    if (!marqueeArmed) return;
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || spaceHeld) return;
      const host = hostRef.current;
      const cy = cyRef.current;
      if (!host || !cy) return;
      if (!(event.target instanceof Node) || !host.contains(event.target)) return;
      // A press on a device or link belongs to Cytoscape: it selects, toggles or drags.
      if (elementUnderPointer(cy, host, event)) return;
      event.stopPropagation();
      event.preventDefault();
      const point = clientPoint(event);
      if (!point) return;
      marqueeStartRef.current = point;
      setMarqueeDrag(true);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [marqueeArmed, spaceHeld]);

  // The drag is tracked on window so that releasing the button over a floating
  // control (zoom cluster, minimap) still finishes the selection instead of
  // stranding the rectangle on screen.
  useEffect(() => {
    if (!marqueeDrag) return;
    const onMove = (event: MouseEvent) => {
      const start = marqueeStartRef.current;
      const point = clientPoint(event);
      if (!start || !point) return;
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      if (width < 5 && height < 5) return;
      setMarquee({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width, height });
    };
    const onUp = (event: MouseEvent) => {
      const start = marqueeStartRef.current;
      const point = clientPoint(event);
      marqueeStartRef.current = null;
      setMarqueeDrag(false);
      setMarquee(null);
      if (!start || !point) return;
      if (Math.abs(point.x - start.x) < 5 && Math.abs(point.y - start.y) < 5) {
        cyRef.current?.elements().unselect();
        props.onSelectionChange([]);
        props.onClearSelection();
        return;
      }
      applyMarqueeSelection(start, point);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marqueeDrag]);

  // A picked palette type waits for a click. The cursor and the banner are the
  // only things telling the user the canvas is in that state, so they are not
  // optional decoration.
  const placing = props.mode === "select" && !!props.armedNodeType;
  return <div className={`netops-canvas-wrap ${props.gridEnabled ? "grid-on" : ""} ${marqueeArmed ? "marquee-armed" : ""} ${placing ? "placing-armed" : ""} ${spaceHeld ? (isPanning ? "space-panning is-panning" : "space-panning") : ""}`} style={props.gridEnabled ? { backgroundSize: `${gridSize * viewport.zoom}px ${gridSize * viewport.zoom}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` } : undefined} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onContextMenu={(event) => event.preventDefault()}>
    <div className="netops-cytoscape" ref={hostRef} aria-label="NetOps 网络画布" />
    {placing && <div className="netops-placing-hint" aria-live="polite">在空白处单击放置设备 · Esc 取消</div>}
    {marquee && <div className="netops-selection-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} aria-hidden="true" />}
    {linkPreview && (
      <svg className="netops-link-preview" aria-hidden="true">
        <line x1={linkPreview.x1} y1={linkPreview.y1} x2={linkPreview.x2} y2={linkPreview.y2} />
        <circle cx={linkPreview.x2} cy={linkPreview.y2} r={4} />
      </svg>
    )}
    {alignGuides.length > 0 && (
      <svg className="netops-align-guides" aria-hidden="true">
        {alignGuides.map((line, index) => (
          <line key={index} x1={line.x1 * viewport.zoom + viewport.x} y1={line.y1 * viewport.zoom + viewport.y} x2={line.x2 * viewport.zoom + viewport.x} y2={line.y2 * viewport.zoom + viewport.y} />
        ))}
      </svg>
    )}
    {miniOpen && <canvas ref={miniRef} className="topology-minimap-custom" aria-label="画布鹰眼视图" title="点击跳转视口" onMouseDown={jumpFromMinimap} />}
    <div className="netops-viewport-controls" aria-label="画布视图控制">
      <button type="button" onClick={() => updateZoom(0.15)} aria-label="放大画布">+</button>
      <button type="button" onClick={() => updateZoom(-0.15)} aria-label="缩小画布">−</button>
      <button type="button" className="netops-zoom-readout" onClick={fitCanvas} title="适配全部节点">{Math.round(viewport.zoom * 100)}%</button>
      <button type="button" onClick={fitCanvas} aria-label="适配画布">适配</button>
      <button type="button" className={miniOpen ? "is-active" : ""} aria-pressed={miniOpen} onClick={() => setMiniOpen((value) => !value)} title="鹰眼视图">鹰眼</button>
    </div>
    <div className="netops-canvas-accessibility" aria-label="画布设备快捷选择">
      {props.topology.nodes.map((node) => <button key={node.node_id} type="button" data-testid={`topo-node-${node.node_id}`} onClick={() => props.onSelectNode(node.node_id)}>{node.display_name || node.node_id}</button>)}
      {(props.topology.canvas_items || []).map((item) => <button key={item.item_id} type="button" data-testid={`topo-item-${item.item_id}`} onClick={() => props.onSelectCanvasItem(item.item_id)}>{item.text || item.kind}</button>)}
    </div>
  </div>;
}
