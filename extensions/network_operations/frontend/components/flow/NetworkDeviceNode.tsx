import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { TopologyNode } from "../TopologyWorkspace";
import { netOpsIconForDeviceType } from "../netopsCanvasAssets";
import { nodeStatusColors, type NodeRuntimeStatus } from "../NetOpsCanvas";

export type NetworkDeviceNodeData = {
  node: TopologyNode;
  label?: string;
  deviceType?: string;
  status?: NodeRuntimeStatus;
  isDark?: boolean;
  dimmed?: boolean;
};

export type NetworkDeviceNodeType = Node<NetworkDeviceNodeData, "device">;

const NetworkDeviceNode = memo(function NetworkDeviceNode({
  data,
  selected,
}: NodeProps<NetworkDeviceNodeType>) {
  const { node, isDark = false, dimmed = false } = data;
  const status = data.status || "unknown";
  const deviceType = data.deviceType || node.device_type || "switch";
  const label = data.label || node.display_name || node.node_id;

  const statusColorMap = nodeStatusColors(isDark);
  const statusColor = statusColorMap[status] || statusColorMap.unknown;

  const iconSrc = netOpsIconForDeviceType(deviceType);

  // Vendor tint background
  const vendorTint = isDark ? "rgba(30, 41, 59, 0.75)" : "#f8fafc";

  return (
    <div
      className={`network-flow-device-node ${selected ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""} status-${status}`}
      style={{
        borderColor: statusColor,
        backgroundColor: vendorTint,
      }}
    >
      {/* 4-Direction Handles for Smooth Connecting */}
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="flow-port-handle"
      />
      <Handle
        type="source"
        position={Position.Top}
        id="top-source"
        className="flow-port-handle"
      />

      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="flow-port-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right-source"
        className="flow-port-handle"
      />

      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="flow-port-handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom-source"
        className="flow-port-handle"
      />

      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="flow-port-handle"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left-source"
        className="flow-port-handle"
      />

      {/* Device Icon */}
      <div className="flow-device-icon-wrap">
        <img
          src={iconSrc}
          alt={deviceType}
          className="flow-device-icon"
          draggable={false}
        />
      </div>

      {/* Status Dot */}
      <span
        className="flow-device-status-badge"
        style={{ backgroundColor: statusColor }}
        title={`状态: ${status}`}
      />

      {/* Device Label under node */}
      <div className="flow-device-label" title={label}>
        {label}
      </div>
    </div>
  );
});

export default NetworkDeviceNode;
