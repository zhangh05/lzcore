import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Device, Topology } from "./TopologyWorkspace";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";

type CanvasMode = "select" | "connect";
type Position = { device_id: string; x: number; y: number };

type Props = {
  topology: Topology;
  devices: Device[];
  mode: CanvasMode;
  gridEnabled: boolean;
  layer: "all" | "physical" | "logical";
  showInterfaces: boolean;
  onSelectNode: (deviceId: string) => void;
  onSelectLink: (linkId: string) => void;
  onClearSelection: () => void;
  onSelectionChange: (deviceIds: string[]) => void;
  onMoveNodes: (positions: Position[]) => void;
  onConnect: (sourceId: string, targetId: string) => void;
  onDropDevice: (deviceId: string, position: { x: number; y: number }) => void;
};

type Cy = {
  add: (elements: unknown[]) => void;
  batch: (work: () => void) => void;
  destroy: () => void;
  elements: () => { remove: () => void; unselect: () => void };
  fit: (elements?: unknown, padding?: number) => void;
  getElementById: (id: string) => { addClass: (className: string) => void; removeClass: (className: string) => void; length: number };
  nodes: (selector?: string) => { forEach: (callback: (node: CyNode) => void) => void; map: <T>(callback: (node: CyNode) => T) => T[]; length: number };
  on: (events: string, selectorOrCallback: string | ((event: CyEvent) => void), callback?: (event: CyEvent) => void) => void;
  pan: (position?: { x: number; y: number }) => { x: number; y: number };
  resize: () => void;
  zoom: (level?: number) => number;
  $: (selector: string) => { map: <T>(callback: (node: CyNode) => T) => T[]; length: number; forEach: (callback: (node: CyNode) => void) => void };
};

type CyNode = { id: () => string; position: (position?: { x: number; y: number }) => { x: number; y: number }; selected: () => boolean };
type CyEvent = { target: { id: () => string; isNode: () => boolean; isEdge: () => boolean; addClass: (className: string) => void; removeClass: (className: string) => void } };

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

