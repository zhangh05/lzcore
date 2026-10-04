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

export const ZONE_COLOR_PRESETS = [
  {
    key: "blue",
    name: "商务蓝",
    fill: "#eff6ff",
    border: "#93c5fd",
    color: "#1e40af",
  },
  {
    key: "green",
    name: "翡翠绿",
    fill: "#f0fdf4",
    border: "#86efac",
    color: "#166534",
  },
  {
    key: "amber",
    name: "暖金橙",
    fill: "#fffbeb",
    border: "#fcd34d",
    color: "#92400e",
  },
  {
    key: "purple",
    name: "科技紫",
    fill: "#faf5ff",
    border: "#d8b4fe",
    color: "#6b21a8",
  },
  {
    key: "teal",
    name: "薄荷青",
    fill: "#f0fdfa",
    border: "#5eead4",
    color: "#115e59",
  },
  {
    key: "slate",
    name: "典雅灰",
    fill: "#f8fafc",
    border: "#cbd5e1",
    color: "#334155",
  },
] as const;

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
