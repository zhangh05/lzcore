/** TopologySelectionInspector owns its presentation; document writes stay with the workspace controller. */
import {
  IconBox,
  IconClose,
  IconLock,
  IconTrash,
  IconUnlock,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { type CanvasApi } from "./NetOpsCanvas";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import { batchTypeOptions } from "./topologyDevicePalette";
import type { TopologyCanvasItem, TopologyNode } from "./topologyDocument";

export type TopologySelectionInspectorProps = {
  applyDeviceTypeToSelection: (deviceType: string) => void;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  distributeSelected: (axis: "horizontal" | "vertical") => void;
  handleAlignSelectedNodes: (
    direction: "left" | "center" | "right" | "top" | "middle" | "bottom",
  ) => void;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleLockSelectedNodes: () => void;
  handleOpenCreateZone: () => void;
  handleUnlockSelectedNodes: () => void;
  pinButton: import("react").JSX.Element;
  removeSelectedObjects: () => Promise<void>;
  selectedCanvasItems: TopologyCanvasItem[];
  selectedNodes: TopologyNode[];
};

export function TopologySelectionInspector({
  applyDeviceTypeToSelection,
  canvasApiRef,
  distributeSelected,
  handleAlignSelectedNodes,
  handleHeaderMouseDown,
  handleLockSelectedNodes,
  handleOpenCreateZone,
  handleUnlockSelectedNodes,
  pinButton,
  removeSelectedObjects,
  selectedCanvasItems,
  selectedNodes,
}: TopologySelectionInspectorProps) {
  return (
    <div className="inspector-panel">
      <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
        <div className="inspector-header-left">
          <span className="inspector-drag-grip" title="按住拖拽移动弹窗">
            ⋮⋮
          </span>
          <div className="inspector-icon-wrap">
            <IconBox size={16} style={{ color: "var(--accent)" }} />
          </div>
          <div className="inspector-header-titles">
            <h4>
              已选 {selectedNodes.length + selectedCanvasItems.length} 个对象
            </h4>
            <span className="inspector-badge">
              {selectedNodes.length} 台设备 · {selectedCanvasItems.length}{" "}
              个图元
            </span>
          </div>
        </div>
        <div className="inspector-header-actions">
          {pinButton}
          <Button
            size="sm"
            onClick={() => canvasApiRef.current?.clearSelection()}
            aria-label="取消选择"
          >
            <IconClose size={13} />
          </Button>
        </div>
      </div>
      <div className="inspector-body">
        <div className="inspector-section">
          <span className="inspector-label">对齐</span>
          <div className="batch-grid">
            {(
              [
                ["left", "左对齐"],
                ["center", "水平居中"],
                ["right", "右对齐"],
                ["top", "顶对齐"],
                ["middle", "垂直居中"],
                ["bottom", "底对齐"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                onClick={() => handleAlignSelectedNodes(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <span className="inspector-label">分布</span>
          <div className="batch-grid">
            <Button size="sm" onClick={() => distributeSelected("horizontal")}>
              水平等距
            </Button>
            <Button size="sm" onClick={() => distributeSelected("vertical")}>
              垂直等距
            </Button>
          </div>
          {selectedNodes.length >= 1 && (
            <>
              <span className="inspector-label">智能区域</span>
              <div className="batch-grid">
                <Button
                  size="sm"
                  variant="default"
                  icon={<IconBox size={13} />}
                  onClick={handleOpenCreateZone}
                  title="依据选中设备的坐标范围与呼吸留白，自动计算并生成贴合底框"
                >
                  编为智能区域底框
                </Button>
              </div>
            </>
          )}
          <span className="inspector-label">固定联动</span>
          <div className="batch-grid">
            <Button
              size="sm"
              variant="default"
              icon={<IconLock size={13} />}
              onClick={handleLockSelectedNodes}
              title="固定选中设备的相对位置，拖动其中任意一台，其他设备跟随同样轨迹移动"
            >
              固定选中设备
            </Button>
            {selectedNodes.some((n) => Boolean(n.lock_group)) && (
              <Button
                size="sm"
                icon={<IconUnlock size={13} />}
                onClick={handleUnlockSelectedNodes}
                title="解除选中设备的固定联动"
              >
                解除固定
              </Button>
            )}
          </div>
          <span className="inspector-label">批量设置设备类型</span>
          <div
            className="batch-type-grid"
            role="group"
            aria-label="批量设置设备类型选项"
          >
            {batchTypeOptions.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="batch-type-chip"
                onClick={() => applyDeviceTypeToSelection(value)}
                title={`将选中设备批量设置为 ${label}`}
              >
                <img
                  src={netOpsIconForDeviceType(value)}
                  alt=""
                  className="batch-type-chip-icon"
                />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <select
            aria-label="批量设置设备类型"
            className="visually-hidden"
            defaultValue=""
            tabIndex={-1}
            onChange={(event) => {
              if (event.target.value)
                applyDeviceTypeToSelection(event.target.value);
              event.target.value = "";
            }}
          >
            <option value="">选择类型…</option>
            {batchTypeOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="inspector-label">危险操作</span>
          <Button
            size="sm"
            variant="danger"
            icon={<IconTrash size={13} />}
            onClick={() => void removeSelectedObjects()}
          >
            移除选中的对象
          </Button>
        </div>
      </div>
    </div>
  );
}
