/** topologyRevisionModel responsibilities, independent of the workspace screen. */

export function describeMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "空";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export type TopologyRevision = {
  revision_id: string;
  version: number;
  saved_at: string;
  name: string;
  summary: {
    nodes?: number;
    links?: number;
    groups?: number;
    canvas_items?: number;
  };
};

export type RevisionDiff = {
  revision_id: string;
  revision_version: number;
  revision_saved_at: string;
  current_version: number;
  nodes_added: Array<{ node_id: string; label: string }>;
  nodes_removed: Array<{ node_id: string; label: string }>;
  nodes_changed: Array<{
    node_id: string;
    label: string;
    changes: Record<string, { from: string; to: string }>;
  }>;
  links_added: Array<{ link_id: string; label: string }>;
  links_removed: Array<{ link_id: string; label: string }>;
  links_changed: Array<{
    link_id: string;
    label: string;
    changes: Record<string, { from: string; to: string }>;
  }>;
  groups_added: Array<{ group_id: string; label: string }>;
  groups_removed: Array<{ group_id: string; label: string }>;
  canvas_items_added: Array<{ item_id: string; label: string }>;
  canvas_items_removed: Array<{ item_id: string; label: string }>;
  summary: Record<string, number>;
};

export const DIFF_FIELD_LABELS: Record<string, string> = {
  device_type: "设备类型",
  display_name: "显示名",
  region_id: "所属区域",
  source_interface: "本端接口",
  target_interface: "对端接口",
  kind: "链路类型",
  source: "来源",
  status: "状态",
  label: "说明",
};
