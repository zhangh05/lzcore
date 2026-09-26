import type { Topology } from "./TopologyWorkspace";

type PositionedNode = { device_id: string; x: number; y: number };

/**
 * Layout presets. A network is not a generic graph: operators read it as
 * layers (core / distribution / access) or as a set of neighbours around one
 * device, so one algorithm cannot serve every reading of the same data.
 */
export type LayoutAlgorithm = "hierarchy-h" | "hierarchy-v" | "radial" | "grid";

export const LAYOUT_PRESETS: Array<{ id: LayoutAlgorithm; label: string; hint: string }> = [
  { id: "hierarchy-h", label: "水平分层", hint: "按链路方向自左向右分层" },
  { id: "hierarchy-v", label: "垂直分层", hint: "核心在上、接入在下，最贴近网络读法" },
  { id: "radial", label: "径向放射", hint: "以连接最多的设备为中心向外展开" },
  { id: "grid", label: "网格排列", hint: "均匀铺开，适合设备清单式核对" },
];

function connectedComponents(topology: Topology): string[][] {
  const parent = new Map(topology.nodes.map((node) => [node.node_id, node.node_id]));
  const find = (id: string): string => {
    const root = parent.get(id) || id;
    if (root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const join = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  topology.links.forEach((link) => {
    if (parent.has(link.source_node_id) && parent.has(link.target_node_id)) join(link.source_node_id, link.target_node_id);
  });
  const components = new Map<string, string[]>();
  topology.nodes.forEach((node) => {
    const root = find(node.node_id);
    components.set(root, [...(components.get(root) || []), node.node_id]);
  });
  return [...components.values()].sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

/** Place the busiest device in the middle and fan the rest out in rings. */
function radialPositions(nodeIds: string[], links: Topology["links"]): Map<string, PositionedNode> {
  const positions = new Map<string, PositionedNode>();
  const degree = new Map(nodeIds.map((id) => [id, 0]));
  links.forEach((link) => {
    if (degree.has(link.source_node_id)) degree.set(link.source_node_id, (degree.get(link.source_node_id) || 0) + 1);
    if (degree.has(link.target_node_id)) degree.set(link.target_node_id, (degree.get(link.target_node_id) || 0) + 1);
  });
  const ordered = [...nodeIds].sort((left, right) => (degree.get(right) || 0) - (degree.get(left) || 0) || left.localeCompare(right));
  if (!ordered.length) return positions;
  positions.set(ordered[0], { device_id: ordered[0], x: 0, y: 0 });
  let placed = 1;
  let ring = 1;
  while (placed < ordered.length) {
    const count = Math.min(Math.max(6, ring * 6), ordered.length - placed);
    const radius = ring * 250;
    for (let index = 0; index < count; index += 1) {
      const angle = (2 * Math.PI * index) / count - Math.PI / 2;
      const id = ordered[placed + index];
      positions.set(id, { device_id: id, x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) });
    }
    placed += count;
    ring += 1;
  }
  return positions;
}

function gridPositions(nodeIds: string[]): Map<string, PositionedNode> {
  const positions = new Map<string, PositionedNode>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeIds.length)));
  nodeIds.forEach((id, index) => {
    positions.set(id, { device_id: id, x: (index % columns) * 240, y: Math.floor(index / columns) * 190 });
  });
  return positions;
}

function nodeTierScore(node?: Topology["nodes"][number]): number {
  if (!node) return 50;
  const role = (node.role || "").toLowerCase();
  const type = (node.device_type || "").toLowerCase();
  const name = (node.display_name || node.node_id || "").toLowerCase();

  // Tier 1: External / Edge / Carrier / ISP / Cloud
  if (role.includes("edge") || role.includes("isp") || type.includes("isp") || type.includes("cloud") || name.includes("isp") || name.includes("出口") || name.includes("互联网")) return 10;
  // Tier 2: Security / Firewall / VPN
  if (role.includes("firewall") || role.includes("sec") || role.includes("vpn") || type.includes("firewall") || type.includes("vpn") || name.includes("fw") || name.includes("防火墙") || name.includes("vpn")) return 20;
  // Tier 3: Core / Spine
  if (role.includes("core") || role.includes("spine") || name.includes("core") || name.includes("核心") || name.includes("spine")) return 30;
  // Tier 4: Aggregation / Distribution
  if (role.includes("agg") || role.includes("dist") || name.includes("agg") || name.includes("汇聚")) return 40;
  // Tier 5: Access / WLC / Leaf
  if (role.includes("access") || role.includes("leaf") || role.includes("wlc") || type.includes("wlc") || name.includes("access") || name.includes("接入") || name.includes("ac")) return 50;
  // Tier 6: Endpoints / Server / Storage / AP / Terminal
  if (role.includes("server") || role.includes("storage") || type.includes("server") || type.includes("storage") || type.includes("ap") || role.includes("terminal") || type.includes("terminal") || name.includes("server") || name.includes("ap") || name.includes("pc")) return 60;

  return 50;
}

/**
 * Lay out each connected component structurally, then pack the components into
 * compact rows. ELK's default component placer favours tall columns when a
 * topology has many isolated devices; that makes a modest canvas zoom its
 * nodes down to illegibility. Packing at this boundary preserves graph-aware
 * routing without making the available browser height part of persisted data.
 */
