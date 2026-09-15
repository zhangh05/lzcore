// React 的合成事件类型与 DOM 原生事件同名，这里显式区分：画布上的原生
// window 监听必须拿到 DOM MouseEvent（带 clientX/clientY 且可用于
// addEventListener），React 回调才用合成事件类型。
import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { Device, Topology, TopologyCanvasItem, TopologyLink } from "./TopologyWorkspace";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";

/** Selecting information must never mutate the drawing by accident. */
type CanvasMode = "select" | "move" | "connect";
type Position = { element_id: string; x: number; y: number };

/** Imperative handles the surrounding workspace needs (export, focus, view). */
export type CanvasApi = {
  exportPNG: (options?: { full?: boolean; scale?: number; background?: string }) => string;
  exportSVG: (options?: { full?: boolean }) => string;
  fit: () => void;
  zoomBy: (delta: number) => void;
  focusIds: (ids: string[], zoom?: number) => void;
  selectAll: () => string[];
  clearSelection: () => void;
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (view: { x: number; y: number; zoom: number }) => void;
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
  light: { fill: "#e5f1ee", border: "#d7e1de", text: "#6c7c7e" },
  dark: { fill: "#173633", border: "#263442", text: "#95a3b3" },
};

type Props = {
  topology: Topology;
  devices: Device[];
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
  onDropDevice: (deviceId: string, position: { x: number; y: number }) => void;
  /** Handed to the workspace once the renderer exists, null when it is gone. */
  onReady?: (api: CanvasApi | null) => void;
  onContextMenu?: (target: CanvasContextTarget) => void;
  /** node_id -> operational state, derived from the last collection pass. */
  nodeStatus?: Record<string, NodeRuntimeStatus>;
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
  remove: () => void;
  unselect: () => void;
  select: () => void;
  length: number;
};

type Cy = {
  add: (elements: unknown[]) => void;
  batch: (work: () => void) => void;
  destroy: () => void;
  elements: () => CyCollection<CyElement>;
  fit: (elements?: unknown, padding?: number) => void;
  getElementById: (id: string) => CyElement;
  nodes: (selector?: string) => CyCollection<CyNode>;
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
  group: () => string;
  length: number;
};
type CyNode = CyElement & { position: (position?: { x: number; y: number }) => { x: number; y: number }; selected: () => boolean };
type CyStyleChain = { selector: (selector: string) => { style: (style: Record<string, unknown>) => CyStyleChain }; update: () => void };
type CyEvent = { target: { id?: () => string; isNode?: () => boolean; isEdge?: () => boolean; addClass?: (className: string) => void; removeClass?: (className: string) => void; select?: () => void }; originalEvent?: MouseEvent };

