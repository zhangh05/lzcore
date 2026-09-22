import { memo } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { TopologyCanvasItem, TopologyGroup } from "../TopologyWorkspace";

export type CanvasItemNodeData = {
  item?: TopologyCanvasItem;
  group?: TopologyGroup;
  isDark?: boolean;
};

export type CanvasItemNodeType = Node<CanvasItemNodeData, "canvas_item">;

const CanvasItemNode = memo(function CanvasItemNode({
  data,
  selected,
}: NodeProps<CanvasItemNodeType>) {
  const { item, group, isDark = false } = data;

  if (group) {
    return (
      <div
        className={`flow-canvas-group-container ${selected ? "is-selected" : ""}`}
        style={{
          width: group.width || 300,
          height: group.height || 200,
          borderColor: isDark ? "rgba(255, 255, 255, 0.15)" : "#cbd5e1",
          backgroundColor: isDark ? "rgba(15, 23, 42, 0.35)" : "rgba(248, 250, 252, 0.45)",
        }}
      >
        <div className="flow-canvas-group-header">
          <span className="flow-canvas-group-badge">{group.name || "未命名分组"}</span>
        </div>
      </div>
    );
  }

  if (!item) return null;

  const width = item.width || 120;
  const height = item.height || 60;
  const fill = item.style?.fill || (isDark ? "#1e293b" : "#f1f5f9");
  const border = item.style?.border || (isDark ? "#475569" : "#cbd5e1");
  const color = item.style?.color || (isDark ? "#f8fafc" : "#0f172a");

  if (item.kind === "text") {
    return (
      <div
        className={`flow-canvas-item flow-canvas-text ${selected ? "is-selected" : ""}`}
        style={{ width, height, color }}
      >
        <span className="flow-text-content">{item.text || "文本标注"}</span>
      </div>
    );
  }

  if (item.kind === "ellipse") {
    return (
      <div
        className={`flow-canvas-item flow-canvas-ellipse ${selected ? "is-selected" : ""}`}
        style={{
          width,
          height,
          backgroundColor: fill,
          borderColor: border,
          borderRadius: "50%",
          color,
        }}
      >
        {item.text && <span className="flow-item-text">{item.text}</span>}
      </div>
    );
  }

  // Default rectangle
  return (
    <div
      className={`flow-canvas-item flow-canvas-rect ${selected ? "is-selected" : ""}`}
      style={{
        width,
        height,
        backgroundColor: fill,
        borderColor: border,
        borderRadius: 8,
        color,
      }}
    >
      {item.text && <span className="flow-item-text">{item.text}</span>}
    </div>
  );
});

export default CanvasItemNode;