export default function NetOpsCanvas(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Cy | null>(null);
  const propsRef = useRef(props);
  const connectingFromRef = useRef<string | null>(null);
  const initialTopologyIdRef = useRef<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  propsRef.current = props;

  useEffect(() => {
    let disposed = false;
    void loadNetOpsCytoscape().then(() => {
      if (disposed || !hostRef.current || !window.cytoscape) return;
      const cy = window.cytoscape({
        container: hostRef.current,
        layout: { name: "preset" },
        wheelSensitivity: 0.22,
        userPanningEnabled: true,
        userWheelEnabled: true,
        minZoom: 0.15,
        maxZoom: 4,
        boxSelectionEnabled: true,
        style: [
          { selector: "node", style: { label: "data(label)", "text-valign": "bottom", "text-halign": "center", "text-margin-y": "7px", "font-size": 12, "font-weight": 600, color: "#26384a", "text-wrap": "ellipsis", "text-max-width": 128, "text-background-color": "#ffffff", "text-background-opacity": 0.88, "text-background-padding": "2px", width: 84, height: 84, shape: "roundrectangle", "border-width": 2, "border-color": "data(color)", "background-color": "#ffffff", "background-image": "data(icon)", "background-fit": "contain", "background-clip": "node", "background-position-x": "50%", "background-position-y": "50%" } },
          { selector: "edge", style: { width: 2.5, "line-color": "data(edgeColor)", "line-style": "data(edgeStyle)", "curve-style": "bezier", label: "data(label)", "font-size": 10, color: "#334155", "text-background-color": "#f8fafc", "text-background-opacity": 0.94, "text-background-padding": "3px", "source-label": "data(srcPort)", "target-label": "data(tgtPort)" } },
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
          current.onSelectNode(id);
          return;
        }
        if (event.target.isEdge()) {
          current.onSelectLink(event.target.id());
          return;
        }
        connectingFromRef.current = null;
        current.onClearSelection();
      });
      cy.on("select unselect", "node", () => {
        propsRef.current.onSelectionChange(cy.$("node:selected").map((node) => node.id()).filter((id) => !id.startsWith("group-")));
      });
      cy.on("dragfree", "node", () => {
        const positions = cy.$("node:selected").map((node) => ({ device_id: node.id(), ...node.position() })).filter((node) => !node.device_id.startsWith("group-"));
        if (positions.length) propsRef.current.onMoveNodes(positions);
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
    const byDevice = new Map(props.devices.map((device) => [device.device_id, device]));
    const elements: Array<Record<string, unknown>> = [
      ...props.topology.groups.map((group) => ({ group: "nodes", classes: "lz-group", data: { id: `group-${group.group_id}`, label: group.name, width: group.width, height: group.height }, position: { x: group.x + group.width / 2, y: group.y + group.height / 2 }, locked: true })),
      ...props.topology.nodes.map((node) => {
        const device = byDevice.get(node.device_id);
        const type = node.device_type || device?.device_type || "switch";
        const color = node.manual ? "#64748b" : device?.vendor?.toLowerCase().includes("huawei") ? "#2563eb" : "#0f9d8c";
        return { group: "nodes", classes: node.manual ? "manual-node" : "managed-node", data: { id: node.device_id, label: node.display_name || device?.name || node.device_id, color, icon: netOpsIconForDeviceType(type) }, position: { x: node.x, y: node.y } };
      }),
      ...props.topology.links.filter((link) => props.layer === "all" || link.kind === props.layer).map((link) => ({ group: "edges", data: { id: link.link_id, source: link.source_device_id, target: link.target_device_id, label: link.label || "", srcPort: props.showInterfaces ? link.source_interface : "", tgtPort: props.showInterfaces ? link.target_interface : "", edgeColor: link.status === "down" ? "#ef4444" : link.status === "up" ? "#10b981" : "#64748b", edgeStyle: link.kind === "logical" ? "dashed" : "solid" } })),
    ];
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (initialTopologyIdRef.current !== props.topology.topology_id) {
      initialTopologyIdRef.current = props.topology.topology_id;
      window.setTimeout(() => { cy.resize(); cy.fit(undefined, 96); setViewport({ ...cy.pan(), zoom: cy.zoom() }); }, 0);
    }
  }, [rendererReady, props.topology, props.devices, props.layer, props.showInterfaces]);

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
    cy.fit(undefined, 96);
    setViewport({ ...cy.pan(), zoom: cy.zoom() });
  };
  const gridSize = Math.max(12, 32 * viewport.zoom);
  const gridX = ((viewport.x % gridSize) + gridSize) % gridSize;
  const gridY = ((viewport.y % gridSize) + gridSize) % gridSize;

  return <div className={`netops-canvas-wrap ${props.gridEnabled ? "grid-on" : ""}`} style={props.gridEnabled ? { backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${gridX}px ${gridY}px` } : undefined} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
    <div className="netops-cytoscape" ref={hostRef} aria-label="NetOps 网络画布" />
    <div className="netops-viewport-controls" aria-label="画布视图控制">
      <button type="button" onClick={() => updateZoom(0.15)} aria-label="放大画布">+</button>
      <button type="button" onClick={() => updateZoom(-0.15)} aria-label="缩小画布">−</button>
      <button type="button" className="netops-zoom-readout" onClick={fitCanvas} title="适配全部节点">{Math.round(viewport.zoom * 100)}%</button>
      <button type="button" onClick={fitCanvas} aria-label="适配画布">适配</button>
    </div>
    <div className="netops-canvas-accessibility" aria-label="画布设备快捷选择">
      {props.topology.nodes.map((node) => <button key={node.device_id} type="button" data-testid={`topo-node-${node.device_id}`} onClick={() => props.onSelectNode(node.device_id)}>{node.display_name || node.device_id}</button>)}
    </div>
  </div>;
}
