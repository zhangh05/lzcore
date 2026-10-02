import type { Topology, TopologyNode } from "./TopologyWorkspace";
import { mergeTopologies } from "./topologyMerge";

export type DrawingEdit = { before: Topology; after: Topology; source: "manual" | "collaboration" };
export type DrawingActivity = DrawingEdit & {
  version: number; ids: string[]; added: number; modified: number; removed: number;
  status: "displayed" | "pending"; removedLabels: string[];
};

const collections = [
  ["nodes", "node_id", ""], ["links", "link_id", ""],
  ["canvas_items", "item_id", "canvas-"], ["groups", "group_id", "group-"],
] as const;
const stable = (value: unknown): string => {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])));
};

export function drawingActivity(before: Topology, after: Topology, status: DrawingActivity["status"]): DrawingActivity {
  const activity: DrawingActivity = { before, after, source: "collaboration", version: after.version,
    ids: [], added: 0, modified: 0, removed: 0, status, removedLabels: [] };
  for (const [collection, key, prefix] of collections) {
    const old = new Map((before[collection] || []).map(item => [String((item as unknown as Record<string, unknown>)[key]), item]));
    for (const item of after[collection] || []) {
      const id = String((item as unknown as Record<string, unknown>)[key]);
      const previous = old.get(id);
      if (!previous || stable(previous) !== stable(item)) {
        activity.ids.push(prefix + id);
        if (previous) activity.modified += 1; else activity.added += 1;
      }
      old.delete(id);
    }
    for (const [id, item] of old) {
      const record = item as unknown as Record<string, unknown>;
      activity.removed += 1;
      activity.removedLabels.push(String(record.display_name || record.text || record.name || record.label || id));
    }
  }
  if (before.name !== after.name || before.description !== after.description) activity.modified += 1;
  return activity;
}

export function hasDrawingChanges(before: Topology, after: Topology) {
  const delta = drawingActivity(before, after, "displayed");
  return delta.added + delta.modified + delta.removed > 0;
}

/** Apply only an entry's inverse/forward delta over the latest drawing. */
export function applyDrawingEdit(current: Topology, entry: DrawingEdit, undo = true) {
  const expected = undo ? entry.after : entry.before;
  const target = undo ? entry.before : entry.after;
  return mergeTopologies(expected, target, current);
}

/** Explicit positions win; all other fixed-link members follow the first anchor. */
export function moveDrawingNodes(nodes: TopologyNode[], positions: Array<{ element_id: string; x: number; y: number }>) {
  const byId = new Map(positions.map(position => [position.element_id, position]));
  const deltas = new Map<string, { dx: number; dy: number }>();
  for (const node of nodes) {
    const direct = byId.get(node.node_id);
    if (direct && node.lock_group && !deltas.has(node.lock_group)) {
      deltas.set(node.lock_group, { dx: direct.x - node.x, dy: direct.y - node.y });
    }
  }
  return nodes.map(node => {
    const direct = byId.get(node.node_id);
    if (direct) return { ...node, x: direct.x, y: direct.y };
    const delta = node.lock_group ? deltas.get(node.lock_group) : undefined;
    return delta ? { ...node, x: node.x + delta.dx, y: node.y + delta.dy } : node;
  });
}
