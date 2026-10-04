/** TopologyCanvasStage owns its presentation; document writes stay with the workspace controller. */
import {
  IconBranch,
  IconClose,
  IconEdit,
  IconEye,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import NetOpsCanvas, {
  type CanvasApi,
  type CanvasContextTarget,
} from "./NetOpsCanvas";
import {
  overlayCanvasLine,
  overlayCaption,
  overlayObservationStatus,
  type NodeOverlay,
} from "./nodeOverlay";
import { TopologyCanvasItemInspector } from "./TopologyCanvasItemInspector";
import type { Topology } from "./topologyDocument";
import { TopologyEditToolbar } from "./TopologyEditToolbar";
import { TopologyHeaderToolbar } from "./TopologyHeaderToolbar";
import { type LayoutAlgorithm } from "./topologyLayout";
import { TopologyLinkInspector } from "./TopologyLinkInspector";
import { TopologyNodeInspector } from "./TopologyNodeInspector";
import type { ReferenceLine } from "./TopologyReferenceLines";
import { TopologySelectionInspector } from "./TopologySelectionInspector";
import { TopologyWhiteboard } from "./TopologyWhiteboard";

export type TopologyCanvasStageProps = {
  activeTopology: Topology;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  alignmentReferenceId: string | null;
  applyBookmark: (bookmark: {
    name: string;
    x: number;
    y: number;
    zoom: number;
  }) => void;
  applyDeviceTypeToSelection: (deviceType: string) => void;
  armedNodeType: string | null;
  bindableDevices: { device_id: string; name: string; host: string }[];
  bindChoice: string;
  binding: boolean;
  bookmarks: { name: string; x: number; y: number; zoom: number }[];
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  canvasMode: "select" | "connect";
  canvasSelectedElementIds: string[];
  changeReferenceLines: (lines: ReferenceLine[]) => void;
  compactMode: boolean;
  disarmNodeType: () => void;
  distributeSelected: (axis: "horizontal" | "vertical") => void;
  executeSave: (topo: Topology) => Promise<void>;
  exportCanvas: (format: "png" | "svg" | "pdf") => Promise<void>;
  future: import("./topologyCollaboration").DrawingEdit[];
  gridEnabled: boolean;
  gridSnapEnabled: boolean;
  handleAddCanvasItem: (
    kind: import("./topologyDocument").TopologyCanvasItem["kind"],
  ) => void;
  handleAlignSelectedNodes: (
    direction: "left" | "center" | "right" | "top" | "middle" | "bottom",
  ) => void;
  handleAutoFitCanvasItem: (itemId: string) => void;
  handleAutoLayout: (algorithm?: LayoutAlgorithm) => Promise<void>;
  handleBringCanvasItemToFront: (itemId: string) => void;
  handleCloneNode: (nodeId: string) => void;
  handleDeleteTopology: () => Promise<void>;
  handleFastConnect: (source: string, target: string) => void;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleJoinZone: (nodeId: string, zoneItemId: string) => void;
  handleLeaveZone: (nodeId: string) => void;
  handleLockSelectedNodes: () => void;
  handleNetOpsMove: (
    positions: Array<{ element_id: string; x: number; y: number }>,
  ) => void;
  handleOpenCreateZone: () => void;
  handleOpenRevisions: () => Promise<void>;
  handleOpenWorkbenchChat: () => Promise<void>;
  handleRedo: () => void;
  handleRemoveCanvasItem: (itemId: string) => Promise<void>;
  handleRemoveLink: (linkId: string) => Promise<void>;
  handleRemoveNode: (nodeId: string) => Promise<void>;
  handleSelectLockGroup: (nodeId: string) => void;
  handleSelectZoneMembers: (nodeId: string) => void;
  handleSendCanvasItemToBack: (itemId: string) => void;
  handleSetWorkspaceMode: (mode: "view" | "edit") => void;
  handleToggleFullscreen: () => void;
  handleToggleWhiteboard: () => void;
  handleUndo: () => void;
  handleUnlockNode: (nodeId: string) => void;
  handleUnlockSelectedNodes: () => void;
  hasMultiSelection: boolean;
  highlightedIds: string[];
  history: import("./topologyCollaboration").DrawingEdit[];
  inspectorRef: import("react").RefObject<HTMLElement>;
  isDragged: boolean;
  isDragging: boolean;
  isFullscreen: boolean;
  isInspectorOpen: boolean;
  layoutBusy: boolean;
  nodeLabelById: Map<string, string>;
  nodeOverlays: NodeOverlay[];
  pinButton: import("react").JSX.Element;
  placeDrawingNode: (
    deviceType: string,
    position: { x: number; y: number },
  ) => void;
  popoverPlacement: "left" | "right" | "corner";
  popoverStyle: import("react").CSSProperties;
  pushState: (next: Topology) => void;
  referenceLines: ReferenceLine[];
  regionMoveMode: "region" | "frame";
  removeBookmark: (name: string) => void;
  removeSelectedObjects: () => Promise<void>;
  revisionsLoading: boolean;
  saveBookmark: () => void;
  savedBindId: string;
  saveStatus: "saved" | "saving" | "unsaved" | "conflict";
  selectedCanvasItem: import("./topologyDocument").TopologyCanvasItem | null;
  selectedCanvasItems: import("./topologyDocument").TopologyCanvasItem[];
  selectedElement: import("./topologyDocument").SelectedElement;
  selectedLink: import("./topologyDocument").TopologyLink | null;
  selectedNode: import("./topologyDocument").TopologyNode | null;
  selectedNodes: import("./topologyDocument").TopologyNode[];
  setAlignmentReferenceId: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setArmedNodeType: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setBindChoice: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setBinding: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setCanvasSelectedElementIds: import("react").Dispatch<
    import("react").SetStateAction<string[]>
  >;
  setCompactMode: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setContextMenu: import("react").Dispatch<
    import("react").SetStateAction<CanvasContextTarget | null>
  >;
  setGridEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setGridSnapEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setOverlayRevision: import("react").Dispatch<
    import("react").SetStateAction<number>
  >;
  setRegionMoveMode: import("react").Dispatch<
    import("react").SetStateAction<"region" | "frame">
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<import("./topologyDocument").SelectedElement>
  >;
  setShowAgent: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowConflict: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowEditbar: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowInterfaces: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowLibrary: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowManualNodeModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowObservation: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setSmartGuidesEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setTopologyDescInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyModalMode: import("react").Dispatch<
    import("react").SetStateAction<"edit" | "create" | null>
  >;
  setTopologyNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setViewOverlayNodeId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setWhiteboardActive: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  showAgent: boolean;
  showEditbar: boolean;
  showInterfaces: boolean;
  showLibrary: boolean;
  showObservation: boolean;
  smartGuidesEnabled: boolean;
  updatePopoverAnchor: () => void;
  viewOverlayNodeId: string;
  viewportRef: import("react").RefObject<HTMLDivElement>;
  whiteboardActive: boolean;
  workspaceId: string;
  workspaceMode: "view" | "edit";
};

export function TopologyCanvasStage({
  activeTopology,
  activeTopologyRef,
  alignmentReferenceId,
  applyBookmark,
  applyDeviceTypeToSelection,
  armedNodeType,
  bindableDevices,
  bindChoice,
  binding,
  bookmarks,
  canvasApiRef,
  canvasMode,
  canvasSelectedElementIds,
  changeReferenceLines,
  compactMode,
  disarmNodeType,
  distributeSelected,
  executeSave,
  exportCanvas,
  future,
  gridEnabled,
  gridSnapEnabled,
  handleAddCanvasItem,
  handleAlignSelectedNodes,
  handleAutoFitCanvasItem,
  handleAutoLayout,
  handleBringCanvasItemToFront,
  handleCloneNode,
  handleDeleteTopology,
  handleFastConnect,
  handleHeaderMouseDown,
  handleJoinZone,
  handleLeaveZone,
  handleLockSelectedNodes,
  handleNetOpsMove,
  handleOpenCreateZone,
  handleOpenRevisions,
  handleOpenWorkbenchChat,
  handleRedo,
  handleRemoveCanvasItem,
  handleRemoveLink,
  handleRemoveNode,
  handleSelectLockGroup,
  handleSelectZoneMembers,
  handleSendCanvasItemToBack,
  handleSetWorkspaceMode,
  handleToggleFullscreen,
  handleToggleWhiteboard,
  handleUndo,
  handleUnlockNode,
  handleUnlockSelectedNodes,
  hasMultiSelection,
  highlightedIds,
  history,
  inspectorRef,
  isDragged,
  isDragging,
  isFullscreen,
  isInspectorOpen,
  layoutBusy,
  nodeLabelById,
  nodeOverlays,
  pinButton,
  placeDrawingNode,
  popoverPlacement,
  popoverStyle,
  pushState,
  referenceLines,
  regionMoveMode,
  removeBookmark,
  removeSelectedObjects,
  revisionsLoading,
  saveBookmark,
  savedBindId,
  saveStatus,
  selectedCanvasItem,
  selectedCanvasItems,
  selectedElement,
  selectedLink,
  selectedNode,
  selectedNodes,
  setAlignmentReferenceId,
  setArmedNodeType,
  setBindChoice,
  setBinding,
  setCanvasMode,
  setCanvasSelectedElementIds,
  setCompactMode,
  setContextMenu,
  setGridEnabled,
  setGridSnapEnabled,
  setIsInspectorOpen,
  setNotice,
  setOverlayRevision,
  setRegionMoveMode,
  setSelectedElement,
  setShowAgent,
  setShowConflict,
  setShowEditbar,
  setShowInterfaces,
  setShowLibrary,
  setShowManualNodeModal,
  setShowObservation,
  setSmartGuidesEnabled,
  setTopologyDescInput,
  setTopologyModalMode,
  setTopologyNameInput,
  setViewOverlayNodeId,
  setWhiteboardActive,
  showAgent,
  showEditbar,
  showInterfaces,
  showLibrary,
  showObservation,
  smartGuidesEnabled,
  updatePopoverAnchor,
  viewOverlayNodeId,
  viewportRef,
  whiteboardActive,
  workspaceId,
  workspaceMode,
}: TopologyCanvasStageProps) {
  return (
    <main
      className="topology-canvas-area"
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* Canvas Toolbar */}
      <TopologyHeaderToolbar
        activeTopology={activeTopology}
        activeTopologyRef={activeTopologyRef}
        executeSave={executeSave}
        exportCanvas={exportCanvas}
        handleDeleteTopology={handleDeleteTopology}
        handleOpenRevisions={handleOpenRevisions}
        handleOpenWorkbenchChat={handleOpenWorkbenchChat}
        handleSetWorkspaceMode={handleSetWorkspaceMode}
        isInspectorOpen={isInspectorOpen}
        revisionsLoading={revisionsLoading}
        saveStatus={saveStatus}
        setIsInspectorOpen={setIsInspectorOpen}
        setShowAgent={setShowAgent}
        setShowConflict={setShowConflict}
        setShowLibrary={setShowLibrary}
        setTopologyDescInput={setTopologyDescInput}
        setTopologyModalMode={setTopologyModalMode}
        setTopologyNameInput={setTopologyNameInput}
        showAgent={showAgent}
        showLibrary={showLibrary}
        workspaceMode={workspaceMode}
      />
      {!isFullscreen && (
        <TopologyEditToolbar
          activeTopology={activeTopology}
          alignmentReferenceId={alignmentReferenceId}
          applyBookmark={applyBookmark}
          armedNodeType={armedNodeType}
          bookmarks={bookmarks}
          canvasApiRef={canvasApiRef}
          canvasMode={canvasMode}
          canvasSelectedElementIds={canvasSelectedElementIds}
          changeReferenceLines={changeReferenceLines}
          compactMode={compactMode}
          future={future}
          gridEnabled={gridEnabled}
          gridSnapEnabled={gridSnapEnabled}
          handleAddCanvasItem={handleAddCanvasItem}
          handleAlignSelectedNodes={handleAlignSelectedNodes}
          handleAutoLayout={handleAutoLayout}
          handleLockSelectedNodes={handleLockSelectedNodes}
          handleOpenCreateZone={handleOpenCreateZone}
          handleRedo={handleRedo}
          handleToggleFullscreen={handleToggleFullscreen}
          handleToggleWhiteboard={handleToggleWhiteboard}
          handleUndo={handleUndo}
          handleUnlockSelectedNodes={handleUnlockSelectedNodes}
          history={history}
          isFullscreen={isFullscreen}
          layoutBusy={layoutBusy}
          nodeOverlays={nodeOverlays}
          referenceLines={referenceLines}
          removeBookmark={removeBookmark}
          saveBookmark={saveBookmark}
          saveStatus={saveStatus}
          selectedNodes={selectedNodes}
          setAlignmentReferenceId={setAlignmentReferenceId}
          setArmedNodeType={setArmedNodeType}
          setCanvasMode={setCanvasMode}
          setCompactMode={setCompactMode}
          setGridEnabled={setGridEnabled}
          setGridSnapEnabled={setGridSnapEnabled}
          setNotice={setNotice}
          setShowEditbar={setShowEditbar}
          setShowInterfaces={setShowInterfaces}
          setShowObservation={setShowObservation}
          setSmartGuidesEnabled={setSmartGuidesEnabled}
          showEditbar={showEditbar}
          showInterfaces={showInterfaces}
          showObservation={showObservation}
          smartGuidesEnabled={smartGuidesEnabled}
          viewportRef={viewportRef}
          whiteboardActive={whiteboardActive}
          workspaceMode={workspaceMode}
        />
      )}

      {/* NetOps Cytoscape canvas, with LZCore topology persistence and evidence kept outside the renderer. */}
      <div
        className={`topology-canvas-viewport mode-${workspaceMode} mode-${canvasMode}`}
        ref={viewportRef}
      >
        <div className="studio-canvas-caption">
          <strong>{activeTopology?.nodes.length || 0} 个节点</strong>
          <span>·</span>
          <span>{activeTopology?.links.length || 0} 条连接</span>
          {workspaceMode === "view" ? (
            <span className="canvas-mode-hint is-view-mode">
              查看模式：拖拽任意位置平移画布 · 滚轮缩放 · 点击元素无响应
            </span>
          ) : (
            <>
              {canvasSelectedElementIds.length > 0 && (
                <button
                  type="button"
                  className="canvas-selection-chip canvas-selection-count"
                  onClick={() => {
                    setShowAgent(false);
                    setIsInspectorOpen(true);
                  }}
                  title="点击查看选中对象操作面板"
                >
                  已选 {canvasSelectedElementIds.length} 个对象 · 查看操作
                </button>
              )}
              <span className="canvas-mode-hint">
                {canvasMode === "connect"
                  ? "连线模式：点击或拖拽连接两台设备 (自动配对接口，Esc 退出)"
                  : armedNodeType
                    ? "点击空白处连续放置设备 (Esc 或右键退出)"
                    : "空白处左键拖拽框选 · 拖动设备移动 · 空格/中键平移 · C 连线"}
              </span>
            </>
          )}
        </div>
        {!activeTopology?.nodes?.length && !armedNodeType && (
          <div className="topology-canvas-onboarding">
            <div className="topology-canvas-onboarding-card">
              <IconBranch size={24} />
              <div>
                <strong>从符号开始建图</strong>
                <p>从左侧图形库点选设备放入画布，再用连线工具把它们接上。</p>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setShowManualNodeModal(true)}
              >
                放入节点
              </Button>
            </div>
          </div>
        )}
        <NetOpsCanvas
          topology={activeTopology}
          nodeObservationStatus={
            showObservation
              ? Object.fromEntries(
                  nodeOverlays.map((item) => [
                    item.node_id,
                    overlayObservationStatus(item),
                  ]),
                )
              : {}
          }
          nodeOverlayLines={
            showObservation
              ? Object.fromEntries(
                  nodeOverlays.map((item) => [
                    item.node_id,
                    overlayCanvasLine(item),
                  ]),
                )
              : {}
          }
          mode={canvasMode}
          interactionMode={workspaceMode}
          gridEnabled={gridEnabled}
          gridSnapEnabled={gridSnapEnabled}
          smartGuidesEnabled={smartGuidesEnabled}
          alignmentReferenceId={alignmentReferenceId}
          referenceLines={referenceLines}
          onReferenceLinesChange={changeReferenceLines}
          moveRegionMembers={regionMoveMode === "region"}
          showInterfaces={showInterfaces}
          compactMode={compactMode}
          onSelectNode={(nodeId) => {
            if (workspaceMode === "view") {
              setViewOverlayNodeId(nodeId);
              return;
            }
            setViewOverlayNodeId("");
            setSelectedElement({ type: "node", nodeId });
            setIsInspectorOpen(!showAgent);
          }}
          onSelectCanvasItem={(itemId) => {
            if (workspaceMode === "view") return;
            setSelectedElement({ type: "canvas_item", itemId });
            setIsInspectorOpen(!showAgent);
          }}
          onSelectLink={(linkId) => {
            if (workspaceMode === "view") return;
            setSelectedElement({ type: "link", linkId });
            setIsInspectorOpen(!showAgent);
          }}
          onClearSelection={() => {
            setViewOverlayNodeId("");
            setSelectedElement(null);
            setIsInspectorOpen(false);
          }}
          onSelectionChange={(ids) => {
            if (workspaceMode === "view") return;
            setCanvasSelectedElementIds(ids);
            if (ids.length === 1) {
              const id = ids[0];
              if (id.startsWith("canvas-"))
                setSelectedElement({
                  type: "canvas_item",
                  itemId: id.slice(7),
                });
              else setSelectedElement({ type: "node", nodeId: id });
              setIsInspectorOpen(!showAgent);
            } else if (!ids.length) {
              setSelectedElement((prev) =>
                prev?.type === "link" ? prev : null,
              );
            } else {
              setSelectedElement(null);
              setIsInspectorOpen(!showAgent);
            }
          }}
          highlightedIds={highlightedIds}
          onMoveElements={handleNetOpsMove}
          onConnect={handleFastConnect}
          armedNodeType={workspaceMode === "view" ? null : armedNodeType}
          onPlaceNodeType={placeDrawingNode}
          onDisarmNodeType={disarmNodeType}
          onReady={(api) => {
            canvasApiRef.current = api;
          }}
          onContextMenu={(target) => {
            if (workspaceMode === "view") return;
            setContextMenu(target);
          }}
          onOpenInspector={() => {
            if (workspaceMode === "view") return;
            setShowAgent(false);
            setIsInspectorOpen(true);
          }}
          onViewportChange={updatePopoverAnchor}
        />
        {workspaceMode === "view" && viewOverlayNodeId && activeTopology ? (
          <aside className="topology-observation-card" aria-label="最近观测">
            {(() => {
              const overlay = nodeOverlays.find(
                (item) => item.node_id === viewOverlayNodeId,
              );
              const node = activeTopology.nodes.find(
                (item) => item.node_id === viewOverlayNodeId,
              );
              return (
                <>
                  <header>
                    <strong>{node?.display_name || "图纸符号"}</strong>
                  </header>
                  <p>
                    {overlay ? overlayCaption(overlay) : "尚未绑定登记设备。"}
                  </p>
                  <p className="observation-hint">
                    绑定和更换在编辑模式完成，不会写入图纸，也不会进入 Skill。
                  </p>
                  <button
                    type="button"
                    onClick={() => setViewOverlayNodeId("")}
                  >
                    关闭
                  </button>
                </>
              );
            })()}
          </aside>
        ) : null}

        <TopologyWhiteboard
          key={`${workspaceId}:${activeTopology?.topology_id}`}
          active={whiteboardActive}
          onClose={() => setWhiteboardActive(false)}
          onExportBackground={() =>
            canvasApiRef.current?.exportPNG({
              full: true,
              scale: 2,
              background: "#ffffff",
            }) || ""
          }
          topologyName={activeTopology?.name}
          topologyId={activeTopology?.topology_id}
          workspaceId={workspaceId}
        />

        {/* Floating Bubble Popover Inspector */}
        {/* 3. Right: Inspector */}
        <aside
          ref={inspectorRef}
          className={`topology-inspector ${isInspectorOpen && !showAgent && workspaceMode === "edit" ? "is-open" : ""} ${isDragged ? "is-dragged" : popoverPlacement ? `placement-${popoverPlacement}` : ""} ${isDragging ? "is-dragging" : ""}`}
          style={popoverStyle}
          aria-label="拓扑详情"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {hasMultiSelection ? (
            <TopologySelectionInspector
              applyDeviceTypeToSelection={applyDeviceTypeToSelection}
              canvasApiRef={canvasApiRef}
              distributeSelected={distributeSelected}
              handleAlignSelectedNodes={handleAlignSelectedNodes}
              handleHeaderMouseDown={handleHeaderMouseDown}
              handleLockSelectedNodes={handleLockSelectedNodes}
              handleOpenCreateZone={handleOpenCreateZone}
              handleUnlockSelectedNodes={handleUnlockSelectedNodes}
              pinButton={pinButton}
              removeSelectedObjects={removeSelectedObjects}
              selectedCanvasItems={selectedCanvasItems}
              selectedNodes={selectedNodes}
            />
          ) : selectedElement?.type === "node" && selectedNode ? (
            <TopologyNodeInspector
              activeTopology={activeTopology}
              bindableDevices={bindableDevices}
              bindChoice={bindChoice}
              binding={binding}
              handleCloneNode={handleCloneNode}
              handleHeaderMouseDown={handleHeaderMouseDown}
              handleJoinZone={handleJoinZone}
              handleLeaveZone={handleLeaveZone}
              handleRemoveNode={handleRemoveNode}
              handleSelectLockGroup={handleSelectLockGroup}
              handleSelectZoneMembers={handleSelectZoneMembers}
              handleUnlockNode={handleUnlockNode}
              nodeLabelById={nodeLabelById}
              nodeOverlays={nodeOverlays}
              pinButton={pinButton}
              pushState={pushState}
              savedBindId={savedBindId}
              selectedNode={selectedNode}
              setBindChoice={setBindChoice}
              setBinding={setBinding}
              setIsInspectorOpen={setIsInspectorOpen}
              setNotice={setNotice}
              setOverlayRevision={setOverlayRevision}
              setSelectedElement={setSelectedElement}
              workspaceId={workspaceId}
            />
          ) : selectedElement?.type === "link" && selectedLink ? (
            <TopologyLinkInspector
              activeTopology={activeTopology}
              handleHeaderMouseDown={handleHeaderMouseDown}
              handleRemoveLink={handleRemoveLink}
              nodeLabelById={nodeLabelById}
              pinButton={pinButton}
              pushState={pushState}
              selectedLink={selectedLink}
              setIsInspectorOpen={setIsInspectorOpen}
              setSelectedElement={setSelectedElement}
            />
          ) : selectedElement?.type === "canvas_item" && selectedCanvasItem ? (
            <TopologyCanvasItemInspector
              activeTopology={activeTopology}
              handleAutoFitCanvasItem={handleAutoFitCanvasItem}
              handleBringCanvasItemToFront={handleBringCanvasItemToFront}
              handleHeaderMouseDown={handleHeaderMouseDown}
              handleRemoveCanvasItem={handleRemoveCanvasItem}
              handleSendCanvasItemToBack={handleSendCanvasItemToBack}
              pinButton={pinButton}
              pushState={pushState}
              regionMoveMode={regionMoveMode}
              selectedCanvasItem={selectedCanvasItem}
              setIsInspectorOpen={setIsInspectorOpen}
              setRegionMoveMode={setRegionMoveMode}
              setSelectedElement={setSelectedElement}
            />
          ) : (
            <div className="inspector-panel">
              <div
                className="inspector-header"
                onMouseDown={handleHeaderMouseDown}
              >
                <div className="inspector-header-left">
                  <span
                    className="inspector-drag-grip"
                    title="按住拖拽移动弹窗"
                  >
                    ⋮⋮
                  </span>
                  <div className="inspector-icon-wrap">
                    <IconEye size={16} style={{ color: "var(--accent)" }} />
                  </div>
                  <div className="inspector-header-titles">
                    <h4>拓扑概览</h4>
                    <span className="inspector-badge">
                      {activeTopology?.name || "未命名拓扑"}
                    </span>
                  </div>
                </div>
                <div className="inspector-header-actions">
                  <Button
                    size="sm"
                    onClick={() => setIsInspectorOpen(false)}
                    aria-label="收起拓扑详情"
                  >
                    <IconClose size={13} />
                  </Button>
                </div>
              </div>

              <div className="inspector-body">
                <div className="inspector-section">
                  <strong>{activeTopology?.name}</strong>
                  <p className="inspector-desc">
                    {activeTopology?.description || "未提供拓扑说明"}
                  </p>
                </div>

                <div className="inspector-section stats-grid">
                  <div className="stat-card">
                    <span className="stat-num">
                      {activeTopology?.nodes?.length || 0}
                    </span>
                    <span className="stat-lbl">拓扑节点</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-num">
                      {activeTopology?.links?.length || 0}
                    </span>
                    <span className="stat-lbl">拓扑链路</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-num">
                      {
                        (activeTopology?.canvas_items || []).filter(
                          (item) => item.kind !== "text",
                        ).length
                      }
                    </span>
                    <span className="stat-lbl">区域容器</span>
                  </div>
                </div>

                <div className="inspector-section">
                  <span className="inspector-label">快捷操作</span>
                  <div className="quick-actions-col">
                    <Button
                      size="sm"
                      icon={<IconEdit size={13} />}
                      onClick={() => {
                        if (activeTopology) {
                          setTopologyModalMode("edit");
                          setTopologyNameInput(activeTopology.name);
                          setTopologyDescInput(activeTopology.description);
                        }
                      }}
                    >
                      修改拓扑基本信息
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      <footer className="studio-statusbar">
        <span>{workspaceMode === "view" ? "查看漫游" : "独立图纸"}</span>
        <span>
          {workspaceMode === "view"
            ? "查看模式 · 点击节点查看最近记录 · 第二行不表示当前正常 · 拖拽平移 · 滚轮缩放"
            : "编辑模式 · 空白拖拽框选 · 空格/中键平移 · 连续点放 · C 极速连线 · ⌘D 克隆"}
        </span>
      </footer>
    </main>
  );
}
