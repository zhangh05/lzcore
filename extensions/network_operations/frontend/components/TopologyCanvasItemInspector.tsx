/** TopologyCanvasItemInspector owns its presentation; document writes stay with the workspace controller. */
import {
  IconBox,
  IconClose,
  IconTrash,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import {
  canvasItemStylePreset,
  canvasItemStylePresets,
} from "./topologyDevicePalette";
import type {
  SelectedElement,
  Topology,
  TopologyCanvasItem,
} from "./topologyDocument";
import { CanvasItemDimensionInputs } from "./TopologyItemControls";
import { regionContains } from "./topologyRegions";

export type TopologyCanvasItemInspectorProps = {
  activeTopology: Topology;
  handleAutoFitCanvasItem: (itemId: string) => void;
  handleBringCanvasItemToFront: (itemId: string) => void;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleRemoveCanvasItem: (itemId: string) => Promise<void>;
  handleSendCanvasItemToBack: (itemId: string) => void;
  pinButton: import("react").JSX.Element;
  pushState: (next: Topology) => void;
  regionMoveMode: "region" | "frame";
  selectedCanvasItem: TopologyCanvasItem;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setRegionMoveMode: import("react").Dispatch<
    import("react").SetStateAction<"region" | "frame">
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
};

export function TopologyCanvasItemInspector({
  activeTopology,
  handleAutoFitCanvasItem,
  handleBringCanvasItemToFront,
  handleHeaderMouseDown,
  handleRemoveCanvasItem,
  handleSendCanvasItemToBack,
  pinButton,
  pushState,
  regionMoveMode,
  selectedCanvasItem,
  setIsInspectorOpen,
  setRegionMoveMode,
  setSelectedElement,
}: TopologyCanvasItemInspectorProps) {
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
            <h4>图纸图元 · {selectedCanvasItem.text || "未命名图元"}</h4>
            <span className="inspector-badge">
              {selectedCanvasItem.kind === "text"
                ? "文本标签"
                : selectedCanvasItem.kind === "ellipse"
                  ? "椭圆区域"
                  : "矩形区域"}
            </span>
          </div>
        </div>
        <div className="inspector-header-actions">
          {pinButton}
          <Button
            size="sm"
            onClick={() => {
              setSelectedElement(null);
              setIsInspectorOpen(false);
            }}
            aria-label="收起图元详情"
          >
            <IconClose size={13} />
          </Button>
        </div>
      </div>

      <div className="inspector-body">
        <div className="inspector-section">
          <label className="inspector-field">
            图元类型
            <select
              aria-label="图元类型"
              value={selectedCanvasItem.kind}
              onChange={(e) => {
                if (!activeTopology) return;
                const kind = e.target.value as TopologyCanvasItem["kind"];
                pushState({
                  ...activeTopology,
                  nodes:
                    kind === "text"
                      ? activeTopology.nodes.map((node) =>
                          node.region_id === selectedCanvasItem.item_id
                            ? { ...node, region_id: null }
                            : node,
                        )
                      : activeTopology.nodes,
                  canvas_items: (activeTopology.canvas_items || []).map(
                    (item) =>
                      item.item_id === selectedCanvasItem.item_id
                        ? { ...item, kind }
                        : item,
                  ),
                });
              }}
            >
              <option value="rectangle">矩形区域</option>
              <option value="ellipse">椭圆标注</option>
              <option value="text">文本框</option>
            </select>
          </label>

          <label className="inspector-field">
            文本内容
            <textarea
              value={selectedCanvasItem.text}
              rows={2}
              maxLength={240}
              placeholder={
                selectedCanvasItem.kind === "text"
                  ? "输入说明文字"
                  : "如：核心业务区"
              }
              onChange={(e) => {
                if (!activeTopology) return;
                const text = e.target.value;
                pushState({
                  ...activeTopology,
                  canvas_items: (activeTopology.canvas_items || []).map(
                    (item) =>
                      item.item_id === selectedCanvasItem.item_id
                        ? { ...item, text }
                        : item,
                  ),
                });
              }}
            />
          </label>

          <label className="inspector-field">
            图元样式
            <select
              value={canvasItemStylePreset(selectedCanvasItem.style)}
              onChange={(e) => {
                if (!activeTopology || e.target.value === "custom") return;
                const preset =
                  canvasItemStylePresets[
                    e.target.value as keyof typeof canvasItemStylePresets
                  ];
                pushState({
                  ...activeTopology,
                  canvas_items: (activeTopology.canvas_items || []).map(
                    (item) =>
                      item.item_id === selectedCanvasItem.item_id
                        ? { ...item, style: { ...preset.style } }
                        : item,
                  ),
                });
              }}
            >
              <option value="custom">自定义（保留当前）</option>
              {Object.entries(canvasItemStylePresets).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <div className="inspector-dimension-section">
            <CanvasItemDimensionInputs
              item={selectedCanvasItem}
              onChange={(patch) => {
                if (!activeTopology) return;
                pushState({
                  ...activeTopology,
                  canvas_items: (activeTopology.canvas_items || []).map(
                    (item) =>
                      item.item_id === selectedCanvasItem.item_id
                        ? { ...item, ...patch, auto_fit: false }
                        : item,
                  ),
                });
              }}
            />
            <div className="dimension-presets">
              {(selectedCanvasItem.kind === "text"
                ? [
                    { label: "单行", w: 180, h: 36 },
                    { label: "双行", w: 220, h: 56 },
                    { label: "段落", w: 280, h: 90 },
                  ]
                : [
                    { label: "紧凑", w: 180, h: 90 },
                    { label: "标准", w: 260, h: 140 },
                    { label: "广域", w: 380, h: 220 },
                  ]
              ).map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="dimension-chip"
                  onClick={() => {
                    if (!activeTopology) return;
                    pushState({
                      ...activeTopology,
                      canvas_items: (activeTopology.canvas_items || []).map(
                        (item) =>
                          item.item_id === selectedCanvasItem.item_id
                            ? {
                                ...item,
                                auto_fit: false,
                                width: preset.w,
                                height: preset.h,
                              }
                            : item,
                      ),
                    });
                  }}
                  title={`快捷设置为 ${preset.w} × ${preset.h} 像素`}
                >
                  {preset.label} ({preset.w}×{preset.h})
                </button>
              ))}
            </div>

            {selectedCanvasItem.kind !== "text" && (
              <div
                style={{
                  marginTop: "12px",
                  paddingTop: "10px",
                  borderTop: "1px dashed var(--line, #e2e8f0)",
                }}
              >
                <span
                  className="inspector-label"
                  style={{
                    fontWeight: 600,
                    display: "block",
                    marginBottom: "6px",
                  }}
                >
                  区域排版与层级
                </span>
                <label className="inspector-field">
                  拖动与键盘移动
                  <select
                    value={regionMoveMode}
                    onChange={(event) =>
                      setRegionMoveMode(
                        event.target.value as "region" | "frame",
                      )
                    }
                  >
                    <option value="region">整体移动区域与成员</option>
                    <option value="frame">只移动边框（固定尺寸）</option>
                  </select>
                </label>
                <p className="inspector-label">
                  尺寸模式：
                  {selectedCanvasItem.auto_fit === true
                    ? "随绑定成员自动包围"
                    : "固定边框"}{" "}
                  · 成员按 ID 绑定
                </p>

                <p className="inspector-label">
                  绑定{" "}
                  {
                    (activeTopology?.nodes || []).filter(
                      (n) => n.region_id === selectedCanvasItem.item_id,
                    ).length
                  }{" "}
                  台设备 · 估算越界{" "}
                  {
                    (activeTopology?.nodes || []).filter(
                      (n) =>
                        n.region_id === selectedCanvasItem.item_id &&
                        !regionContains(selectedCanvasItem, n),
                    ).length
                  }{" "}
                  台（图标与标签需视觉核对）
                </p>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <Button
                    size="sm"
                    onClick={() =>
                      handleAutoFitCanvasItem(selectedCanvasItem.item_id)
                    }
                    title="根据区域内的设备自动调整区域框大小与中心位置"
                  >
                    自动包住区域节点
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      handleSendCanvasItemToBack(selectedCanvasItem.item_id)
                    }
                    title="将图元置于最底层"
                  >
                    置于底层
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      handleBringCanvasItemToFront(selectedCanvasItem.item_id)
                    }
                    title="将图元置于最顶层"
                  >
                    置于顶层
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="inspector-actions">
          <Button
            variant="danger"
            icon={<IconTrash size={13} />}
            onClick={() =>
              void handleRemoveCanvasItem(selectedCanvasItem.item_id)
            }
          >
            删除图纸图元
          </Button>
        </div>
      </div>
    </div>
  );
}
