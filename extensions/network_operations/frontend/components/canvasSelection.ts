import type { SelectedElement, Topology } from "./TopologyWorkspace";

export type CanvasSelection = {
  node_ids: string[];
  link_ids: string[];
  canvas_item_ids: string[];
  group_ids: string[];
  label: string;
};

export function buildCanvasSelection(topology: Topology | null | undefined, ids: string[], inspector: SelectedElement): CanvasSelection {
  const empty: CanvasSelection = { node_ids: [], link_ids: [], canvas_item_ids: [], group_ids: [], label: "整张图纸" };
  if (!topology) return empty;
  const selected = new Set(ids.length ? ids : inspector ? [inspector.type === "node" ? inspector.nodeId : inspector.type === "link" ? inspector.linkId : inspector.type === "canvas_item" ? `canvas-${inspector.itemId}` : `group-${inspector.groupId}`] : []);
  const nodes = topology.nodes.filter(n => selected.has(n.node_id));
  const links = topology.links.filter(l => selected.has(l.link_id));
  const items = (topology.canvas_items || []).filter(i => selected.has(`canvas-${i.item_id}`));
  const groups = topology.groups.filter(g => selected.has(`group-${g.group_id}`));
  const count = nodes.length + links.length + items.length + groups.length;
  return {
    node_ids: nodes.map(n => n.node_id), link_ids: links.map(l => l.link_id),
    canvas_item_ids: items.map(i => i.item_id), group_ids: groups.map(g => g.group_id),
    label: count === 0 ? empty.label : count === 1 ? nodes[0]?.display_name || items[0]?.text || groups[0]?.name || "已选链路" : `已选 ${count} 个图纸对象`,
  };
}
