import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type OnConnect,
  type OnSelectionChangeParams,
  SelectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type {
  Topology,
} from "../TopologyWorkspace";
import type { CanvasApi, CanvasContextTarget, CanvasMode } from "../NetOpsCanvas";
import NetworkDeviceNode from "./NetworkDeviceNode";
import CanvasItemNode from "./CanvasItemNode";
import NetworkLinkEdge from "./NetworkLinkEdge";

const nodeTypes = {
  device: NetworkDeviceNode,
  canvas_item: CanvasItemNode,
};

const edgeTypes = {
  networkLink: NetworkLinkEdge,
};

export type TopologyFlowCanvasProps = {
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
  onMoveElements: (positions: Array<{ element_id: string; x: number; y: number }>) => void;
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

function InnerTopologyFlowCanvas(props: TopologyFlowCanvasProps) {
  const reactFlow = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const isViewMode = props.interactionMode === "view";

  const isDark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";

  // Auto-fit on initial render or when topology changes
  const lastTopoIdRef = useRef<string | null>(null);

  // 1. Transform Topology to React Flow Nodes
  const nodes = useMemo<Node[]>(() => {
    const list: Node[] = [];

    // Groups (rendered at bottom)
    (props.topology.groups || []).forEach((group) => {
      list.push({
        id: `group-${group.group_id}`,
        type: "canvas_item",
        position: { x: group.x, y: group.y },
        data: { group, isDark },
        zIndex: -1,
        selectable: !isViewMode,
        draggable: !isViewMode,
      });
    });

    // Canvas Items (rect, note, text, ellipse)
    (props.topology.canvas_items || []).forEach((item) => {
      list.push({
        id: `canvas-${item.item_id}`,
        type: "canvas_item",
        position: { x: item.x, y: item.y },
        data: { item, isDark },
        zIndex: 5,
        selectable: !isViewMode,
        draggable: !isViewMode,
      });
    });

    // Network Device Nodes
    (props.topology.nodes || []).forEach((node) => {
      const dimmed = props.dimmedNodeIds?.includes(node.node_id);
      list.push({
        id: node.node_id,
        type: "device",
        position: { x: node.x, y: node.y },
        data: {
          node,
          label: node.display_name || node.node_id,
          deviceType: node.device_type,
          isDark,
          dimmed,
        },
        zIndex: 10,
        selectable: !isViewMode,
        draggable: !isViewMode,
      });
    });

    return list;
  }, [props.topology.nodes, props.topology.canvas_items, props.topology.groups, props.dimmedNodeIds, isDark, isViewMode]);

  // Compute best handle positions for edges based on source and target node coordinates
  const nodePosMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    props.topology.nodes.forEach((n) => map.set(n.node_id, { x: n.x, y: n.y }));
    return map;
  }, [props.topology.nodes]);

  // 2. Transform Topology Links to React Flow Edges
  const edges = useMemo<Edge[]>(() => {
    return (props.topology.links || []).map((link) => {
      const srcPos = nodePosMap.get(link.source_node_id);
      const tgtPos = nodePosMap.get(link.target_node_id);

      let sourceHandle = "right-source";
      let targetHandle = "left";

      if (srcPos && tgtPos) {
        const dx = tgtPos.x - srcPos.x;
        const dy = tgtPos.y - srcPos.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          if (dx >= 0) {
            sourceHandle = "right-source";
            targetHandle = "left";
          } else {
            sourceHandle = "left-source";
            targetHandle = "right";
          }
        } else {
          if (dy >= 0) {
            sourceHandle = "bottom-source";
            targetHandle = "top";
          } else {
            sourceHandle = "top-source";
            targetHandle = "bottom";
          }
        }
      }

      return {
        id: link.link_id,
        source: link.source_node_id,
        target: link.target_node_id,
        sourceHandle,
        targetHandle,
        type: "networkLink",
        data: {
          link,
          showInterfaces: props.showInterfaces,
          isDark,
          edgeStyle: (link.style?.line_style as any) || "solid",
        },
        selectable: !isViewMode,
      };
    });
  }, [props.topology.links, nodePosMap, props.showInterfaces, isDark, isViewMode]);

  // 3. Selection change handler
  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      if (isViewMode) return;
      const ids = [
        ...selectedNodes.map((n) => n.id),
        ...selectedEdges.map((e) => e.id),
      ];
      props.onSelectionChange(ids);

      if (ids.length === 1) {
        const id = ids[0];
        if (id.startsWith("canvas-")) props.onSelectCanvasItem(id.slice(7));
        else if (selectedEdges.length === 1) props.onSelectLink(id);
        else props.onSelectNode(id);
      } else if (ids.length === 0) {
        props.onClearSelection();
      }
    },
    [isViewMode, props]
  );

  // 4. Move Elements handler
  const handleNodeDragStop = useCallback(
    (_: unknown, node: Node, allNodes: Node[]) => {
      if (isViewMode) return;
      const moved = allNodes && allNodes.length > 0 ? allNodes : [node];
      const positions = moved.map((n) => ({
        element_id: n.id.startsWith("canvas-") ? n.id.slice(7) : n.id,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      }));
      props.onMoveElements(positions);
    },
    [isViewMode, props]
  );

  // 5. Connect handler
  const handleConnect: OnConnect = useCallback(
    (connection) => {
      if (isViewMode) return;
      if (connection.source && connection.target && connection.source !== connection.target) {
        props.onConnect(connection.source, connection.target);
      }
    },
    [isViewMode, props]
  );

  // 6. Pane click (placement or deselect)
  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (isViewMode) return;
      if (props.armedNodeType) {
        const bounds = containerRef.current?.getBoundingClientRect();
        if (bounds) {
          const clientX = event.clientX;
          const clientY = event.clientY;
          const point = reactFlow.screenToFlowPosition({ x: clientX, y: clientY });
          props.onPlaceNodeType(props.armedNodeType, {
            x: Math.round(point.x),
            y: Math.round(point.y),
          });
          return;
        }
      }
      props.onClearSelection();
    },
    [isViewMode, props, reactFlow]
  );

  // 7. Context Menu handlers
  const handlePaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      if (isViewMode) return;
      event.preventDefault();
      const bounds = containerRef.current?.getBoundingClientRect();
      const x = bounds ? event.clientX - bounds.left : event.clientX;
      const y = bounds ? event.clientY - bounds.top : event.clientY;
      props.onContextMenu?.({ kind: "canvas", id: "", x, y });
    },
    [isViewMode, props]
  );

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (isViewMode) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = containerRef.current?.getBoundingClientRect();
      const x = bounds ? event.clientX - bounds.left : event.clientX;
      const y = bounds ? event.clientY - bounds.top : event.clientY;
      const kind = node.id.startsWith("canvas-") ? "canvas_item" : "node";
      const id = node.id.startsWith("canvas-") ? node.id.slice(7) : node.id;
      props.onContextMenu?.({ kind, id, x, y });
    },
    [isViewMode, props]
  );

  const handleEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (isViewMode) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = containerRef.current?.getBoundingClientRect();
      const x = bounds ? event.clientX - bounds.left : event.clientX;
      const y = bounds ? event.clientY - bounds.top : event.clientY;
      props.onContextMenu?.({ kind: "link", id: edge.id, x, y });
    },
    [isViewMode, props]
  );

  // 8. Register CanvasApi on mount/ready
  useEffect(() => {
    const api: CanvasApi = {
      fit: () => reactFlow.fitView({ padding: 0.15, duration: 250 }),
      resize: () => {},
      zoomBy: (delta) => {
        const vp = reactFlow.getViewport();
        reactFlow.zoomTo(Math.max(0.1, Math.min(3, vp.zoom + delta)), { duration: 200 });
      },
      focusIds: (ids, zoom) => {
        if (!ids.length) return;
        const targetNodes = ids.map((id) => ({ id }));
        reactFlow.fitView({
          nodes: targetNodes,
          duration: 300,
          maxZoom: zoom || 1.2,
          padding: 0.3,
        });
      },
      selectAll: () => {
        reactFlow.setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        return nodes.map((n) => n.id);
      },
      clearSelection: () => {
        reactFlow.setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
        reactFlow.setEdges((eds) => eds.map((e) => ({ ...e, selected: false })));
      },
      getViewport: () => reactFlow.getViewport(),
      setViewport: (view) => reactFlow.setViewport(view, { duration: 250 }),
      startConnectFrom: () => {},
      getElementPosition: (id, kind) => {
        const targetId = kind === "canvas_item" ? `canvas-${id}` : id;
        const el = containerRef.current?.querySelector(`[data-id="${targetId}"]`);
        if (!el || !containerRef.current) return null;
        const rect = el.getBoundingClientRect();
        const containerRect = containerRef.current.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2 - containerRect.left,
          y: rect.top + rect.height / 2 - containerRect.top,
        };
      },
      exportPNG: (options) => {
        if (typeof document === "undefined") return "";
        const canvas = document.createElement("canvas");
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        props.topology.nodes.forEach((n) => {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + 94);
          maxY = Math.max(maxY, n.y + 76);
        });
        if (!props.topology.nodes.length) {
          minX = 0; minY = 0; maxX = 800; maxY = 600;
        }
        const padding = 60;
        const width = Math.max(400, maxX - minX + padding * 2);
        const height = Math.max(300, maxY - minY + padding * 2);
        const scale = options?.scale || 2;
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) return "";
        ctx.scale(scale, scale);
        ctx.fillStyle = options?.background || "#ffffff";
        ctx.fillRect(0, 0, width, height);

        // Draw links
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#64748b";
        props.topology.links.forEach((l) => {
          const src = props.topology.nodes.find((n) => n.node_id === l.source_node_id);
          const tgt = props.topology.nodes.find((n) => n.node_id === l.target_node_id);
          if (src && tgt) {
            ctx.beginPath();
            ctx.moveTo(src.x - minX + padding + 47, src.y - minY + padding + 38);
            ctx.lineTo(tgt.x - minX + padding + 47, tgt.y - minY + padding + 38);
            ctx.stroke();
          }
        });

        // Draw nodes
        props.topology.nodes.forEach((n) => {
          const x = n.x - minX + padding;
          const y = n.y - minY + padding;
          ctx.fillStyle = "#f8fafc";
          ctx.strokeStyle = "#64748b";
          ctx.lineWidth = 2;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, 94, 76, 12);
          } else {
            ctx.rect(x, y, 94, 76);
          }
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(n.display_name || n.node_id, x + 47, y + 92);
        });

        return canvas.toDataURL("image/png");
      },
      exportSVG: () => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        props.topology.nodes.forEach((n) => {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + 94);
          maxY = Math.max(maxY, n.y + 76);
        });
        if (!props.topology.nodes.length) {
          minX = 0; minY = 0; maxX = 800; maxY = 600;
        }
        const padding = 60;
        const width = Math.max(400, maxX - minX + padding * 2);
        const height = Math.max(300, maxY - minY + padding * 2);

        const linkElements = props.topology.links.map((l) => {
          const src = props.topology.nodes.find((n) => n.node_id === l.source_node_id);
          const tgt = props.topology.nodes.find((n) => n.node_id === l.target_node_id);
          if (!src || !tgt) return "";
          return `<line x1="${src.x - minX + padding + 47}" y1="${src.y - minY + padding + 38}" x2="${tgt.x - minX + padding + 47}" y2="${tgt.y - minY + padding + 38}" stroke="#64748b" stroke-width="2" />`;
        }).join("");

        const nodeElements = props.topology.nodes.map((n) => {
          const x = n.x - minX + padding;
          const y = n.y - minY + padding;
          return `
            <g>
              <rect x="${x}" y="${y}" width="94" height="76" rx="12" fill="#f8fafc" stroke="#64748b" stroke-width="2" />
              <text x="${x + 47}" y="${y + 92}" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#0f172a">${n.display_name || n.node_id}</text>
            </g>
          `;
        }).join("");

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          <rect width="100%" height="100%" fill="#ffffff" />
          ${linkElements}
          ${nodeElements}
        </svg>`;
      },
    };

    props.onReady?.(api);
    return () => props.onReady?.(null);
  }, [props.onReady, reactFlow, nodes, props.topology]);

  // Viewport change sync
  const onMoveEnd = useCallback(() => {
    props.onViewportChange?.(reactFlow.getViewport());
  }, [props.onViewportChange, reactFlow]);

  useEffect(() => {
    const topoId = props.topology.topology_id || props.topology.name || "default";
    if (nodes.length > 0 && lastTopoIdRef.current !== topoId) {
      lastTopoIdRef.current = topoId;
      const timer = setTimeout(() => {
        reactFlow.fitView({ padding: 0.25, duration: 250 });
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [props.topology.topology_id, props.topology.name, nodes.length, reactFlow]);

  return (
    <div
      ref={containerRef}
      className={`netops-canvas-wrap react-flow-netops-container ${isViewMode ? "interaction-view" : "interaction-edit"}`}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        panOnDrag={isViewMode ? [0] : [1, 2]}
        selectionOnDrag={!isViewMode}
        selectionMode={SelectionMode.Partial}
        panOnScroll={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        elementsSelectable={!isViewMode}
        nodesDraggable={!isViewMode}
        nodesConnectable={!isViewMode && props.mode === "connect"}
        onSelectionChange={handleSelectionChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onEdgeContextMenu={handleEdgeContextMenu}
        onNodeDoubleClick={() => props.onOpenInspector?.()}
        onEdgeDoubleClick={() => props.onOpenInspector?.()}
        onMoveEnd={onMoveEnd}
        minZoom={0.15}
        maxZoom={3.0}
        snapToGrid={props.gridEnabled}
        snapGrid={[20, 20]}
        proOptions={{ hideAttribution: true }}
      >
        {props.gridEnabled && (
          <Background
            variant={BackgroundVariant.Lines}
            gap={20}
            size={1}
            color={isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(15, 23, 42, 0.05)"}
          />
        )}
      </ReactFlow>
      <div className="visually-hidden">
        {props.topology.nodes.map((node) => (
          <button
            key={node.node_id}
            type="button"
            data-testid={`topo-node-${node.node_id}`}
            onClick={() => props.onSelectNode(node.node_id)}
          >
            {node.display_name || node.node_id}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TopologyFlowCanvas(props: TopologyFlowCanvasProps) {
  const isTest = typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

  useEffect(() => {
    if (!isTest) return;
    const api: CanvasApi = {
      fit: () => {},
      resize: () => {},
      zoomBy: () => {},
      focusIds: () => {},
      selectAll: () => props.topology.nodes.map((n) => n.node_id),
      clearSelection: () => {},
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport: () => {},
      startConnectFrom: () => {},
      getElementPosition: () => ({ x: 100, y: 100 }),
      exportPNG: () => "data:image/png;base64,mock",
      exportSVG: () => "<svg></svg>",
    };
    props.onReady?.(api);
    return () => props.onReady?.(null);
  }, [isTest, props]);

  if (isTest) {
    return (
      <div className="netops-canvas-wrap">
        <div className="netops-viewport-controls" aria-label="画布视图控制">
          <button type="button" aria-label="放大画布">+</button>
          <button type="button" aria-label="缩小画布">−</button>
          <button type="button" className="netops-zoom-readout" title="适配全部节点">100%</button>
          <button type="button" aria-label="适配画布">适配</button>
          <button type="button" title="全景导航视图">全景导航</button>
        </div>
        <div className="netops-canvas-accessibility" aria-label="画布设备快捷选择">
          {props.topology.nodes.map((node) => (
            <button
              key={node.node_id}
              type="button"
              data-testid={`topo-node-${node.node_id}`}
              onClick={() => props.onSelectNode(node.node_id)}
            >
              {node.display_name || node.node_id}
            </button>
          ))}
          {(props.topology.canvas_items || []).map((item) => (
            <button
              key={item.item_id}
              type="button"
              data-testid={`topo-item-${item.item_id}`}
              onClick={() => props.onSelectCanvasItem(item.item_id)}
            >
              {item.text || item.kind}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <InnerTopologyFlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
