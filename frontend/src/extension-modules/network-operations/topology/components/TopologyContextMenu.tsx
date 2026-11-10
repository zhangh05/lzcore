/** TopologyContextMenu owns its presentation; document writes stay with the workspace controller. */
import { type CanvasApi, type CanvasContextTarget } from "./NetOpsCanvas";
import type {
  SelectedElement,
  Topology,
  TopologyCanvasItem,
  TopologyNode,
} from "./topologyDocument";
import { type LayoutAlgorithm } from "./topologyLayout";

export type TopologyContextMenuProps = {
  activeTopology: Topology;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  contextMenu: CanvasContextTarget;
  handleAddCanvasItem: (kind: TopologyCanvasItem["kind"]) => void;
  handleAutoFitCanvasItem: (itemId: string) => void;
  handleAutoLayout: (algorithm?: LayoutAlgorithm) => Promise<void>;
  handleBringCanvasItemToFront: (itemId: string) => void;
  handleCloneNode: (nodeId: string) => void;
  handleLockSelectedNodes: () => void;
  handleOpenCreateZone: () => void;
  handleRemoveCanvasItem: (itemId: string) => Promise<void>;
  handleRemoveLink: (linkId: string) => Promise<void>;
  handleRemoveNode: (nodeId: string) => Promise<void>;
  handleSelectLockGroup: (nodeId: string) => void;
  handleSendCanvasItemToBack: (itemId: string) => void;
  handleUnlockNode: (nodeId: string) => void;
  handleUnlockSelectedNodes: () => void;
  nodeLabelById: Map<string, string>;
  openLinkComposer: (sourceId?: string, targetId?: string) => void;
  selectedNodes: TopologyNode[];
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setContextMenu: import("react").Dispatch<
    import("react").SetStateAction<CanvasContextTarget | null>
  >;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setShowAgent: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function TopologyContextMenu({
  activeTopology,
  canvasApiRef,
  contextMenu,
  handleAddCanvasItem,
  handleAutoFitCanvasItem,
  handleAutoLayout,
  handleBringCanvasItemToFront,
  handleCloneNode,
  handleLockSelectedNodes,
  handleOpenCreateZone,
  handleRemoveCanvasItem,
  handleRemoveLink,
  handleRemoveNode,
  handleSelectLockGroup,
  handleSendCanvasItemToBack,
  handleUnlockNode,
  handleUnlockSelectedNodes,
  nodeLabelById,
  openLinkComposer,
  selectedNodes,
  setCanvasMode,
  setContextMenu,
  setIsInspectorOpen,
  setNotice,
  setSelectedElement,
  setShowAgent,
}: TopologyContextMenuProps) {
  return (
    <div
      className="canvas-context-menu"
      style={{
        left: Math.max(
          12,
          Math.min(
            contextMenu.x,
            (typeof window !== "undefined" ? window.innerWidth : 1200) - 180,
          ),
        ),
        top: Math.max(
          12,
          Math.min(
            contextMenu.y,
            (typeof window !== "undefined" ? window.innerHeight : 800) - 260,
          ),
        ),
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {contextMenu.kind === "node" &&
        (() => {
          const node = activeTopology?.nodes.find(
            (n) => n.node_id === contextMenu.id,
          );
          const isSelectedInMulti =
            selectedNodes.length >= 2 &&
            selectedNodes.some((n) => n.node_id === contextMenu.id);
          return (
            <>
              <button
                type="button"
                onClick={() => {
                  setCanvasMode("connect");
                  canvasApiRef.current?.startConnectFrom?.(contextMenu.id);
                  setContextMenu(null);
                  const sLabel =
                    nodeLabelById.get(contextMenu.id) || contextMenu.id;
                  setNotice(
                    `已选择起点设备“${sLabel}”，请点击目标设备完成连线 (Esc 取消)`,
                  );
                }}
              >
                从此处连线 (C)
              </button>
              <button
                type="button"
                onClick={() => {
                  openLinkComposer(contextMenu.id);
                  setContextMenu(null);
                }}
              >
                高级连线 (指定端口)...
              </button>
              <button
                type="button"
                onClick={() => {
                  handleCloneNode(contextMenu.id);
                  setContextMenu(null);
                }}
              >
                克隆设备 (⌘D)
              </button>
              {isSelectedInMulti ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      handleLockSelectedNodes();
                      setContextMenu(null);
                    }}
                  >
                    固定选中设备相对位置
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleOpenCreateZone();
                      setContextMenu(null);
                    }}
                  >
                    编为智能区域底框
                  </button>
                  {selectedNodes.some((n) => Boolean(n.lock_group)) && (
                    <button
                      type="button"
                      onClick={() => {
                        handleUnlockSelectedNodes();
                        setContextMenu(null);
                      }}
                    >
                      解除选中设备固定
                    </button>
                  )}
                </>
              ) : node?.lock_group ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      handleSelectLockGroup(contextMenu.id);
                      setContextMenu(null);
                    }}
                  >
                    选中同组固定设备
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleUnlockNode(contextMenu.id);
                      setContextMenu(null);
                    }}
                  >
                    解除当前设备固定联动
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setSelectedElement({ type: "node", nodeId: contextMenu.id });
                  setShowAgent(false);
                  setIsInspectorOpen(true);
                  setContextMenu(null);
                }}
              >
                打开设备详情
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void handleRemoveNode(contextMenu.id);
                  setContextMenu(null);
                }}
              >
                从拓扑移除
              </button>
            </>
          );
        })()}
      {contextMenu.kind === "link" && (
        <>
          <button
            type="button"
            onClick={() => {
              setSelectedElement({ type: "link", linkId: contextMenu.id });
              setShowAgent(false);
              setIsInspectorOpen(true);
              setContextMenu(null);
            }}
          >
            编辑链路
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              void handleRemoveLink(contextMenu.id);
              setContextMenu(null);
            }}
          >
            删除链路
          </button>
        </>
      )}
      {contextMenu.kind === "canvas_item" &&
        (() => {
          const rawId = contextMenu.id.replace(/^canvas-/, "");
          return (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelectedElement({ type: "canvas_item", itemId: rawId });
                  setShowAgent(false);
                  setIsInspectorOpen(true);
                  setContextMenu(null);
                }}
              >
                编辑图元
              </button>
              <button
                type="button"
                onClick={() => {
                  handleAutoFitCanvasItem(rawId);
                  setContextMenu(null);
                }}
              >
                自动包住区域节点
              </button>
              <button
                type="button"
                onClick={() => {
                  handleSendCanvasItemToBack(rawId);
                  setContextMenu(null);
                }}
              >
                置于底层
              </button>
              <button
                type="button"
                onClick={() => {
                  handleBringCanvasItemToFront(rawId);
                  setContextMenu(null);
                }}
              >
                置于顶层
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void handleRemoveCanvasItem(rawId);
                  setContextMenu(null);
                }}
              >
                删除图元
              </button>
            </>
          );
        })()}
      {contextMenu.kind === "canvas" && (
        <>
          <button
            type="button"
            onClick={() => {
              canvasApiRef.current?.selectAll();
              setContextMenu(null);
            }}
          >
            全选对象
          </button>
          <button
            type="button"
            onClick={() => {
              canvasApiRef.current?.fit();
              setContextMenu(null);
            }}
          >
            适配视图
          </button>
          <button
            type="button"
            onClick={() => {
              void handleAutoLayout();
              setContextMenu(null);
            }}
          >
            自动排布
          </button>
          <hr />
          <button
            type="button"
            onClick={() => {
              handleAddCanvasItem("rectangle");
              setContextMenu(null);
            }}
          >
            插入矩形区域
          </button>
          {/* All three shapes were reachable from the inspector's type
                  selector, but only two could be created here — an ellipse had
                  to be drawn as a rectangle first and then retyped. */}
          <button
            type="button"
            onClick={() => {
              handleAddCanvasItem("ellipse");
              setContextMenu(null);
            }}
          >
            插入椭圆标注
          </button>
          <button
            type="button"
            onClick={() => {
              handleAddCanvasItem("text");
              setContextMenu(null);
            }}
          >
            插入文本框
          </button>
        </>
      )}
    </div>
  );
}
