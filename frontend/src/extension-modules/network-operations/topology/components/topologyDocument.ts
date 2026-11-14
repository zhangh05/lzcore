/** Canonical drawing types; region identity stays canvas_items.item_id. */
export type TopologyNode = {
  node_id: string;
  x: number;
  y: number;
  device_type?: string;
  display_name?: string;
  labels?: string[];
  region_id?: string | null;
  lock_group?: string;
  ip?: string;
  vendor?: string;
  model?: string;
  role?: string;
  vlan?: string;
  location?: string;
};

export type TopologyLinkStyle = {
  color?: string;
  width?: number;
  line_style?: "solid" | "dashed" | "dotted";
  curve_style?: "bezier" | "straight" | "taxi";
  curve_reverse?: boolean;
};

export type TopologyLink = {
  link_id: string;
  source_node_id: string;
  source_interface: string;
  target_node_id: string;
  target_interface: string;
  kind: "physical" | "logical";
  label?: string;
  metadata?: {
    speed?: string;
    vlan?: string;
    medium?: string;
    subnet?: string;
    address?: string;
    /** Descriptions are inspector data unless the diagram owner opts in. */
    show_description?: boolean;
    [key: string]: unknown;
  };
  source: "manual";
  evidence_refs?: string[];
  status: "unknown" | "up" | "down";
  style?: TopologyLinkStyle;
};

/** User-authored visual context.  It is deliberately separate from devices. */
export type TopologyCanvasItem = {
  item_id: string;
  auto_fit?: boolean;
  kind: "rectangle" | "ellipse" | "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: {
    fill?: string;
    border?: string;
    color?: string;
    borderWidth?: number;
  };
};

/**
 * Region tones from the Fluent 2 shared color palette, kept low in saturation so
 * a dozen regions on one sheet read as structure rather than decoration.
 * Neutral comes first and is the default for new regions; colour is opt-in.
 */
export const ZONE_COLOR_PRESETS = [
  { key: "slate", name: "中性灰", fill: "#f5f5f5", border: "#c7c7c7", color: "#424242" },
  { key: "blue", name: "品牌蓝", fill: "#ebf3fc", border: "#96c6fa", color: "#0f548c" },
  { key: "teal", name: "青", fill: "#e9f6f7", border: "#9bd2d6", color: "#00666d" },
  { key: "green", name: "绿", fill: "#f1faf1", border: "#9fd89f", color: "#0e700e" },
  { key: "amber", name: "橙", fill: "#fdf6f3", border: "#f4bfab", color: "#8a3707" },
  { key: "purple", name: "紫", fill: "#f7f4fb", border: "#c6b1de", color: "#5c2e91" },
] as const;

/**
 * Hex values the earlier presets wrote into saved drawings. Rendering maps them to
 * today's tones so old sheets match new ones; the stored document is not rewritten.
 */
const LEGACY_ZONE_TONES: Record<string, (typeof ZONE_COLOR_PRESETS)[number]["key"]> = {
  "#eff6ff": "blue", "#93c5fd": "blue", "#1e40af": "blue",
  "#f0fdf4": "green", "#86efac": "green", "#166534": "green",
  "#fffbeb": "amber", "#fcd34d": "amber", "#92400e": "amber",
  "#faf5ff": "purple", "#d8b4fe": "purple", "#6b21a8": "purple",
  "#f0fdfa": "teal", "#5eead4": "teal", "#115e59": "teal",
  "#f8fafc": "slate", "#cbd5e1": "slate", "#334155": "slate",
  "#dff5f0": "teal", "#58a99b": "teal", "#0f5149": "teal",
};

export function currentZoneTone(
  value: string | undefined,
  part: "fill" | "border" | "color",
): string | undefined {
  if (!value) return value;
  const key = LEGACY_ZONE_TONES[value.toLowerCase()];
  if (!key) return value;
  return ZONE_COLOR_PRESETS.find((preset) => preset.key === key)?.[part] ?? value;
}

export type TopologyGroup = {
  group_id: string;
  name: string;
  kind: "as" | "region" | "datacenter" | "tenant" | "custom";
  x: number;
  y: number;
  width: number;
  height: number;
  style?: Record<string, unknown>;
};

export type Topology = {
  topology_id: string;
  name: string;
  description: string;
  version: number;
  nodes: TopologyNode[];
  links: TopologyLink[];
  groups: TopologyGroup[];
  region_migration_issues?: Array<{ node_id: string; reason: string }>;
  layout_issues?: string[];
  canvas_items?: TopologyCanvasItem[];
  created_at: string;
  updated_at: string;
};

export type SelectedElement =
  | { type: "node"; nodeId: string }
  | { type: "link"; linkId: string }
  | { type: "group"; groupId: string }
  | { type: "canvas_item"; itemId: string }
  | null;
