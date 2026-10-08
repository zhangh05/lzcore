/** TopologyLibrary owns its presentation; document writes stay with the workspace controller. */
import { type DragEvent } from "react";
import { IconClose, IconPlus } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { type CanvasApi } from "./NetOpsCanvas";
import { DRAWING_DEVICE_TYPES } from "./topologyDevicePalette";
import type {
  SelectedElement,
  Topology,
  TopologyNode,
} from "./topologyDocument";
import { DeviceTypeIcon } from "./TopologyItemControls";

export type TopologyLibraryProps = {
  /** Closes the library; the button only shows when it is a narrow-width drawer. */
  onClose?: () => void;
  activeTopology: Topology;
  armedNodeType: string | null;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  handleOpenCreateZone: () => void;
  handleTypeDragStart: (
    event: DragEvent<HTMLElement>,
    deviceType: string,
  ) => void;
  saveStatus: "saved" | "saving" | "unsaved" | "conflict";
  selectedElement: SelectedElement;
  selectedNodes: TopologyNode[];
  selectedTopologyId: string;
  setArmedNodeType: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setManualNodeName: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setManualNodeType: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setSelectedTopologyId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setShowManualNodeModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setTopologyDescInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyModalMode: import("react").Dispatch<
    import("react").SetStateAction<"create" | "edit" | null>
  >;
  setTopologyNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  topologies: Topology[];
};

export function TopologyLibrary({
  onClose,
  activeTopology,
  armedNodeType,
  canvasApiRef,
  handleOpenCreateZone,
  handleTypeDragStart,
  saveStatus,
  selectedElement,
  selectedNodes,
  selectedTopologyId,
  setArmedNodeType,
  setCanvasMode,
  setManualNodeName,
  setManualNodeType,
  setSelectedElement,
  setSelectedTopologyId,
  setShowManualNodeModal,
  setTopologyDescInput,
  setTopologyModalMode,
  setTopologyNameInput,
  topologies,
}: TopologyLibraryProps) {
  return (
    <aside className="topology-sidebar">
      <div className="topology-sidebar-section topology-select-section">
        <div className="section-title-row">
          <span className="section-title">网络拓扑 ({topologies.length})</span>
          <Button
            size="sm"
            icon={<IconPlus size={12} />}
            onClick={() => {
              setTopologyModalMode("create");
              setTopologyNameInput("");
              setTopologyDescInput("");
            }}
          >
            新建
          </Button>
          {onClose && (
            <Button
              size="sm"
              className="topology-library-close"
              aria-label="关闭设备库"
              data-sheet-close=""
              onClick={onClose}
            >
              <IconClose size={14} />
            </Button>
          )}
        </div>
        <div className="topology-dropdown-wrap">
          <select
            aria-label="选择网络拓扑"
            value={selectedTopologyId}
            disabled={saveStatus !== "saved"}
            onChange={(e) => {
              setSelectedTopologyId(e.target.value);
              setSelectedElement(null);
            }}
            className="topology-select-control"
          >
            {topologies.map((t) => (
              <option key={t.topology_id} value={t.topology_id}>
                {t.name} ({t.nodes.length} 节点)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Drawing-device palette. Type first, asset second: eNSP and HCL both
            lead with the model palette, because sketching a topology starts
            from "a firewall goes here", not from "which firewall is it". */}
      <div className="topology-sidebar-section palette-type-section">
        <div className="section-title-row">
          <span className="section-title">图纸设备</span>
          <small className="section-subtitle">
            {armedNodeType ? "已选中 · 待放置" : "点选后在画布单击"}
          </small>
        </div>
        <div className="palette-type-grid">
          {DRAWING_DEVICE_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              className={`palette-type-item ${armedNodeType === type.value ? "is-armed" : ""}`}
              data-testid={`palette-type-${type.value}`}
              aria-pressed={armedNodeType === type.value}
              draggable
              onDragStart={(event) => handleTypeDragStart(event, type.value)}
              onClick={() => {
                setCanvasMode("select");
                setArmedNodeType((current) =>
                  current === type.value ? null : type.value,
                );
              }}
              title={`${type.label}：点选后在画布空白处单击放置，或直接拖到画布上`}
            >
              <DeviceTypeIcon deviceType={type.value} size={16} />
              <span>{type.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="palette-type-more"
          onClick={() => {
            setManualNodeName("");
            setManualNodeType("switch");
            setShowManualNodeModal(true);
          }}
        >
          需要先定名称？新建图纸设备…
        </button>
      </div>

      {/* Smart Zones Palette */}
      <div className="topology-sidebar-section palette-group-section">
        <div className="section-title-row">
          <span className="section-title">
            智能区域 (
            {
              (activeTopology?.canvas_items || []).filter(
                (ci) => ci.kind === "rectangle" || ci.kind === "ellipse",
              ).length
            }
            )
          </span>
          <Button
            size="sm"
            icon={<IconPlus size={12} />}
            onClick={handleOpenCreateZone}
            title={
              selectedNodes.length
                ? "将当前选中的设备编为新区域"
                : "框选设备后可直接一键编为智能区域"
            }
          >
            新建区域
          </Button>
        </div>
        <div className="palette-group-list">
          {(activeTopology?.canvas_items || []).filter(
            (ci) => ci.kind === "rectangle" || ci.kind === "ellipse",
          ).length ? (
            (activeTopology?.canvas_items || [])
              .filter((ci) => ci.kind === "rectangle" || ci.kind === "ellipse")
              .map((ci) => {
                const memberCount = (activeTopology?.nodes || []).filter(
                  (n) => n.region_id === ci.item_id,
                ).length;
                const isSelected =
                  selectedElement?.type === "canvas_item" &&
                  selectedElement.itemId === ci.item_id;
                const tagColor = ci.style?.border || "var(--accent)";
                return (
                  <div
                    key={ci.item_id}
                    className={`palette-group-item ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      setSelectedElement({
                        type: "canvas_item",
                        itemId: ci.item_id,
                      });
                      canvasApiRef.current?.selectElements?.([
                        `canvas-${ci.item_id}`,
                      ]);
                    }}
                    title="点击在画布上高亮选中该区域底框"
                  >
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: tagColor,
                        flexShrink: 0,
                      }}
                    />
                    <span className="palette-group-name">
                      {ci.text || "未命名区域"}
                    </span>
                    <span className="group-kind-tag">
                      {memberCount
                        ? `${memberCount}台`
                        : ci.kind === "ellipse"
                          ? "椭圆"
                          : "矩形"}
                    </span>
                  </div>
                );
              })
          ) : (
            <div className="palette-empty-groups">
              暂无区域，框选设备点“编为区域”
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
