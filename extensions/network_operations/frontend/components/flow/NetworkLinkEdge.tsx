import { memo } from "react";
import {
  type EdgeProps,
  getSmoothStepPath,
  EdgeLabelRenderer,
  BaseEdge,
} from "@xyflow/react";
import type { TopologyLink } from "../TopologyWorkspace";
import { compactInterfaceLabel, canvasLinkDescription } from "../NetOpsCanvas";

export type NetworkLinkEdgeData = {
  link: TopologyLink;
  showInterfaces?: boolean;
  isDark?: boolean;
  edgeStyle?: "solid" | "dashed" | "dotted";
};

const NetworkLinkEdge = memo(function NetworkLinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
  data,
}: EdgeProps) {
  const link = (data as NetworkLinkEdgeData)?.link;
  const showInterfaces = (data as NetworkLinkEdgeData)?.showInterfaces ?? true;
  const isDark = (data as NetworkLinkEdgeData)?.isDark ?? false;
  const edgeStyle = (data as NetworkLinkEdgeData)?.edgeStyle ?? "solid";

  const status = (link?.status as string) || "unknown";
  let strokeColor = isDark ? "#94a3b8" : "#64748b";
  if (status === "up") strokeColor = isDark ? "#77ca9c" : "#147a55";
  else if (status === "down" || status === "failed") strokeColor = isDark ? "#ef7180" : "#bd3040";
  else if (status === "warning") strokeColor = isDark ? "#e2ad4d" : "#a16207";

  let strokeDasharray: string | undefined;
  if (edgeStyle === "dotted") strokeDasharray = "3, 6";
  else if (edgeStyle === "dashed") strokeDasharray = "8, 6";

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  const description = link ? canvasLinkDescription(link) : "";
  const srcPort = link?.source_interface ? compactInterfaceLabel(link.source_interface) : "";
  const tgtPort = link?.target_interface ? compactInterfaceLabel(link.target_interface) : "";

  const getPortOffset = (pos: string) => {
    switch (pos) {
      case "top": return { x: 0, y: -16 };
      case "bottom": return { x: 0, y: 16 };
      case "left": return { x: -24, y: 0 };
      case "right": return { x: 24, y: 0 };
      default: return { x: 0, y: 0 };
    }
  };

  const srcOffset = getPortOffset(sourcePosition);
  const tgtOffset = getPortOffset(targetPosition);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? "var(--accent, #0f7773)" : strokeColor,
          strokeWidth: selected ? 3.5 : 2.5,
          strokeDasharray,
          transition: "stroke 0.15s ease, stroke-width 0.15s ease",
        }}
      />

      {/* Option C: Modular RJ45 Socket Blocks at Connection Endpoints */}
      <svg className="flow-socket-overlay">
        <rect
          x={sourceX - 4.5}
          y={sourceY - 4.5}
          width={9}
          height={9}
          rx={2}
          ry={2}
          fill={selected ? "var(--accent, #0f7773)" : strokeColor}
          stroke={isDark ? "#1e293b" : "#ffffff"}
          strokeWidth={1.5}
          className="flow-socket-block"
        />
        <rect
          x={targetX - 4.5}
          y={targetY - 4.5}
          width={9}
          height={9}
          rx={2}
          ry={2}
          fill={selected ? "var(--accent, #0f7773)" : strokeColor}
          stroke={isDark ? "#1e293b" : "#ffffff"}
          strokeWidth={1.5}
          className="flow-socket-block"
        />
      </svg>

      {/* HTML Labels via EdgeLabelRenderer */}
      <EdgeLabelRenderer>
        {/* Source Interface Tag */}
        {showInterfaces && srcPort && (
          <div
            className="flow-interface-tag nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${sourceX + srcOffset.x}px, ${sourceY + srcOffset.y}px)`,
            }}
          >
            {srcPort}
          </div>
        )}

        {/* Target Interface Tag */}
        {showInterfaces && tgtPort && (
          <div
            className="flow-interface-tag nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${targetX + tgtOffset.x}px, ${targetY + tgtOffset.y}px)`,
            }}
          >
            {tgtPort}
          </div>
        )}

        {/* Midpoint Link Description */}
        {description && (
          <div
            className="flow-link-description-tag nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {description}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});

export default NetworkLinkEdge;