declare global {
  interface Window {
    cytoscape?: (options: Record<string, unknown>) => Cy;
    __lzcoreNetOpsCytoscapeLoad?: Promise<void>;
  }
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
      if (syncPositions && existing.isNode() && next.position) {
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
  /** Shift enables marquee selection; see the gesture overlay below. */
  const [shiftHeld, setShiftHeld] = useState(false);
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
        style: [
          { selector: "node", style: { label: "data(label)", "text-valign": "bottom", "text-halign": "center", "text-margin-y": "8px", "font-size": 12, "font-weight": 600, color: "#26384a", "text-wrap": "ellipsis", "text-max-width": 132, "text-background-color": "#ffffff", "text-background-opacity": 0.88, "text-background-padding": "2px", width: 94, height: 76, shape: "roundrectangle", "border-width": "data(statusWidth)", "border-color": "data(statusColor)", "text-opacity": "data(labelOpacity)", "z-index": 10 } },
          // Drawing items deliberately have no vendor field. Keeping this data
          // mapping on asset nodes prevents Cytoscape from warning on every
          // canvas refresh when it encounters a text box or an ellipse.
          { selector: "node[vendorTint]", style: { "background-color": "data(vendorTint)" } },
          // Canvas items and groups deliberately have no device icon. Apply
          // image mappings only to asset nodes so Cytoscape stays warning-free.
          { selector: "node[icon]", style: { "background-image": "data(icon)", "background-fit": "contain", "background-clip": "node", "background-position-x": "50%", "background-position-y": "50%" } },
          { selector: "node:active", style: { "overlay-opacity": 0, "underlay-opacity": 0 } },
          { selector: "edge", style: { width: 2.5, opacity: "data(visible)", "line-color": "data(edgeColor)", "line-style": "data(edgeStyle)", "curve-style": "bezier", label: "data(label)", "font-size": 10, "min-zoomed-font-size": 8, color: "#334155", "text-background-color": "#ffffff", "text-background-opacity": 0.98, "text-background-padding": "3px", "text-margin-y": "-14px", "source-label": "data(srcPort)", "target-label": "data(tgtPort)", "source-text-offset": 42, "target-text-offset": 42, "source-text-margin-y": "14px", "target-text-margin-y": "14px" } },
          { selector: ".canvas-item", style: { label: "data(label)", shape: "data(shape)", width: "data(width)", height: "data(height)", "background-color": "data(fill)", "background-opacity": "data(fillOpacity)", "border-color": "data(border)", "border-width": "data(borderWidth)", color: "data(textColor)", "font-size": "data(fontSize)", "font-weight": 600, "text-wrap": "wrap", "text-max-width": "data(textMaxWidth)", "text-valign": "center", "text-halign": "center", "text-opacity": "data(labelOpacity)", "z-index": 2 } },
          { selector: ".canvas-item-text", style: { "background-opacity": 0, "border-width": 0, "text-valign": "center", "text-halign": "left", "font-size": 14, "font-weight": 500, "text-max-width": "data(textMaxWidth)" } },
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
          { selector: ".lz-group", style: { shape: "roundrectangle", label: "data(label)", "text-valign": "top", "text-halign": "left", "text-margin-x": 12, "text-margin-y": 10, color: CANVAS_GROUP.light.text, "font-size": 12, "font-weight": 600, width: "data(width)", height: "data(height)", "background-color": CANVAS_GROUP.light.fill, "background-opacity": 0.5, "border-color": CANVAS_GROUP.light.border, "border-style": "dashed", "border-width": 1, "background-image": "none", "events": "no" } },
        ],
      });
      cyRef.current = cy;
      setRendererReady(true);
      const syncViewport = () => setViewport({ ...cy.pan(), zoom: cy.zoom() });
      cy.on("zoom pan", syncViewport);
      cy.on("tap", (event) => {
        const current = propsRef.current;
        if (event.target.isNode?.()) {
          const id = event.target.id?.() || "";
          if (!id) return;
          if (id.startsWith("group-")) return;
          if (id.startsWith("canvas-")) {
            if (current.mode !== "connect") {
              window.setTimeout(() => {
                cy.elements().unselect();
                cy.getElementById(id).select();
                current.onSelectionChange([id]);
              }, 0);
              current.onSelectCanvasItem(id.slice("canvas-".length));
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
          if (current.mode === "move") {
            // Move mode still needs an explicit selection on a click.  Dragging
            // is left entirely to Cytoscape so a node drag and a sheet pan can
            // share the same native pointer stream without a React overlay.
            window.setTimeout(() => {
              cy.elements().unselect();
              cy.getElementById(id).select();
              current.onSelectionChange([id]);
            }, 0);
            current.onSelectNode(id);
            return;
          }
          // Cytoscape must use additive selection for a marquee to retain all
          // enclosed objects.  Restore familiar single-click semantics here.
          window.setTimeout(() => {
            cy.elements().unselect();
            cy.getElementById(id).select();
            current.onSelectionChange([id]);
          }, 0);
          current.onSelectNode(id);
          return;
        }
        if (event.target.isEdge?.()) {
          const id = event.target.id?.();
          if (id) current.onSelectLink(id);
          return;
        }
        connectingFromRef.current = null;
        // The release of our own marquee is not an intent to clear selection.
        if (ignoreBoxSelectionTapRef.current) return;
        cy.elements().unselect();
        current.onClearSelection();
      });
      cy.on("select unselect", "node", () => {
        propsRef.current.onSelectionChange(cy.$("node:selected").map((node) => node.id()).filter((id) => !id.startsWith("group-")));
      });
      cy.on("cxttap", (event) => {
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
        if (!node || propsRef.current.mode !== "move" || node.id().startsWith("group-")) return;
        const selectedIds = new Set(cy.$("node:selected").map((item) => item.id()));
        const others = propsRef.current.topology.nodes.filter((item) => item.node_id !== node.id() && !selectedIds.has(item.node_id));
        if (!others.length) return;
        const position = node.position();
        const snapAxis = (candidates: number[], targets: number[]): { diff: number; value: number } | null => {
          let best: { diff: number; value: number } | null = null;
          candidates.forEach((candidate) => {
            targets.forEach((target) => {
              const diff = Math.abs(target - candidate);
              if (diff <= SNAP && (!best || diff < best.diff)) best = { diff, value: target };
            });
          });
          return best;
        };
        const targetsX = others.flatMap((other) => [other.x - NODE_HALF_W, other.x, other.x + NODE_HALF_W]);
        const targetsY = others.flatMap((other) => [other.y - NODE_HALF_H, other.y, other.y + NODE_HALF_H]);
        let x = position.x;
        let y = position.y;
        const snappedX = snapAxis([x - NODE_HALF_W, x, x + NODE_HALF_W], targetsX);
        if (snappedX) x = snappedX.value;
        const snappedY = snapAxis([y - NODE_HALF_H, y, y + NODE_HALF_H], targetsY);
        if (snappedY) y = snappedY.value;
        if (x !== position.x || y !== position.y) node.position({ x, y });

        const lines: AlignGuide[] = [];
        if (snappedX) {
          const near = others.filter((other) => Math.abs(other.x - x) <= NODE_HALF_W * 2 + 60);
          const top = Math.min(y, ...near.map((other) => other.y)) - NODE_HALF_H - 12;
          const bottom = Math.max(y, ...near.map((other) => other.y)) + NODE_HALF_H + 12;
          lines.push({ x1: x, y1: top, x2: x, y2: bottom });
        }
        if (snappedY) {
          const near = others.filter((other) => Math.abs(other.y - y) <= NODE_HALF_H * 2 + 60);
          const leftEdge = Math.min(x, ...near.map((other) => other.x)) - NODE_HALF_W - 12;
          const rightEdge = Math.max(x, ...near.map((other) => other.x)) + NODE_HALF_W + 12;
          lines.push({ x1: leftEdge, y1: y, x2: rightEdge, y2: y });
        }
        const signature = lines.map((line) => `${Math.round(line.x1)}:${Math.round(line.y1)}:${Math.round(line.x2)}:${Math.round(line.y2)}`).join("|");
        if (signature !== guideSignatureRef.current) {
          guideSignatureRef.current = signature;
          setAlignGuides(lines);
        }
      });
      cy.on("free dragfree", "node", () => {
        if (!guideSignatureRef.current) return;
        guideSignatureRef.current = "";
        setAlignGuides([]);
      });
      cy.on("dragfree", "node", () => {
        if (propsRef.current.mode !== "move") return;
        const positions = cy.$("node:selected").map((node) => ({ element_id: node.id(), ...node.position() })).filter((node) => !node.element_id.startsWith("group-"));
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
    const layoutEditing = props.mode === "move";
    // Panning stays on in every mode: Cytoscape couples wheel zoom to
    // userPanningEnabled, and dragging empty canvas to pan is what every
    // network map does. Marquee selection moved to Shift + drag.
    cy.panningEnabled(true);
    cy.userPanningEnabled(true);
    // Do not let Cytoscape draw its own selection rectangle on mouse-down.
    // The React marquee below starts only while Shift is held.
    cy.boxSelectionEnabled(false);
    // Additive remains necessary for programmatic multi-selection; ordinary
    // taps are explicitly normalized to one selected object above.
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
    propsRef.current.onReady?.({
      exportPNG: (options) => cy.png({ full: true, scale: 2, bg: "#ffffff", ...options }),
      exportSVG: (options) => cy.svg({ full: true, ...options }),
      fit: () => {
        cy.fit(undefined, 48);
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
    });
    return () => { propsRef.current.onReady?.(null); };
  }, [rendererReady]);

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
    cy.style()
      .selector("node")
      .style({
        color: dark ? "#dce7ef" : "#26384a",
        "text-background-color": dark ? "#111820" : "#ffffff",
      })
      .selector("node[vendorTint]")
      .style({ "background-color": dark ? "#1c242c" : "data(vendorTint)" })
      .selector("edge")
      .style({ color: dark ? "#c8d5df" : "#334155", "text-background-color": dark ? "#111820" : "#ffffff" })
      .selector(".canvas-item")
      .style({ "text-background-color": dark ? "#111820" : "#ffffff" })
      .selector(".lz-group")
      .style({
        "background-color": dark ? CANVAS_GROUP.dark.fill : CANVAS_GROUP.light.fill,
        "border-color": dark ? CANVAS_GROUP.dark.border : CANVAS_GROUP.light.border,
        color: dark ? CANVAS_GROUP.dark.text : CANVAS_GROUP.light.text,
      })
      .update();
  }, [rendererReady, theme]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const byDevice = new Map(props.devices.map((device) => [device.device_id, device]));
    const statusPalette = nodeStatusColors(theme === "dark");
    const linkColors = { ok: statusPalette.ok, danger: statusPalette.error, unknown: statusPalette.unknown };
    const dimmed = new Set(props.dimmedNodeIds || []);
    const dimClass = (id: string, base: string) => (dimmed.has(id) ? `${base} filtered-out`.trim() : base);
    const elements: CanvasElementSpec[] = [
      ...props.topology.groups.map((group) => ({ group: "nodes", classes: "lz-group", data: { id: `group-${group.group_id}`, label: group.name, width: group.width, height: group.height }, position: { x: group.x + group.width / 2, y: group.y + group.height / 2 }, locked: true })),
      ...props.topology.nodes.map((node) => {
        const device = byDevice.get(node.linked_device_id || "");
        const type = node.device_type || device?.device_type || "switch";
        // The border carries operational state because that is what an
        // operator scans for; vendor stays as a background tint so neither
        // signal is lost.
        const status: NodeRuntimeStatus = props.nodeStatus?.[node.node_id] || "unknown";
        const statusColor = statusPalette[status];
        const vendorTint = !node.linked_device_id ? "#fbfcfd" : device?.vendor?.toLowerCase().includes("huawei") ? "#f2f7ff" : "#f4fbfa";
        return { group: "nodes", classes: dimClass(node.node_id, node.linked_device_id ? "managed-node" : "manual-node"), data: { id: node.node_id, label: node.display_name || device?.name || "未命名设备", status, statusColor, statusWidth: status === "error" ? 3 : 2, vendorTint, labelOpacity: 1, icon: netOpsIconForDeviceType(type) }, position: { x: node.x, y: node.y } };
      }),
      ...(props.topology.canvas_items || []).map((item) => {
        const style = { ...canvasItemDefaults[item.kind], ...item.style };
        const isText = item.kind === "text";
        return { group: "nodes", classes: dimClass(`canvas-${item.item_id}`, `canvas-item canvas-item-${item.kind}`), data: { id: `canvas-${item.item_id}`, label: item.text, shape: item.kind === "ellipse" ? "ellipse" : "roundrectangle", width: item.width, height: item.height, fill: style.fill, border: style.border, textColor: style.color, fillOpacity: isText ? 0 : 0.24, borderWidth: isText ? 0 : 1.5, fontSize: isText ? 14 : 12, labelOpacity: 1, textMaxWidth: Math.max(24, item.width - 16) }, position: { x: item.x, y: item.y } };
      }),
      // Do not let stale/imported links with a missing endpoint reach the
      // renderer. Cytoscape rejects those elements and can otherwise leave a
      // blank canvas even though the surviving drawing is valid.
      ...props.topology.links
        .filter((link) => props.topology.nodes.some((node) => node.node_id === link.source_node_id) && props.topology.nodes.some((node) => node.node_id === link.target_node_id))
        .map((link) => ({
          group: "edges",
          // A link is only as visible as its endpoints; dimming one end and
          // leaving the edge bright would draw attention to nothing.
          classes: dimmed.has(link.source_node_id) || dimmed.has(link.target_node_id) ? "filtered-out" : "",
          data: { id: link.link_id, source: link.source_node_id, target: link.target_node_id, label: "", srcPort: "", tgtPort: "", visible: 1, edgeColor: link.status === "down" ? linkColors.danger : link.status === "up" ? linkColors.ok : linkColors.unknown, edgeStyle: link.kind === "logical" ? "dashed" : "solid" },
        })),
    ];
    applyElements(cy, elements, connectingFromRef.current, reconciledTopologyRef.current !== props.topology);
    reconciledTopologyRef.current = props.topology;
    if (initialTopologyIdRef.current !== props.topology.topology_id) {
      initialTopologyIdRef.current = props.topology.topology_id;
      window.setTimeout(() => { cy.resize(); cy.fit(undefined, 48); setViewport({ ...cy.pan(), zoom: cy.zoom() }); }, 0);
    }
  }, [rendererReady, props.topology, props.devices, props.dimmedNodeIds, theme]);

  // Probe results can change without a diagram edit. Update only status data:
  // reconciling positions here could undo a drag while its save is in flight.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const palette = nodeStatusColors(theme === "dark");
    cy.batch(() => {
      for (const node of props.topology.nodes) {
        const status = props.nodeStatus?.[node.node_id] || "unknown";
        const rendered = cy.getElementById(node.node_id);
        rendered.data("status", status);
        rendered.data("statusColor", palette[status]);
        rendered.data("statusWidth", status === "error" ? 3 : 2);
      }
    });
  }, [rendererReady, props.topology, props.nodeStatus, theme]);

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
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const opacity = viewport.zoom < 0.32 ? 0 : 1;
    cy.batch(() => {
      cy.$("node").forEach((node) => {
        if (node.data("labelOpacity") !== opacity) node.data("labelOpacity", opacity);
      });
    });
  }, [rendererReady, viewport.zoom]);

  useEffect(() => {
    if (props.mode === "connect") return;
    const source = connectingFromRef.current;
    if (source) cyRef.current?.getElementById(source).removeClass("node-connecting");
    connectingFromRef.current = null;
  }, [props.mode]);

  // Shift arms the marquee. Tracked globally so the overlay is mounted before
  // the drag starts, and released defensively when the window loses focus.
  useEffect(() => {
    const sync = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    const release = () => setShiftHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", release);
    };
  }, []);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const deviceId = event.dataTransfer.getData("application/x-lzcore-device-id") || event.dataTransfer.getData("text/plain");
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!deviceId || !cy || !host) return;
    const rect = host.getBoundingClientRect();
    const pan = cy.pan();
    const zoom = cy.zoom();
    const x = (event.clientX - rect.left - pan.x) / zoom;
    const y = (event.clientY - rect.top - pan.y) / zoom;
    const snap = (value: number) => props.gridEnabled ? Math.round(value / 32) * 32 : Math.round(value);
    props.onDropDevice(deviceId, { x: snap(x), y: snap(y) });
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
    const rect = canvas.getBoundingClientRect();
    const modelX = (event.clientX - rect.left - transform.offX) / transform.scale + transform.minX;
    const modelY = (event.clientY - rect.top - transform.offY) / transform.scale + transform.minY;
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
      const rect = host.getBoundingClientRect();
      const pan = cy.pan();
      const zoom = cy.zoom();
      const modelX = (clientX - rect.left - pan.x) / zoom;
      const modelY = (clientY - rect.top - pan.y) / zoom;
      return propsRef.current.topology.nodes.find((node) => Math.abs(node.x - modelX) <= 47 && Math.abs(node.y - modelY) <= 38) || null;
    };
    const pointInHost = (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
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

  type CanvasPointerEvent = ReactMouseEvent<HTMLDivElement>;
  const clientPoint = (event: { clientX: number; clientY: number }) => {
    const rect = hostRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null;
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
  // Marquee selection is opt-in with Shift. A plain drag pans the sheet and
  // the wheel zooms, and because the overlay only exists while Shift is held,
  // every ordinary gesture goes back to Cytoscape's own hit testing instead
  // of a hand-rolled duplicate of it.
  const handlePointerDown = (event: CanvasPointerEvent) => {
    if (event.button !== 0) return;
    const point = clientPoint(event);
    if (!point) return;
    marqueeStartRef.current = point;
    setMarqueeDrag(true);
  };

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

  const marqueeArmed = props.mode === "select" && shiftHeld;

  return <div className={`netops-canvas-wrap ${props.gridEnabled ? "grid-on" : ""} ${marqueeArmed ? "marquee-armed" : ""}`} style={props.gridEnabled ? { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: "0 0" } : undefined} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onContextMenu={(event) => event.preventDefault()}>
    <div className="netops-cytoscape" ref={hostRef} aria-label="NetOps 网络画布" />
    {marqueeArmed && <div className="netops-selection-gesture-layer" onMouseDown={handlePointerDown} />}
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
