/**
 * What the Agent is told the user is looking at.
 *
 * The canvas selection is authoritative. Deriving this from the inspector's
 * single selection meant that box-selecting five devices and asking about
 * "these" sent the whole topology instead — the user's selection was silently
 * dropped on the way to the model.
 *
 * Pure on purpose: the interesting cases (multi-select, unlinked nodes, a
 * selection that exists on the canvas but not in the inspector) cannot be
 * driven through the real canvas in a unit test.
 */

import type { Device, SelectedElement, Topology } from "./TopologyWorkspace";

export type CanvasSelection = {
  device_ids: string[];
  link_ids: string[];
  label: string;
};

const WHOLE_DRAWING: CanvasSelection = { device_ids: [], link_ids: [], label: "整张拓扑" };

export function buildCanvasSelection(
  topology: Topology | null | undefined,
  devices: Device[],
  canvasSelectedElementIds: string[],
  inspectorSelection: SelectedElement,
): CanvasSelection {
  if (!topology) return WHOLE_DRAWING;
  const nodeById = new Map(topology.nodes.map((node) => [node.node_id, node]));
  const linkById = new Map(topology.links.map((link) => [link.link_id, link]));
  const deviceName = (deviceId: string) => devices.find((device) => device.device_id === deviceId)?.name || deviceId;
  const nodeLabel = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    return node?.display_name || deviceName(node?.linked_device_id || "") || nodeId;
  };

  const pickedNodes = canvasSelectedElementIds.map((id) => nodeById.get(id)).filter(Boolean) as Topology["nodes"];
  const pickedLinks = canvasSelectedElementIds.map((id) => linkById.get(id)).filter(Boolean) as Topology["links"];

  if (pickedNodes.length + pickedLinks.length > 1) {
    const deviceIds = new Set<string>();
    const collect = (nodeId: string) => {
      const linked = nodeById.get(nodeId)?.linked_device_id;
      if (linked) deviceIds.add(linked);
    };
    pickedNodes.forEach((node) => collect(node.node_id));
    pickedLinks.forEach((link) => { collect(link.source_node_id); collect(link.target_node_id); });
    return {
      device_ids: [...deviceIds],
      link_ids: pickedLinks.map((link) => link.link_id),
      label: `已选 ${pickedNodes.length} 个节点 · ${pickedLinks.length} 条链路`,
    };
  }

  // A single canvas selection wins over the inspector, which may be stale or
  // showing something the user has since deselected.
  const soleId = canvasSelectedElementIds[0];
  const soleElement: SelectedElement = soleId
    ? (nodeById.has(soleId) ? { type: "node", nodeId: soleId } : linkById.has(soleId) ? { type: "link", linkId: soleId } : null)
    : null;
  const focus = soleElement || inspectorSelection;
  if (!focus) return WHOLE_DRAWING;

  if (focus.type === "node") {
    const node = nodeById.get(focus.nodeId);
    const linkedDeviceId = node?.linked_device_id || "";
    if (!linkedDeviceId) return { device_ids: [], link_ids: [], label: `${node?.display_name || "图纸设备"}（未关联）` };
    return { device_ids: [linkedDeviceId], link_ids: [], label: deviceName(linkedDeviceId) };
  }
  if (focus.type === "link") {
    const link = linkById.get(focus.linkId);
    if (!link) return WHOLE_DRAWING;
    const source = nodeById.get(link.source_node_id);
    const target = nodeById.get(link.target_node_id);
    return {
      device_ids: [source?.linked_device_id, target?.linked_device_id].filter(Boolean) as string[],
      link_ids: [link.link_id],
      label: `${nodeLabel(link.source_node_id)} ↔ ${nodeLabel(link.target_node_id)}`,
    };
  }
  if (focus.type === "canvas_item") {
    const item = (topology.canvas_items || []).find((entry) => entry.item_id === focus.itemId);
    return { device_ids: [], link_ids: [], label: item?.text || "图纸图元" };
  }
  return {
    device_ids: topology.nodes
      .filter((node) => node.group_id === focus.groupId)
      .map((node) => node.linked_device_id || "")
      .filter(Boolean),
    link_ids: [],
    label: topology.groups.find((group) => group.group_id === focus.groupId)?.name || "分组",
  };
}
