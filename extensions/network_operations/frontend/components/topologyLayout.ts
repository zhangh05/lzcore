import type { Topology } from "./TopologyWorkspace";

type PositionedNode = { device_id: string; x: number; y: number };

function connectedComponents(topology: Topology): string[][] {
  const parent = new Map(topology.nodes.map((node) => [node.device_id, node.device_id]));
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
    if (parent.has(link.source_device_id) && parent.has(link.target_device_id)) join(link.source_device_id, link.target_device_id);
  });
  const components = new Map<string, string[]>();
  topology.nodes.forEach((node) => {
    const root = find(node.device_id);
    components.set(root, [...(components.get(root) || []), node.device_id]);
  });
  return [...components.values()].sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

/**
 * Lay out each connected component structurally, then pack the components into
 * compact rows. ELK's default component placer favours tall columns when a
 * topology has many isolated devices; that makes a modest canvas zoom its
 * nodes down to illegibility. Packing at this boundary preserves graph-aware
 * routing without making the available browser height part of persisted data.
 */
export async function layoutTopology(topology: Topology): Promise<Topology> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const positioned = new Map<string, PositionedNode>();
  let cursorX = 70;
  let cursorY = 70;
  let rowHeight = 0;
  const rowWidth = 920;

  for (const component of connectedComponents(topology)) {
    const componentIds = new Set(component);
    const componentLinks = topology.links.filter((link) => componentIds.has(link.source_device_id) && componentIds.has(link.target_device_id));
    const result = await elk.layout({
      id: `component-${component[0]}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "90",
        "elk.layered.spacing.nodeNodeBetweenLayers": "140",
        "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      },
      children: component.map((id) => ({ id, width: 160, height: 130 })),
      edges: componentLinks.map((link) => ({ id: link.link_id, sources: [link.source_device_id], targets: [link.target_device_id] })),
    });
    const laidOut = result.children || [];
    const minX = Math.min(...laidOut.map((node) => node.x || 0));
    const minY = Math.min(...laidOut.map((node) => node.y || 0));
    const width = Math.max(...laidOut.map((node) => (node.x || 0) - minX + 160));
    const height = Math.max(...laidOut.map((node) => (node.y || 0) - minY + 130));
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

  const nodes = topology.nodes.map((node) => ({ ...node, x: positioned.get(node.device_id)?.x ?? node.x, y: positioned.get(node.device_id)?.y ?? node.y }));
  const groups = topology.groups.map((group) => {
    const members = nodes.filter((node) => node.group_id === group.group_id);
    if (!members.length) return group;
    const x = Math.min(...members.map((node) => node.x)) - 35;
    const y = Math.min(...members.map((node) => node.y)) - 60;
    return { ...group, x, y, width: Math.max(...members.map((node) => node.x)) - x + 195, height: Math.max(...members.map((node) => node.y)) - y + 165 };
  });
  return { ...topology, nodes, groups };
}

export function linkHandles(source: { x: number; y: number }, target: { x: number; y: number }) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { sourceHandle: dx >= 0 ? "right" : "left", targetHandle: dx >= 0 ? "left" : "right" }
    : { sourceHandle: dy >= 0 ? "bottom" : "top", targetHandle: dy >= 0 ? "top" : "bottom" };
}
