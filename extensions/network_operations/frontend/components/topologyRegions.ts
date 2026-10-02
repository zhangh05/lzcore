import { moveDrawingNodes } from "./topologyCollaboration";
import type { Topology, TopologyNode, TopologyCanvasItem } from "./TopologyWorkspace";

// Keep this geometry contract aligned with region_geometry.py, including title space.
export function regionBounds(nodes: TopologyNode[], kind: string = "rectangle") {
  if (!nodes.length) throw new Error("region_members_required");
  const left = Math.min(...nodes.map(n => n.x)) - 90;
  const right = Math.max(...nodes.map(n => n.x)) + 90;
  const top = Math.min(...nodes.map(n => n.y)) - 104;
  const bottom = Math.max(...nodes.map(n => n.y)) + 80;
  const factor = kind === "ellipse" ? Math.SQRT2 : 1;
  return { x: (left + right) / 2, y: (top + bottom) / 2,
    width: Math.max(240, (right - left) * factor), height: Math.max(180, (bottom - top) * factor) };
}

export function regionContains(item: TopologyCanvasItem, node: TopologyNode, footprint = true) {
  const rx = item.width / 2, ry = item.height / 2;
  const hx = footprint ? 70 : 0, hy = footprint ? 55 : 0;
  const dx = Math.abs(node.x - item.x) + hx, dy = Math.abs(node.y - item.y) + hy;
  return item.kind === "ellipse" ? (dx / rx) ** 2 + (dy / ry) ** 2 <= 1
    : dx <= rx && dy <= ry && node.y - hy >= item.y - ry + 24;
}

export function fitRegions(topology: Topology): Topology {
  const members = new Map<string, TopologyNode[]>();
  for (const node of topology.nodes) {
    if (!node.region_id) continue;
    const group = members.get(node.region_id) || [];
    group.push(node); members.set(node.region_id, group);
  }
  return { ...topology, canvas_items: (topology.canvas_items || []).map(item => {
    const nodes = members.get(item.item_id);
    return item.auto_fit === true && item.kind !== "text" && nodes?.length
      ? { ...item, ...regionBounds(nodes, item.kind) } : item;
  }) };
}

export function moveRegionElements(topology: Topology, positions: Array<{element_id: string; x: number; y: number}>, includeMembers: boolean): Topology {
  const direct = new Map(positions.map(p => [p.element_id, p]));
  const deltas = new Map<string, {dx: number; dy: number}>();
  const canvas_items = (topology.canvas_items || []).map(item => {
    const p = direct.get(`canvas-${item.item_id}`);
    if (!p) return item;
    if (includeMembers && item.kind !== "text") deltas.set(item.item_id, {dx: p.x - item.x, dy: p.y - item.y});
    return {...item, x: p.x, y: p.y, auto_fit: includeMembers && item.kind !== "text" ? item.auto_fit : false};
  });
  const targets = topology.nodes.flatMap(node => {
    const p = direct.get(node.node_id);
    const d = node.region_id ? deltas.get(node.region_id) : undefined;
    return p ? [p] : d ? [{element_id: node.node_id, x: node.x + d.dx, y: node.y + d.dy}] : [];
  });
  return fitRegions({...topology, nodes: moveDrawingNodes(topology.nodes, targets), canvas_items});
}
