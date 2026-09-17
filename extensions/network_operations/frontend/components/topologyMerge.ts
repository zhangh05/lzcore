/**
 * Three-way merge for topology drawings.
 *
 * Two people editing the same diagram is normal in operations work, and a
 * version conflict that only says "save failed" leaves the user with no way
 * out. This is not CRDT and does not pretend to be: objects have stable ids,
 * so a three-way merge over those ids resolves the overwhelming majority of
 * real edits (one person moved a node while another added a link) and reports
 * the rest instead of silently picking a winner.
 *
 * Deletion is treated as deliberate and wins over an edit to the same object,
 * but a delete-vs-edit clash is reported so it is never silent.
 */

export type MergeEntity = Record<string, unknown>;

export type MergeConflict = {
  /** Which collection the clash is in, in canvas vocabulary. */
  collection: string;
  id: string;
  field: string;
  mine: unknown;
  theirs: unknown;
};

export type MergeStats = {
  added: number;
  removed: number;
  /** Fields one side changed while the other left them alone. */
  autoMerged: number;
  /** Links dropped because a merged-away node was one of their endpoints. */
  orphanedLinks: number;
};

export type MergeResult<T> = {
  topology: T;
  conflicts: MergeConflict[];
  stats: MergeStats;
};

const COLLECTIONS = [
  { field: "nodes", key: "node_id", label: "节点" },
  { field: "links", key: "link_id", label: "链路" },
  { field: "groups", key: "group_id", label: "分组" },
  { field: "canvas_items", key: "item_id", label: "图元" },
] as const;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergePlainObject(
  original: unknown,
  mine: unknown,
  theirs: unknown,
  collection: string,
  id: string,
  prefix: string,
): { value: unknown; conflicts: MergeConflict[]; autoMerged: number } {
  const originalRecord = isPlainObject(original) ? original : {};
  const mineRecord = isPlainObject(mine) ? mine : {};
  const theirsRecord = isPlainObject(theirs) ? theirs : {};
  const merged: Record<string, unknown> = { ...theirsRecord };
  const conflicts: MergeConflict[] = [];
  let autoMerged = 0;
  for (const key of new Set([...Object.keys(mineRecord), ...Object.keys(theirsRecord)])) {
    const field = prefix ? `${prefix}.${key}` : key;
    const mineValue = mineRecord[key];
    const theirsValue = theirsRecord[key];
    const originalValue = originalRecord[key];
    if (isPlainObject(mineValue) || isPlainObject(theirsValue) || isPlainObject(originalValue)) {
      const nested = mergePlainObject(originalValue, mineValue, theirsValue, collection, id, field);
      merged[key] = nested.value;
      conflicts.push(...nested.conflicts);
      autoMerged += nested.autoMerged;
    } else if (same(mineValue, theirsValue)) {
      merged[key] = mineValue;
    } else if (same(originalValue, mineValue)) {
      merged[key] = theirsValue;
      autoMerged += 1;
    } else if (same(originalValue, theirsValue)) {
      merged[key] = mineValue;
      autoMerged += 1;
    } else {
      merged[key] = theirsValue;
      conflicts.push({ collection, id, field, mine: mineValue, theirs: theirsValue });
    }
  }
  return { value: merged, conflicts, autoMerged };
}

function indexById(items: MergeEntity[], key: string): Map<string, MergeEntity> {
  const map = new Map<string, MergeEntity>();
  items.forEach((item) => {
    const id = String(item?.[key] ?? "");
    if (id) map.set(id, item);
  });
  return map;
}

