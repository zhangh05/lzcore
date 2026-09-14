import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { Device, Topology, TopologyCanvasItem, TopologyLink } from "./TopologyWorkspace";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";

/** Selecting information must never mutate the drawing by accident. */
type CanvasMode = "select" | "move" | "connect";
type Position = { element_id: string; x: number; y: number };

type Props = {
  topology: Topology;
  devices: Device[];
  mode: CanvasMode;
  gridEnabled: boolean;
  layer: "all" | "physical" | "logical";
  showInterfaces: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectCanvasItem: (itemId: string) => void;
  onSelectLink: (linkId: string) => void;
  onClearSelection: () => void;
  onSelectionChange: (elementIds: string[]) => void;
  onMoveElements: (positions: Position[]) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  onDropDevice: (deviceId: string, position: { x: number; y: number }) => void;
};

type Cy = {
  add: (elements: unknown[]) => void;
  batch: (work: () => void) => void;
  destroy: () => void;
  elements: () => { remove: () => void; unselect: () => void };
  fit: (elements?: unknown, padding?: number) => void;
  getElementById: (id: string) => CyElement;
  nodes: (selector?: string) => { forEach: (callback: (node: CyNode) => void) => void; map: <T>(callback: (node: CyNode) => T) => T[]; length: number };
  on: (events: string, selectorOrCallback: string | ((event: CyEvent) => void), callback?: (event: CyEvent) => void) => void;
  pan: (position?: { x: number; y: number }) => { x: number; y: number };
  boxSelectionEnabled: (enabled?: boolean) => boolean;
  selectionType: (type?: "single" | "additive") => string;
  userPanningEnabled: (enabled?: boolean) => boolean;
  autoungrabify: (enabled?: boolean) => boolean;
  resize: () => void;
  zoom: (level?: number) => number;
  $: (selector: string) => { map: <T>(callback: (node: CyNode) => T) => T[]; length: number; forEach: (callback: (node: CyNode) => void) => void };
};

type CyElement = { id: () => string; data: (name: string, value?: unknown) => unknown; addClass: (className: string) => void; removeClass: (className: string) => void; select: () => void; grabify: () => void; ungrabify: () => void; length: number };
type CyNode = CyElement & { position: (position?: { x: number; y: number }) => { x: number; y: number }; selected: () => boolean };
type CyEvent = { target: { id: () => string; isNode: () => boolean; isEdge: () => boolean; addClass: (className: string) => void; removeClass: (className: string) => void; select: () => void } };

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

