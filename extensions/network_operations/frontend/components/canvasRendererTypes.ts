/** canvasRendererTypes is a renderer port independent of React screen state. */
import { type ReferenceLine } from "./TopologyReferenceLines";
import type { Topology } from "./topologyDocument";
import { type NodeRuntimeStatus } from "./topologyPalette";

export type CanvasMode = "select" | "connect";

export type Position = { element_id: string; x: number; y: number };

export type ElementBoundingBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
};

export type ElementPositionResult = {
  x: number;
  y: number;
  bb?: ElementBoundingBox;
  neighbors?: Array<{
    id: string;
    pos: { x: number; y: number };
    bb: ElementBoundingBox;
  }>;
  otherNodes?: Array<{
    id: string;
    pos: { x: number; y: number };
    bb: ElementBoundingBox;
  }>;
};

export type CanvasApi = {
  exportPNG: (options?: {
    full?: boolean;
    scale?: number;
    background?: string;
  }) => string;
  exportSVG: (options?: { full?: boolean }) => string;
  fit: () => void;
  resize: () => void;
  zoomBy: (delta: number) => void;
  focusIds: (ids: string[], zoom?: number) => void;
  selectAll: () => string[];
  selectElements?: (ids: string[]) => void;
  clearSelection: () => void;
  getBodies: (ids: string[]) => import("./topologyDragSnap").SnapBody[];
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (view: { x: number; y: number; zoom: number }) => void;
  startConnectFrom?: (nodeId: string) => void;
  getElementPosition?: (
    id: string,
    kind: "node" | "link" | "canvas_item",
  ) => ElementPositionResult | null;
};

export type CanvasContextTarget = {
  x: number;
  y: number;
  kind: "node" | "link" | "canvas_item" | "canvas";
  id: string;
};

export type Props = {
  topology: Topology;
  nodeObservationStatus?: Record<string, NodeRuntimeStatus | null>;
  nodeOverlayLines?: Record<string, string>;
  mode: CanvasMode;
  interactionMode?: "view" | "edit";
  gridEnabled: boolean;
  gridSnapEnabled?: boolean;
  smartGuidesEnabled?: boolean;
  alignmentReferenceId?: string | null;
  referenceLines?: ReferenceLine[];
  onReferenceLinesChange?: (lines: ReferenceLine[]) => void;
  moveRegionMembers?: boolean;
  showInterfaces: boolean;
  compactMode?: boolean;
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
  onPlaceNodeType: (
    deviceType: string,
    position: { x: number; y: number },
  ) => void;
  /** Called when the user gives up on placing (Esc, or a click on a device). */
  onDisarmNodeType: () => void;
  /** Handed to the workspace once the renderer exists, null when it is gone. */
  onReady?: (api: CanvasApi | null) => void;
  onContextMenu?: (target: CanvasContextTarget) => void;
  onOpenInspector?: () => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  /** node_id -> operational state, derived from the last collection pass. */
  /**
   * node_ids the active filter excludes. They stay on the canvas at low
   * opacity rather than disappearing: a filtered diagram still has to answer
   * "what am I not looking at".
   */
  dimmedNodeIds?: string[];
  highlightedIds?: string[];
};

export type CyCollection<T> = {
  map: <R>(callback: (element: T) => R) => R[];
  filter: (callback: (element: T) => boolean) => CyCollection<T>;
  forEach: (callback: (element: T) => void) => void;
  some: (callback: (element: T) => boolean) => boolean;
  not?: (elements: unknown) => CyCollection<T>;
  remove: () => void;
  unselect: () => void;
  select: () => void;
  length: number;
};

export type Cy = {
  add: (elements: unknown[]) => void;
  batch: (work: () => void) => void;
  center: (elements?: unknown) => void;
  destroy: () => void;
  elements: () => CyCollection<CyElement>;
  fit: (elements?: unknown, padding?: number) => void;
  getElementById: (id: string) => CyElement;
  nodes: (selector?: string) => CyCollection<CyNode>;
  edges: () => CyCollection<CyEdge>;
  on: (
    events: string,
    selectorOrCallback: string | ((event: CyEvent) => void),
    callback?: (event: CyEvent) => void,
  ) => void;
  pan: (position?: { x: number; y: number }) => { x: number; y: number };
  panningEnabled: (enabled?: boolean) => boolean;
  boxSelectionEnabled: (enabled?: boolean) => boolean;
  selectionType: (type?: "single" | "additive") => string;
  userPanningEnabled: (enabled?: boolean) => boolean;
  autoungrabify: (enabled?: boolean) => boolean;
  autounselectify?: (enabled?: boolean) => boolean;
  resize: () => void;
  zoom: (
    level?:
      | number
      | { level: number; renderedPosition?: { x: number; y: number } },
  ) => number;
  $: (selector: string) => CyCollection<CyNode>;
  style: () => {
    selector: (selector: string) => {
      style: (style: Record<string, unknown>) => CyStyleChain;
    };
  };
  animate: (
    animation: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => void;
  /** Base64 data URI. Used by the export action. */
  png: (options?: Record<string, unknown>) => string;
  svg: (options?: Record<string, unknown>) => string;
  extent: () => { x1: number; y1: number; x2: number; y2: number };
  container?: () => HTMLElement;
  renderer?: () => {
    findNearestElements?: (
      x: number,
      y: number,
      visibleOnly?: boolean,
      isTouch?: boolean,
    ) => CyElement[];
  };
};

export type CyElement = {
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
  renderedBoundingBox?: () => {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    w: number;
    h: number;
  };
  neighborhood?: (selector?: string) => CyCollection<CyNode>;
  source?: () => CyElement;
  target?: () => CyElement;
};

export type CyNode = CyElement & {
  position: (position?: { x: number; y: number }) => { x: number; y: number };
  selected: () => boolean;
  grabbed: () => boolean;
  width: () => number;
  height: () => number;
};

export type CyEdge = CyElement & {
  sourceEndpoint: () => { x: number; y: number };
  targetEndpoint: () => { x: number; y: number };
  controlPoints: () => { x: number; y: number }[] | undefined;
  style: (values: Record<string, number>) => void;
  renderedMidpoint?: () => { x: number; y: number };
  midpoint?: () => { x: number; y: number };
};

export type CyStyleChain = {
  selector: (selector: string) => {
    style: (style: Record<string, unknown>) => CyStyleChain;
  };
  update: () => void;
};

export type CyEvent = {
  target: {
    id?: () => string;
    isNode?: () => boolean;
    isEdge?: () => boolean;
    addClass?: (className: string) => void;
    removeClass?: (className: string) => void;
    select?: () => void;
  };
  originalEvent?: MouseEvent;
  position?: { x: number; y: number };
  renderedPosition?: { x: number; y: number };
};

declare global {
  interface Window {
    cytoscape?: (options: Record<string, unknown>) => Cy;
    __lzcoreNetOpsCytoscapeLoad?: Promise<void>;
  }
}

export type CanvasElementSpec = {
  group?: string;
  classes?: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
};

export type AlignGuide = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  aligned?: boolean;
  hint?: string;
  source?: "device";
  referenceId?: string;
};