function mergeCollection(
  base: MergeEntity[],
  mine: MergeEntity[],
  theirs: MergeEntity[],
  key: string,
  label: string,
): { items: MergeEntity[]; conflicts: MergeConflict[]; added: number; removed: number; autoMerged: number } {
  const baseById = indexById(base, key);
  const mineById = indexById(mine, key);
  const theirsById = indexById(theirs, key);
  // Keep the familiar order: what the drawing already had, then new objects.
  // Deduplicated, because an id both sides created independently would
  // otherwise be merged twice and reported twice.
  const order = [...new Set([
    ...baseById.keys(),
    ...mineById.keys(),
    ...theirsById.keys(),
  ])];

  const items: MergeEntity[] = [];
  const conflicts: MergeConflict[] = [];
  let added = 0;
  let removed = 0;
  let autoMerged = 0;

  for (const id of order) {
    const original = baseById.get(id);
    const local = mineById.get(id);
    const remote = theirsById.get(id);

    if (!local && !remote) {
      removed += 1;
      continue;
    }
    if (local && !remote) {
      if (!original) {
        items.push(local);
        added += 1;
        continue;
      }
      // They deleted it. Deletion wins, but an edit on my side is reported.
      if (!same(original, local)) conflicts.push({ collection: label, id, field: "删除", mine: local, theirs: null });
      removed += 1;
      continue;
    }
    if (!local && remote) {
      if (!original) {
        items.push(remote);
        added += 1;
        continue;
      }
      if (!same(original, remote)) conflicts.push({ collection: label, id, field: "删除", mine: null, theirs: remote });
      removed += 1;
      continue;
    }

    const localRecord = local as MergeEntity;
    const remoteRecord = remote as MergeEntity;
    if (!original) {
      // Both sides created the same id independently; the server copy wins.
      conflicts.push({ collection: label, id, field: "同时新增", mine: localRecord, theirs: remoteRecord });
      items.push(remoteRecord);
      continue;
    }

    const merged: MergeEntity = { ...remoteRecord };
    for (const field of new Set([...Object.keys(localRecord), ...Object.keys(remoteRecord)])) {
      const mineValue = localRecord[field];
      const theirsValue = remoteRecord[field];
      if (isPlainObject(mineValue) || isPlainObject(theirsValue) || isPlainObject(original[field])) {
        const nested = mergePlainObject(original[field], mineValue, theirsValue, label, id, field);
        merged[field] = nested.value;
        conflicts.push(...nested.conflicts);
        autoMerged += nested.autoMerged;
      } else if (same(mineValue, theirsValue)) {
        merged[field] = mineValue;
      } else if (same(original[field], mineValue)) {
        merged[field] = theirsValue;
        autoMerged += 1;
      } else if (same(original[field], theirsValue)) {
        merged[field] = mineValue;
        autoMerged += 1;
      } else {
        merged[field] = theirsValue;
        conflicts.push({ collection: label, id, field, mine: mineValue, theirs: theirsValue });
      }
    }
    items.push(merged);
  }

  return { items, conflicts, added, removed, autoMerged };
}

export function mergeTopologies<T extends Record<string, unknown>>(base: T, mine: T, theirs: T): MergeResult<T> {
  const conflicts: MergeConflict[] = [];
  const stats: MergeStats = { added: 0, removed: 0, autoMerged: 0, orphanedLinks: 0 };
  const merged: Record<string, unknown> = { ...theirs };

  // Scalar fields merge the same way object fields do.
  for (const field of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (COLLECTIONS.some((collection) => collection.field === field)) continue;
    const mineValue = mine[field];
    const theirsValue = theirs[field];
    if (same(mineValue, theirsValue)) continue;
    if (same(base[field], mineValue)) continue;      // only they changed it
    if (same(base[field], theirsValue)) {            // only I changed it
      merged[field] = mineValue;
      stats.autoMerged += 1;
      continue;
    }
    merged[field] = theirsValue;
    conflicts.push({ collection: "图纸", id: String(theirs.topology_id ?? ""), field, mine: mineValue, theirs: theirsValue });
  }

  for (const { field, key, label } of COLLECTIONS) {
    const result = mergeCollection(
      (base[field] as MergeEntity[]) || [],
      (mine[field] as MergeEntity[]) || [],
      (theirs[field] as MergeEntity[]) || [],
      key,
      label,
    );
    merged[field] = result.items;
    conflicts.push(...result.conflicts);
    stats.added += result.added;
    stats.removed += result.removed;
    stats.autoMerged += result.autoMerged;
  }

  // The backend rejects a link whose endpoint no longer exists, so a merge that
  // removed a node must also drop the links that pointed at it.
  const nodeIds = new Set(((merged.nodes as MergeEntity[]) || []).map((node) => String(node.node_id)));
  const keptLinks = ((merged.links as MergeEntity[]) || []).filter((link) => {
    const keep = nodeIds.has(String(link.source_node_id)) && nodeIds.has(String(link.target_node_id));
    if (!keep) stats.orphanedLinks += 1;
    return keep;
  });
  merged.links = keptLinks;

  return { topology: merged as T, conflicts, stats };
}