export default function NetOpsCanvas(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Cy | null>(null);
  const propsRef = useRef(props);
  const connectingFromRef = useRef<string | null>(null);
  const ignoreBoxSelectionTapRef = useRef(false);
  const marqueeStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const clickCandidateRef = useRef<{ id: string; kind: "node" | "canvas_item" | "link"; pointerId: number } | null>(null);
  const moveStartRef = useRef<{ x: number; y: number; pointerId: number; positions: Position[] } | null>(null);
  const initialTopologyIdRef = useRef<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  propsRef.current = props;

  useEffect(() => {
    let disposed = false;
    void loadNetOpsCytoscape().then(() => {
      if (disposed || !hostRef.current || !window.cytoscape) return;
      const cy = window.cytoscape({
        container: hostRef.current,
        layout: { name: "preset" },
        // The sheet itself is fixed. Editing changes object coordinates only.
        userPanningEnabled: false,
        userWheelEnabled: true,
        minZoom: 0.15,
        maxZoom: 4,
        boxSelectionEnabled: false,
        style: [
          { selector: "node", style: { label: "data(label)", "text-valign": "bottom", "text-halign": "center", "text-margin-y": "8px", "font-size": 12, "font-weight": 600, color: "#26384a", "text-wrap": "ellipsis", "text-max-width": 132, "text-background-color": "#ffffff", "text-background-opacity": 0.88, "text-background-padding": "2px", width: 94, height: 76, shape: "roundrectangle", "border-width": 2, "border-color": "data(color)", "background-color": "#ffffff", "background-image": "data(icon)", "background-fit": "contain", "background-clip": "node", "background-position-x": "50%", "background-position-y": "50%", "z-index": 10 } },
          { selector: "node:active", style: { "overlay-opacity": 0, "underlay-opacity": 0 } },
          { selector: "edge", style: { width: 2.5, opacity: "data(visible)", "line-color": "data(edgeColor)", "line-style": "data(edgeStyle)", "curve-style": "bezier", label: "data(label)", "font-size": 10, "min-zoomed-font-size": 8, color: "#334155", "text-background-color": "#ffffff", "text-background-opacity": 0.98, "text-background-padding": "3px", "text-margin-y": "-14px", "source-label": "data(srcPort)", "target-label": "data(tgtPort)", "source-text-offset": 42, "target-text-offset": 42, "source-text-margin-y": "14px", "target-text-margin-y": "14px" } },
          { selector: ".canvas-item", style: { label: "data(label)", shape: "data(shape)", width: "data(width)", height: "data(height)", "background-color": "data(fill)", "background-opacity": "data(fillOpacity)", "border-color": "data(border)", "border-width": "data(borderWidth)", color: "data(textColor)", "font-size": "data(fontSize)", "font-weight": 600, "text-wrap": "wrap", "text-max-width": "data(textMaxWidth)", "text-valign": "center", "text-halign": "center", "z-index": 2 } },
          { selector: ".canvas-item-text", style: { "background-opacity": 0, "border-width": 0, "text-valign": "center", "text-halign": "left", "font-size": 14, "font-weight": 500, "text-max-width": "data(textMaxWidth)" } },
          { selector: "node:selected", style: { "border-width": 3, "border-color": "#60a5fa" } },
          { selector: ".node-connecting", style: { "border-width": 3, "border-color": "#3b82f6" } },
          { selector: ".lz-group", style: { shape: "roundrectangle", label: "data(label)", "text-valign": "top", "text-halign": "left", "text-margin-x": 12, "text-margin-y": 10, color: "#475569", "font-size": 12, "font-weight": 600, width: "data(width)", height: "data(height)", "background-color": "#dbeafe", "background-opacity": 0.22, "border-color": "#93c5fd", "border-style": "dashed", "border-width": 1, "background-image": "none", "events": "no" } },
        ],
      });
      cyRef.current = cy;
      setRendererReady(true);
      const syncViewport = () => setViewport({ ...cy.pan(), zoom: cy.zoom() });
      cy.on("zoom pan", syncViewport);
      cy.on("tap", (event) => {
        const current = propsRef.current;
        if (event.target.isNode()) {
          const id = event.target.id();
          if (id.startsWith("group-")) return;
          if (id.startsWith("canvas-")) {
            if (current.mode !== "move") {
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
              event.target.addClass("node-connecting");
              return;
            }
            cy.getElementById(source).removeClass("node-connecting");
            connectingFromRef.current = null;
            if (source !== id) current.onConnect(source, id);
            return;
          }
          if (current.mode === "move") return;
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
        if (event.target.isEdge()) {
          current.onSelectLink(event.target.id());
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
    cy.userPanningEnabled(false);
    // Do not let Cytoscape draw its own selection rectangle on mouse-down.
    // The React gesture below starts only after the user holds and drags.
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

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const byDevice = new Map(props.devices.map((device) => [device.device_id, device]));
    const elements: Array<Record<string, unknown>> = [
      ...props.topology.groups.map((group) => ({ group: "nodes", classes: "lz-group", data: { id: `group-${group.group_id}`, label: group.name, width: group.width, height: group.height }, position: { x: group.x + group.width / 2, y: group.y + group.height / 2 }, locked: true })),
      ...props.topology.nodes.map((node) => {
        const device = byDevice.get(node.linked_device_id || "");
        const type = node.device_type || device?.device_type || "switch";
        const color = !node.linked_device_id ? "#64748b" : device?.vendor?.toLowerCase().includes("huawei") ? "#2563eb" : "#0f9d8c";
        return { group: "nodes", classes: node.linked_device_id ? "managed-node" : "manual-node", data: { id: node.node_id, label: node.display_name || device?.name || "未命名设备", color, icon: netOpsIconForDeviceType(type) }, position: { x: node.x, y: node.y } };
      }),
      ...(props.topology.canvas_items || []).map((item) => {
        const style = { ...canvasItemDefaults[item.kind], ...item.style };
        const isText = item.kind === "text";
        return { group: "nodes", classes: `canvas-item canvas-item-${item.kind}`, data: { id: `canvas-${item.item_id}`, label: item.text, shape: item.kind === "ellipse" ? "ellipse" : "roundrectangle", width: item.width, height: item.height, fill: style.fill, border: style.border, textColor: style.color, fillOpacity: isText ? 0 : 0.24, borderWidth: isText ? 0 : 1.5, fontSize: isText ? 14 : 12, textMaxWidth: Math.max(24, item.width - 16) }, position: { x: item.x, y: item.y } };
      }),
      ...props.topology.links.map((link) => ({ group: "edges", data: { id: link.link_id, source: link.source_node_id, target: link.target_node_id, label: "", srcPort: "", tgtPort: "", visible: 1, edgeColor: link.status === "down" ? "#ef4444" : link.status === "up" ? "#10b981" : "#64748b", edgeStyle: link.kind === "logical" ? "dashed" : "solid" } })),
    ];
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (initialTopologyIdRef.current !== props.topology.topology_id) {
      initialTopologyIdRef.current = props.topology.topology_id;
      window.setTimeout(() => { cy.resize(); cy.fit(undefined, 48); setViewport({ ...cy.pan(), zoom: cy.zoom() }); }, 0);
    }
  }, [rendererReady, props.topology, props.devices]);

  // Interface labels and the layer filter are display-only controls.  Updating
  // edge data in place keeps positions, selection, and the fixed sheet intact.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const linksById = new Map(props.topology.links.map((link) => [link.link_id, link]));
    cy.batch(() => {
      cy.$("edge").forEach((edge) => {
        const link = linksById.get(edge.id());
        if (!link) return;
        edge.data("label", canvasLinkDescription(link));
        edge.data("srcPort", props.showInterfaces ? compactInterfaceLabel(link.source_interface) : "");
        edge.data("tgtPort", props.showInterfaces ? compactInterfaceLabel(link.target_interface) : "");
        edge.data("visible", props.layer === "all" || link.kind === props.layer ? 1 : 0);
      });
    });
  }, [rendererReady, props.topology.links, props.layer, props.showInterfaces]);

  useEffect(() => {
    if (props.mode === "connect") return;
    const source = connectingFromRef.current;
    if (source) cyRef.current?.getElementById(source).removeClass("node-connecting");
    connectingFromRef.current = null;
  }, [props.mode]);

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

  type CanvasPointerEvent = MouseEvent<HTMLDivElement>;
  const eventPointerId = () => 1;
  const clientPoint = (event: CanvasPointerEvent) => {
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
  const canvasObjectAt = (point: { x: number; y: number }) => {
    const model = modelPoint(point);
    if (!model) return null;
    const node = props.topology.nodes.find((item) => Math.abs(item.x - model.x) <= 48 && Math.abs(item.y - model.y) <= 40);
    if (node) return { id: node.node_id, kind: "node" as const };
    const canvasItem = (props.topology.canvas_items || []).find((item) => Math.abs(item.x - model.x) <= item.width / 2 && Math.abs(item.y - model.y) <= item.height / 2);
    if (canvasItem) return { id: `canvas-${canvasItem.item_id}`, kind: "canvas_item" as const };
    const nodeById = new Map(props.topology.nodes.map((item) => [item.node_id, item]));
    const link = props.topology.links.find((item) => {
      const source = nodeById.get(item.source_node_id);
      const target = nodeById.get(item.target_node_id);
      if (!source || !target) return false;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const squared = dx * dx + dy * dy;
      const ratio = squared ? Math.max(0, Math.min(1, ((model.x - source.x) * dx + (model.y - source.y) * dy) / squared)) : 0;
      return Math.hypot(model.x - (source.x + ratio * dx), model.y - (source.y + ratio * dy)) <= 10;
    });
    return link ? { id: link.link_id, kind: "link" as const } : null;
  };
  const selectCanvasObject = (candidate: { id: string; kind: "node" | "canvas_item" | "link" }) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().unselect();
    cy.getElementById(candidate.id).select();
    props.onSelectionChange([candidate.id]);
    if (candidate.kind === "node") props.onSelectNode(candidate.id);
    else if (candidate.kind === "canvas_item") props.onSelectCanvasItem(candidate.id.slice("canvas-".length));
    else props.onSelectLink(candidate.id);
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
  const handlePointerDown = (event: CanvasPointerEvent) => {
    if (event.button !== 0 || props.mode === "connect") return;
    const point = clientPoint(event);
    if (!point) return;
    const candidate = canvasObjectAt(point);
    if (candidate) {
      clickCandidateRef.current = { ...candidate, pointerId: eventPointerId() };
      return;
    }
    marqueeStartRef.current = { ...point, pointerId: eventPointerId() };
  };
  const handlePointerMove = (event: CanvasPointerEvent) => {
    const start = marqueeStartRef.current;
    const point = clientPoint(event);
    if (!start || !point || start.pointerId !== eventPointerId()) return;
    const width = Math.abs(point.x - start.x);
    const height = Math.abs(point.y - start.y);
    if (width < 5 && height < 5) return;
    setMarquee({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width, height });
  };
  const finishMarquee = (event: CanvasPointerEvent) => {
    const candidate = clickCandidateRef.current;
    const start = marqueeStartRef.current;
    const point = clientPoint(event);
    clickCandidateRef.current = null;
    marqueeStartRef.current = null;
    if (!point) return;
    if (candidate && candidate.pointerId === eventPointerId()) {
      selectCanvasObject(candidate);
      return;
    }
    if (!start || start.pointerId !== eventPointerId() || (Math.abs(point.x - start.x) < 5 && Math.abs(point.y - start.y) < 5)) {
      cyRef.current?.elements().unselect();
      props.onSelectionChange([]);
      props.onClearSelection();
      setMarquee(null);
      return;
    }
    applyMarqueeSelection(start, point);
    setMarquee(null);
  };
  const handleMovePointerDown = (event: CanvasPointerEvent) => {
    if (event.button !== 0) return;
    const point = clientPoint(event);
    const candidate = point && canvasObjectAt(point);
    const cy = cyRef.current;
    if (!point || !candidate || candidate.kind === "link" || !cy) return;
    let ids = cy.$("node:selected").map((node) => node.id()).filter((id) => !id.startsWith("group-"));
    if (!ids.includes(candidate.id)) {
      cy.elements().unselect();
      cy.getElementById(candidate.id).select();
      ids = [candidate.id];
      props.onSelectionChange(ids);
    }
    const positions = ids.map((element_id) => ({ element_id, ...((cy.getElementById(element_id) as CyNode).position()) }));
    moveStartRef.current = { ...point, pointerId: eventPointerId(), positions };
  };
  const handleMovePointerMove = (event: CanvasPointerEvent) => {
    const start = moveStartRef.current;
    const point = clientPoint(event);
    const cy = cyRef.current;
    if (!start || !point || !cy || start.pointerId !== eventPointerId()) return;
    const zoom = cy.zoom();
    const deltaX = (point.x - start.x) / zoom;
    const deltaY = (point.y - start.y) / zoom;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    cy.batch(() => start.positions.forEach((position) => {
      (cy.getElementById(position.element_id) as CyNode).position({ x: position.x + deltaX, y: position.y + deltaY });
    }));
  };
  const finishMove = (event: CanvasPointerEvent) => {
    const start = moveStartRef.current;
    const point = clientPoint(event);
    const cy = cyRef.current;
    moveStartRef.current = null;
    if (!start || !point || !cy || start.pointerId !== eventPointerId()) return;
    const zoom = cy.zoom();
    const deltaX = (point.x - start.x) / zoom;
    const deltaY = (point.y - start.y) / zoom;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    props.onMoveElements(start.positions.map((position) => ({ element_id: position.element_id, x: position.x + deltaX, y: position.y + deltaY })));
  };

  return <div className={`netops-canvas-wrap ${props.gridEnabled ? "grid-on" : ""}`} style={props.gridEnabled ? { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: "0 0" } : undefined} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
    <div className="netops-cytoscape" ref={hostRef} aria-label="NetOps 网络画布" />
    {props.mode === "select" && <div className="netops-selection-gesture-layer" onMouseDown={handlePointerDown} onMouseMove={handlePointerMove} onMouseUp={finishMarquee} onMouseLeave={() => { marqueeStartRef.current = null; clickCandidateRef.current = null; setMarquee(null); }} />}
    {props.mode === "move" && <div className="netops-move-gesture-layer" onMouseDown={handleMovePointerDown} onMouseMove={handleMovePointerMove} onMouseUp={finishMove} onMouseLeave={() => { moveStartRef.current = null; }} />}
    {marquee && <div className="netops-selection-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} aria-hidden="true" />}
    <div className="netops-viewport-controls" aria-label="画布视图控制">
      <button type="button" onClick={() => updateZoom(0.15)} aria-label="放大画布">+</button>
      <button type="button" onClick={() => updateZoom(-0.15)} aria-label="缩小画布">−</button>
      <button type="button" className="netops-zoom-readout" onClick={fitCanvas} title="适配全部节点">{Math.round(viewport.zoom * 100)}%</button>
      <button type="button" onClick={fitCanvas} aria-label="适配画布">适配</button>
    </div>
    <div className="netops-canvas-accessibility" aria-label="画布设备快捷选择">
      {props.topology.nodes.map((node) => <button key={node.node_id} type="button" data-testid={`topo-node-${node.node_id}`} onClick={() => props.onSelectNode(node.node_id)}>{node.display_name || node.node_id}</button>)}
      {(props.topology.canvas_items || []).map((item) => <button key={item.item_id} type="button" data-testid={`topo-item-${item.item_id}`} onClick={() => props.onSelectCanvasItem(item.item_id)}>{item.text || item.kind}</button>)}
    </div>
  </div>;
}
