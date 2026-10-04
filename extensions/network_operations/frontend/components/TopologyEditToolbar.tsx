/** TopologyEditToolbar owns its presentation; document writes stay with the workspace controller. */
import {
  IconArrowsIn,
  IconArrowsX,
  IconBox,
  IconExpand,
  IconGrid,
  IconLink,
  IconLock,
  IconMenu,
  IconPencil,
  IconRedo,
  IconUndo,
  IconUnlock,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { type CanvasApi } from "./NetOpsCanvas";
import { overlayObservationStatus, type NodeOverlay } from "./nodeOverlay";
import { type DrawingEdit } from "./topologyCollaboration";
import { TopologyDisplayTools } from "./TopologyDisplayTools";
import type {
  Topology,
  TopologyCanvasItem,
  TopologyNode,
} from "./topologyDocument";
import { LAYOUT_PRESETS, type LayoutAlgorithm } from "./topologyLayout";
import type { ReferenceLine } from "./TopologyReferenceLines";

export type TopologyEditToolbarProps = {
  activeTopology: Topology;
  alignmentReferenceId: string | null;
  applyBookmark: (bookmark: {
    name: string;
    x: number;
    y: number;
    zoom: number;
  }) => void;
  armedNodeType: string | null;
  bookmarks: { name: string; x: number; y: number; zoom: number }[];
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  canvasMode: "select" | "connect";
  canvasSelectedElementIds: string[];
  changeReferenceLines: (lines: ReferenceLine[]) => void;
  compactMode: boolean;
  future: DrawingEdit[];
  gridEnabled: boolean;
  gridSnapEnabled: boolean;
  handleAddCanvasItem: (kind: TopologyCanvasItem["kind"]) => void;
  handleAlignSelectedNodes: (
    direction: "left" | "center" | "right" | "top" | "middle" | "bottom",
  ) => void;
  handleAutoLayout: (algorithm?: LayoutAlgorithm) => Promise<void>;
  handleLockSelectedNodes: () => void;
  handleOpenCreateZone: () => void;
  handleRedo: () => void;
  handleToggleFullscreen: () => void;
  handleToggleWhiteboard: () => void;
  handleUndo: () => void;
  handleUnlockSelectedNodes: () => void;
  history: DrawingEdit[];
  isFullscreen: false;
  layoutBusy: boolean;
  nodeOverlays: NodeOverlay[];
  referenceLines: ReferenceLine[];
  removeBookmark: (name: string) => void;
  saveBookmark: () => void;
  saveStatus: "saved" | "saving" | "unsaved" | "conflict";
  selectedNodes: TopologyNode[];
  setAlignmentReferenceId: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setArmedNodeType: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setCompactMode: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setGridEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setGridSnapEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setShowEditbar: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowInterfaces: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowObservation: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setSmartGuidesEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  showEditbar: boolean;
  showInterfaces: boolean;
  showObservation: boolean;
  smartGuidesEnabled: boolean;
  viewportRef: import("react").RefObject<HTMLDivElement>;
  whiteboardActive: boolean;
  workspaceMode: "edit" | "view";
};

export function TopologyEditToolbar({
  activeTopology,
  alignmentReferenceId,
  applyBookmark,
  armedNodeType,
  bookmarks,
  canvasApiRef,
  canvasMode,
  canvasSelectedElementIds,
  changeReferenceLines,
  compactMode,
  future,
  gridEnabled,
  gridSnapEnabled,
  handleAddCanvasItem,
  handleAlignSelectedNodes,
  handleAutoLayout,
  handleLockSelectedNodes,
  handleOpenCreateZone,
  handleRedo,
  handleToggleFullscreen,
  handleToggleWhiteboard,
  handleUndo,
  handleUnlockSelectedNodes,
  history,
  isFullscreen,
  layoutBusy,
  nodeOverlays,
  referenceLines,
  removeBookmark,
  saveBookmark,
  saveStatus,
  selectedNodes,
  setAlignmentReferenceId,
  setArmedNodeType,
  setCanvasMode,
  setCompactMode,
  setGridEnabled,
  setGridSnapEnabled,
  setNotice,
  setShowEditbar,
  setShowInterfaces,
  setShowObservation,
  setSmartGuidesEnabled,
  showEditbar,
  showInterfaces,
  showObservation,
  smartGuidesEnabled,
  viewportRef,
  whiteboardActive,
  workspaceMode,
}: TopologyEditToolbarProps) {
  return (
    <div className="topology-editbar" role="toolbar" aria-label="拓扑操作">
      {workspaceMode === "edit" && showEditbar ? (
        <div className="studio-edit-tools" role="group" aria-label="画布工具">
          <button
            className="studio-mode-button"
            aria-label="选择"
            aria-pressed={canvasMode === "select" && !armedNodeType}
            onClick={() => {
              setCanvasMode("select");
              setArmedNodeType(null);
            }}
            title="选择模式 (快捷键 V)"
          >
            <IconMenu size={13} />
            选择
          </button>
          <button
            className="studio-mode-button"
            aria-label="连线"
            aria-pressed={canvasMode === "connect"}
            onClick={() => {
              setCanvasMode("connect");
              setArmedNodeType(null);
            }}
            title="极速连线模式 (快捷键 C)"
          >
            <IconLink size={13} />
            连线
          </button>

          <details className="studio-insert-menu" data-toolbar-menu>
            <summary>
              <IconBox size={13} />
              插入
            </summary>
            <div>
              <button
                type="button"
                onClick={() => handleAddCanvasItem("rectangle")}
              >
                矩形区域
              </button>
              <button
                type="button"
                onClick={() => handleAddCanvasItem("ellipse")}
              >
                椭圆标注
              </button>
              <button type="button" onClick={() => handleAddCanvasItem("text")}>
                文本框
              </button>
            </div>
          </details>
        </div>
      ) : (
        <div className="studio-edit-tools">
          <span className="canvas-mode-hint">
            {workspaceMode === "view" ? "查看模式" : "编辑工具已收起"}
          </span>
        </div>
      )}
      <div className="toolbar-right">
        {workspaceMode === "edit" && showEditbar && (
          <div
            className="studio-secondary-tools"
            role="group"
            aria-label="画板与排列"
          >
            <Button
              size="sm"
              variant={whiteboardActive ? "selected" : "default"}
              icon={<IconPencil size={13} />}
              className="annotation-action"
              aria-label={whiteboardActive ? "关闭画板" : "画板批注"}
              onClick={handleToggleWhiteboard}
              title={
                whiteboardActive
                  ? "关闭画板批注"
                  : "开启画板批注：在拓扑上自由画笔、荧光笔、箭头与便签标注"
              }
              aria-pressed={whiteboardActive}
            >
              <span className="annotation-label">
                {whiteboardActive ? "关闭画板" : "画板批注"}
              </span>
            </Button>
            <details className="studio-arrange-menu" data-toolbar-menu>
              <summary>
                <IconArrowsX size={13} />
                排列
              </summary>
              <div>
                <section className="arrange-align">
                  <strong>对齐</strong>
                  <div>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("left")}
                    >
                      左对齐
                    </button>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("center")}
                    >
                      水平居中
                    </button>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("right")}
                    >
                      右对齐
                    </button>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("top")}
                    >
                      顶对齐
                    </button>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("middle")}
                    >
                      垂直居中
                    </button>
                    <button
                      disabled={selectedNodes.length < 2}
                      onClick={() => handleAlignSelectedNodes("bottom")}
                    >
                      底对齐
                    </button>
                  </div>
                </section>
                {selectedNodes.length >= 1 && (
                  <button
                    className="studio-mode-button"
                    type="button"
                    onClick={handleOpenCreateZone}
                    title="根据选中设备边界创建区域"
                  >
                    <IconBox size={13} />
                    编为区域
                  </button>
                )}
                {selectedNodes.length >= 2 && (
                  <button
                    className="studio-mode-button"
                    type="button"
                    onClick={handleLockSelectedNodes}
                    title="固定选中设备相对位置 (拖动其中任意一台时其他设备跟随同样轨迹移动)"
                  >
                    <IconLock size={13} />
                    固定
                  </button>
                )}
                {selectedNodes.length > 0 &&
                  selectedNodes.some((n) => Boolean(n.lock_group)) && (
                    <button
                      className="studio-mode-button"
                      type="button"
                      onClick={handleUnlockSelectedNodes}
                      title="解除选中设备的固定联动"
                    >
                      <IconUnlock size={13} />
                      解除固定
                    </button>
                  )}
                <section className="studio-layout-options">
                  <strong>
                    <IconGrid size={13} />
                    {layoutBusy ? "排布中" : "自动排布"}
                  </strong>
                  <div>
                    {LAYOUT_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        title={preset.hint}
                        disabled={
                          layoutBusy || (activeTopology?.nodes.length || 0) < 2
                        }
                        onClick={() => void handleAutoLayout(preset.id)}
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.hint}</small>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </details>
          </div>
        )}
        <Button
          size="sm"
          icon={<IconUndo size={13} />}
          iconOnly
          aria-label="撤销"
          disabled={!history.length || saveStatus === "conflict"}
          onClick={handleUndo}
          title="撤销 (Ctrl+Z / Cmd+Z)"
        >
          <span className="tool-action-label">撤销</span>
        </Button>
        <Button
          size="sm"
          icon={<IconRedo size={13} />}
          iconOnly
          aria-label="恢复"
          disabled={!future.length || saveStatus === "conflict"}
          onClick={handleRedo}
          title="恢复已撤销的操作 (Ctrl+Y / Cmd+Shift+Z)"
        >
          <span className="tool-action-label">恢复</span>
        </Button>

        <TopologyDisplayTools
          toolsVisible={showEditbar}
          setToolsVisible={setShowEditbar}
          grid={gridEnabled}
          setGrid={setGridEnabled}
          gridSnap={gridSnapEnabled}
          setGridSnap={setGridSnapEnabled}
          smartGuides={smartGuidesEnabled}
          setSmartGuides={setSmartGuidesEnabled}
          interfaces={showInterfaces}
          setInterfaces={setShowInterfaces}
          compact={compactMode}
          setCompact={setCompactMode}
          observation={showObservation}
          setObservation={setShowObservation}
          observationCount={
            nodeOverlays.filter(
              (item) => overlayObservationStatus(item) !== null,
            ).length
          }
          editable={workspaceMode === "edit"}
          referenceLines={referenceLines}
          onChange={changeReferenceLines}
          referenceId={alignmentReferenceId}
          referenceName={
            activeTopology?.nodes.find(
              (node) => node.node_id === alignmentReferenceId,
            )?.display_name
          }
          onClearReference={() => setAlignmentReferenceId(null)}
          onSetReference={() => {
            const ids = canvasSelectedElementIds.filter((id) =>
              activeTopology?.nodes.some((node) => node.node_id === id),
            );
            if (ids.length === 1) setAlignmentReferenceId(ids[0]);
            else setNotice("请选中一台设备作为对齐基准", false);
          }}
          canSetReference={
            canvasSelectedElementIds.filter((id) =>
              activeTopology?.nodes.some((node) => node.node_id === id),
            ).length === 1
          }
          onAddReference={(axis) => {
            const view = canvasApiRef.current?.getViewport();
            const host = viewportRef.current;
            if (!view || !host) return;
            changeReferenceLines([
              ...referenceLines,
              {
                id: crypto.randomUUID(),
                axis,
                position:
                  ((axis === "x" ? host.clientWidth : host.clientHeight) / 2 -
                    view[axis]) /
                  view.zoom,
                locked: false,
              },
            ]);
          }}
          onFit={() => canvasApiRef.current?.fit()}
        >
          <section className="studio-view-options">
            <strong>视图书签</strong>
            <div>
              <button type="button" onClick={saveBookmark}>
                保存当前视图…
              </button>
              {bookmarks.length === 0 && <small>尚未保存视图</small>}
              {bookmarks.map((bookmark) => (
                <span key={bookmark.name} className="view-row">
                  <button type="button" onClick={() => applyBookmark(bookmark)}>
                    {bookmark.name}
                  </button>
                  <button
                    type="button"
                    className="view-remove"
                    aria-label={`删除视图 ${bookmark.name}`}
                    onClick={() => removeBookmark(bookmark.name)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </section>
          <Button
            size="sm"
            variant={isFullscreen ? "selected" : "default"}
            icon={
              isFullscreen ? (
                <IconArrowsIn size={13} />
              ) : (
                <IconExpand size={13} />
              )
            }
            onClick={handleToggleFullscreen}
            title={
              isFullscreen
                ? "退出全屏展示 (Esc / F11)"
                : "全屏展示拓扑图 (快捷键 F11 / 点击体验沉浸大屏)"
            }
            aria-pressed={isFullscreen}
          >
            {isFullscreen ? "退出全屏" : "全屏展示"}
          </Button>
        </TopologyDisplayTools>
      </div>
    </div>
  );
}