export async function layoutTopology(topology: Topology, algorithm: LayoutAlgorithm = "hierarchy-h"): Promise<Topology> {
  const positioned = new Map<string, PositionedNode>();

  if (algorithm === "radial" || algorithm === "grid") {
    const allIds = topology.nodes.map((node) => node.node_id);
    const placed = algorithm === "radial" ? radialPositions(allIds, topology.links) : gridPositions(allIds);
    const minX = Math.min(...[...placed.values()].map((node) => node.x), 0);
    const minY = Math.min(...[...placed.values()].map((node) => node.y), 0);
    placed.forEach((node, id) => positioned.set(id, { device_id: id, x: node.x - minX + 70, y: node.y - minY + 70 }));
  } else {
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    const elk = new ELK();
    const nodeById = new Map(topology.nodes.map((n) => [n.node_id, n]));
    let cursorX = 70;
    let cursorY = 70;
    let rowHeight = 0;
    const rowWidth = 920;

    for (const component of connectedComponents(topology)) {
      const componentIds = new Set(component);
      const componentLinks = topology.links.filter((link) => componentIds.has(link.source_node_id) && componentIds.has(link.target_node_id));
      const edges = componentLinks.map((link) => {
        const srcNode = nodeById.get(link.source_node_id);
        const tgtNode = nodeById.get(link.target_node_id);
        const srcTier = nodeTierScore(srcNode);
        const tgtTier = nodeTierScore(tgtNode);
        if (srcTier > tgtTier) {
          return { id: link.link_id, sources: [link.target_node_id], targets: [link.source_node_id] };
        }
        return { id: link.link_id, sources: [link.source_node_id], targets: [link.target_node_id] };
      });

      const result = await elk.layout({
        id: `component-${component[0]}`,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": algorithm === "hierarchy-v" ? "DOWN" : "RIGHT",
          "elk.spacing.nodeNode": "80",
          "elk.layered.spacing.nodeNodeBetweenLayers": "130",
          "elk.padding": "[top=0,left=0,bottom=0,right=0]",
        },
        children: component.map((id) => ({ id, width: 140, height: 110 })),
        edges,
      });
      const laidOut = result.children || [];
      const minX = Math.min(...laidOut.map((node) => node.x || 0));
      const minY = Math.min(...laidOut.map((node) => node.y || 0));
      const width = Math.max(...laidOut.map((node) => (node.x || 0) - minX + 140));
      const height = Math.max(...laidOut.map((node) => (node.y || 0) - minY + 110));
      if (cursorX > 70 && cursorX + width > rowWidth) {
        cursorX = 70;
        cursorY += rowHeight + 100;
        rowHeight = 0;
      }
      laidOut.forEach((node) => positioned.set(node.id, {
        device_id: node.id,
        x: cursorX + (node.x || 0) - minX,
        y: cursorY + (node.y || 0) - minY,
      }));
      cursorX += width + 110;
      rowHeight = Math.max(rowHeight, height);
    }
  }

  const nodes = topology.nodes.map((node) => ({ ...node, x: positioned.get(node.node_id)?.x ?? node.x, y: positioned.get(node.node_id)?.y ?? node.y }));
  const groups = topology.groups.map((group) => {
    const members = nodes.filter((node) => node.group_id === group.group_id);
    if (!members.length) return group;
    const x = Math.min(...members.map((node) => node.x)) - 35;
    const y = Math.min(...members.map((node) => node.y)) - 60;
    return { ...group, x, y, width: Math.max(...members.map((node) => node.x)) - x + 195, height: Math.max(...members.map((node) => node.y)) - y + 165 };
  });

  const canvas_items = (topology.canvas_items || []).map((item) => {
    if (item.kind !== "rectangle") return item;
    const halfW = (item.width || 200) / 2;
    const halfH = (item.height || 100) / 2;
    const memberIds = topology.nodes
      .filter((n) => n.x >= item.x - halfW && n.x <= item.x + halfW && n.y >= item.y - halfH && n.y <= item.y + halfH)
      .map((n) => n.node_id);
    if (memberIds.length === 0) return item;
    const laidOutMembers = nodes.filter((n) => memberIds.includes(n.node_id));
    if (laidOutMembers.length === 0) return item;

    const xs = laidOutMembers.map((n) => n.x);
    const ys = laidOutMembers.map((n) => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const padX = 60;
    const padY = 50;
    return {
      ...item,
      x: Math.round((minX + maxX) / 2),
      y: Math.round((minY + maxY) / 2),
      width: Math.max(item.width, Math.round(maxX - minX + padX * 2)),
      height: Math.max(item.height, Math.round(maxY - minY + padY * 2)),
    };
  });

  return { ...topology, nodes, groups, canvas_items };
}

export function linkHandles(source: { x: number; y: number }, target: { x: number; y: number }) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { sourceHandle: dx >= 0 ? "right" : "left", targetHandle: dx >= 0 ? "left" : "right" }
    : { sourceHandle: dy >= 0 ? "bottom" : "top", targetHandle: dy >= 0 ? "top" : "bottom" };
}
