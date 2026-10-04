import { toHostPoint } from "./canvasHitTesting";
import type { AlignGuide, Cy, Props } from "./canvasRendererTypes";
import { TopologyReferenceLines } from "./TopologyReferenceLines";
import { useCanvasApi } from "./useCanvasApi";
import { useCanvasConnection } from "./useCanvasConnection";
import { useCanvasMarquee } from "./useCanvasMarquee";
import { useCanvasMinimap } from "./useCanvasMinimap";
import { useCanvasOverlays } from "./useCanvasOverlays";
import { useCanvasPanning } from "./useCanvasPanning";
import { useCanvasRenderer } from "./useCanvasRenderer";
import { useCanvasScene } from "./useCanvasScene";
import { useCanvasTheme } from "./useCanvasTheme";
export { canvasLinkDescription, compactInterfaceLabel } from "./canvasLabels";
export type {
  CanvasApi,
  CanvasContextTarget,
  ElementBoundingBox,
  ElementPositionResult,
} from "./canvasRendererTypes";
export {
  CANVAS_ACCENT,
  CANVAS_GROUP,
  NODE_STATUS_COLORS,
  NODE_STATUS_COLORS_DARK,
  nodeStatusColors,
} from "./topologyPalette";
export type { NodeRuntimeStatus } from "./topologyPalette";
// React 的合成事件类型与 DOM 原生事件同名，这里显式区分：画布上的原生
// window 监听必须拿到 DOM MouseEvent（带 clientX/clientY 且可用于
// addEventListener），React 回调才用合成事件类型。
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Topology } from "./topologyDocument";

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
  const clickIntentRef = useRef<{ ids: string[]; additive: boolean }>({
    ids: [],
    additive: false,
  });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const initialTopologyIdRef = useRef<string | null>(null);
  // Theme, filtering and probe updates are presentation-only. Only a new
  // diagram snapshot may reconcile the renderer's in-progress positions.
  const reconciledTopologyRef = useRef<Topology | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [marqueeDrag, setMarqueeDrag] = useState(false);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [miniOpen, setMiniOpen] = useState(false);
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  const guideSignatureRef = useRef("");
  const [theme, setTheme] = useState(() =>
    typeof document === "undefined"
      ? "light"
      : document.documentElement.getAttribute("data-theme") || "light",
  );

  // Sync adaptive world grid with viewport, theme and gridEnabled switch
  useCanvasOverlays({
    alignGuides,
    cyRef,
    gridCanvasRef,
    hostRef,
    overlayCanvasRef,
    props,
    theme,
    viewport,
  });
  // How far the last alignment snap moved the node away from where the pointer
  // had put it. Cytoscape drags a node incrementally — new position = current
  // position + pointer delta — so a snap silently swallows that much of the
  // pointer's travel. Left uncorrected, a step smaller than the snap window is
  // cancelled every frame and the node sticks to the guide line instead of
  // following the pointer. Carrying the offset lets the next frame subtract it
  // and recover the position the pointer actually asked for.
  const snapResidualRef = useRef({ x: 0, y: 0 });
  const snapTargetRef = useRef<{ x: string | null; y: string | null }>({
    x: null,
    y: null,
  });
  const grabAnchorRef = useRef<{ id: string; x: number; y: number } | null>(
    null,
  );
  const lockGroupInitialPositionsRef = useRef<
    Map<string, { x: number; y: number }>
  >(new Map());
  const [linkPreview, setLinkPreview] = useState<AlignGuide | null>(null);
  const connectStartRef = useRef<string | null>(null);
  propsRef.current = props;

  useCanvasRenderer({
    clickIntentRef,
    connectingFromRef,
    cyRef,
    grabAnchorRef,
    guideSignatureRef,
    hostRef,
    ignoreBoxSelectionTapRef,
    lockGroupInitialPositionsRef,
    props,
    propsRef,
    rendererReady,
    setAlignGuides,
    setRendererReady,
    setViewport,
    snapResidualRef,
    snapTargetRef,
  });

  // Export, focus and viewport control are imperative, so the workspace asks
  // for a handle once instead of pushing every canvas affordance through props.
  useCanvasApi({
    connectingFromRef,
    cyRef,
    hostRef,
    propsRef,
    rendererReady,
    setViewport,
    viewport,
  });

  // Clean up in-progress connection indicator when mode exits "connect"
  useEffect(() => {
    if (props.mode !== "connect" && connectingFromRef.current) {
      cyRef.current
        ?.getElementById(connectingFromRef.current)
        ?.removeClass("node-connecting");
      connectingFromRef.current = null;
    }
  }, [props.mode]);

  // The canvas is drawn, not styled, so its colours have to follow the theme
  // explicitly. Without this a dark UI keeps a white diagram in the middle.
  useCanvasTheme({ cyRef, rendererReady, setTheme, theme });

  useCanvasScene({
    connectingFromRef,
    cyRef,
    initialTopologyIdRef,
    props,
    reconciledTopologyRef,
    rendererReady,
    setViewport,
    theme,
    viewport,
  });

  useEffect(() => {
    if (props.mode === "connect") return;
    const source = connectingFromRef.current;
    if (source)
      cyRef.current?.getElementById(source).removeClass("node-connecting");
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
        ids: cy
          .$("node:selected")
          .map((node) => node.id())
          .filter((id) => !id.startsWith("group-")),
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
      };
    };
    document.addEventListener("mousedown", snapshot, true);
    return () => document.removeEventListener("mousedown", snapshot, true);
  }, []);

  // Shift and Space track key events. Space enables canvas hand-panning,
  // while plain left-drag on empty canvas is direct marquee box selection.
  useCanvasPanning({
    cyRef,
    hostRef,
    panStartRef,
    propsRef,
    setIsPanning,
    setSpaceHeld,
    setViewport,
    spaceHeld,
  });

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData(
      "application/x-lzcore-node-type",
    );
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!nodeType || !cy || !host) return;
    const local = toHostPoint(host, event.clientX, event.clientY);
    const pan = cy.pan();
    const zoom = cy.zoom();
    props.onPlaceNodeType(nodeType, {
      x: (local.x - pan.x) / zoom,
      y: (local.y - pan.y) / zoom,
    });
  };

  /**
   * Overview map. It answers "where am I" on a diagram that no longer fits on
   * screen, which is the moment a topology stops being readable.
   */
  const { handleMinimapCanvasDown } = useCanvasMinimap({
    cyRef,
    hostRef,
    miniOpen,
    miniRef,
    props,
    rendererReady,
    setViewport,
    theme,
    viewport,
  });

  /**
   * Drag to connect. Picking two nodes in sequence works, but every diagram
   * tool people know draws the link from one device to the other, and the
   * React Flow canvas used to have connection handles before the migration.
   */
  useCanvasConnection({
    connectStartRef,
    cyRef,
    hostRef,
    props,
    propsRef,
    setLinkPreview,
  });

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

  const { isViewMode, marqueeArmed } = useCanvasMarquee({
    cyRef,
    hostRef,
    ignoreBoxSelectionTapRef,
    marqueeDrag,
    marqueeStartRef,
    props,
    setMarquee,
    setMarqueeDrag,
    spaceHeld,
  });

  // A picked palette type waits for a click. The cursor and the banner are the
  // only things telling the user the canvas is in that state, so they are not
  // optional decoration.
  const placing =
    !isViewMode && props.mode === "select" && !!props.armedNodeType;
  return (
    <div
      className={`netops-canvas-wrap ${isViewMode ? "interaction-view" : "interaction-edit"} ${props.gridEnabled ? "grid-on" : ""} ${marqueeArmed ? "marquee-armed" : ""} ${placing ? "placing-armed" : ""} ${spaceHeld || (isViewMode && isPanning) ? (isPanning ? "space-panning is-panning" : "space-panning") : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <canvas
        ref={gridCanvasRef}
        className="netops-world-grid"
        aria-hidden="true"
      />
      <div
        className="netops-cytoscape"
        ref={hostRef}
        aria-label="NetOps 网络画布"
      />
      <canvas
        ref={overlayCanvasRef}
        className="netops-motion-overlay"
        aria-hidden="true"
      />
      {placing && (
        <div className="netops-placing-hint" aria-live="polite">
          在空白处单击放置设备 · Esc 取消
        </div>
      )}
      {marquee && (
        <div
          className="netops-selection-marquee"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.width,
            height: marquee.height,
          }}
          aria-hidden="true"
        >
          <span className="netops-marquee-hud">
            {Math.round(marquee.width)} × {Math.round(marquee.height)} px
          </span>
        </div>
      )}
      <TopologyReferenceLines
        lines={props.referenceLines || []}
        viewport={viewport}
        editable={!isViewMode}
        onChange={props.onReferenceLinesChange}
      />
      {linkPreview && (
        <svg className="netops-link-preview" aria-hidden="true">
          <line
            x1={linkPreview.x1}
            y1={linkPreview.y1}
            x2={linkPreview.x2}
            y2={linkPreview.y2}
          />
          <circle cx={linkPreview.x2} cy={linkPreview.y2} r={4} />
        </svg>
      )}
      {alignGuides.length > 0 && (
        <svg className="netops-align-guides" aria-hidden="true">
          {alignGuides.map((line, index) => (
            <line
              key={index}
              data-source={line.source}
              data-reference={line.referenceId}
              data-aligned={line.aligned !== false}
              className={line.aligned === false ? "attracting" : undefined}
              x1={line.x1 * viewport.zoom + viewport.x}
              y1={line.y1 * viewport.zoom + viewport.y}
              x2={line.x2 * viewport.zoom + viewport.x}
              y2={line.y2 * viewport.zoom + viewport.y}
            />
          ))}
        </svg>
      )}
      {miniOpen && (
        <div className="topology-minimap-panel">
          <div className="topology-minimap-header">
            <div className="topology-minimap-title-wrap">
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
              </svg>
              <span>全景导航</span>
            </div>
            <button
              type="button"
              className="topology-minimap-close"
              onClick={() => setMiniOpen(false)}
              title="关闭全景导航"
              aria-label="关闭全景导航"
            >
              ✕
            </button>
          </div>
          <div className="topology-minimap-body">
            <canvas
              ref={miniRef}
              className="topology-minimap-custom"
              aria-label="画布全景导航图"
              title="点击或拖动跳转视口"
              onMouseDown={handleMinimapCanvasDown}
            />
          </div>
        </div>
      )}
      <div className="netops-viewport-controls" aria-label="画布视图控制">
        <button
          type="button"
          onClick={() => updateZoom(0.15)}
          aria-label="放大画布"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => updateZoom(-0.15)}
          aria-label="缩小画布"
        >
          −
        </button>
        <button
          type="button"
          className="netops-zoom-readout"
          onClick={fitCanvas}
          title="适配全部节点"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button type="button" onClick={fitCanvas} aria-label="适配画布">
          适配
        </button>
        <button
          type="button"
          className={miniOpen ? "is-active" : ""}
          aria-pressed={miniOpen}
          onClick={() => setMiniOpen((value) => !value)}
          title="全景导航视图"
        >
          全景导航
        </button>
      </div>
      <div
        className="netops-canvas-accessibility"
        aria-label="画布设备快捷选择"
      >
        {props.topology.nodes.map((node) => (
          <button
            key={node.node_id}
            type="button"
            data-testid={`topo-node-${node.node_id}`}
            onClick={() => props.onSelectNode(node.node_id)}
          >
            {node.display_name || node.node_id}
            {props.nodeOverlayLines?.[node.node_id]
              ? ` · ${props.nodeOverlayLines[node.node_id]}`
              : ""}
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
        <button
          type="button"
          data-testid="topo-batch-select"
          onClick={(e) => {
            const ids = (e.currentTarget.dataset.ids || "")
              .split(",")
              .filter(Boolean);
            props.onSelectionChange(ids);
          }}
        />
        <button
          type="button"
          data-testid="topo-move-elements"
          onClick={(e) => {
            try {
              const raw = e.currentTarget.dataset.positions;
              if (raw) props.onMoveElements(JSON.parse(raw));
            } catch {
              /* ignore */
            }
          }}
        />
      </div>
    </div>
  );
}
