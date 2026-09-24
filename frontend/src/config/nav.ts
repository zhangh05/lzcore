import type { ComponentType } from "react";
import {
  IconBolt,
  IconBook,
  IconBrain,
  IconChecklist,
  IconFolder,
  IconGauge,
  IconGrid,
  IconProbe,
  IconServer,
  IconSettings,
  IconTree,
  IconUsers,
} from "../components/Icon";

export interface NavItem {
  to: string;
  label: string;
  testid: string;
  Icon: ComponentType<{ size?: string | number; weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone"; color?: string }>;
  adminOnly?: boolean;
  /** Render this route from a compact utility menu instead of the main nav. */
  utility?: "settings";
}

export interface NavGroup {
  id: "workbench" | "tasks" | "materials" | "network_devices" | "network_skills" | "topology" | "system";
  label: string;
  description: string;
  to: string;
  testid: string;
  Icon: ComponentType<{ size?: string | number; weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone"; color?: string }>;
  items: NavItem[];
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/workbench", label: "工作台", testid: "nav-workbench", Icon: IconGrid },
  { to: "/runs", label: "任务记录", testid: "nav-runs", Icon: IconChecklist },
  { to: "/knowledge", label: "知识库", testid: "nav-knowledge", Icon: IconBook },
  { to: "/data", label: "文件与数据", testid: "nav-data", Icon: IconFolder },
  { to: "/memory", label: "记忆", testid: "nav-memory", Icon: IconBrain },
  { to: "/extensions/network.operations/manage?tab=devices", label: "网络设备", testid: "nav-network-devices", Icon: IconServer },
  { to: "/extensions/network.operations/manage?tab=skills", label: "Skill", testid: "nav-network-skills", Icon: IconBolt },
  { to: "/topology", label: "网络拓扑", testid: "nav-topology", Icon: IconTree },
  { to: "/diagnostics", label: "系统状态", testid: "nav-diagnostics", Icon: IconProbe },
  { to: "/settings", label: "设置", testid: "nav-settings", Icon: IconSettings, utility: "settings" },
  { to: "/users", label: "用户与权限", testid: "nav-users", Icon: IconUsers, adminOnly: true, utility: "settings" },
];


const GROUP_META: Omit<NavGroup, "items">[] = [
  { id: "workbench", label: "工作台", description: "开始对话、上传材料、获取结果", to: "/workbench", testid: "nav-group-workbench", Icon: IconGrid },
  { id: "tasks", label: "任务", description: "查看任务进度与处理证据", to: "/runs", testid: "nav-group-tasks", Icon: IconChecklist },
  { id: "materials", label: "资料中心", description: "管理文件、知识和记忆", to: "/data", testid: "nav-group-materials", Icon: IconFolder },
  { id: "network_devices", label: "网络设备", description: "维护网络设备身份、管理地址与连接凭据", to: "/extensions/network.operations/manage?tab=devices", testid: "nav-group-network-devices", Icon: IconServer },
  { id: "network_skills", label: "Skill", description: "配置工作台技能、授权设备连接与工具边界", to: "/extensions/network.operations/manage?tab=skills", testid: "nav-group-network-skills", Icon: IconBolt },
  { id: "topology", label: "网络拓扑", description: "维护网络设备、链路与布局", to: "/topology", testid: "nav-group-topology", Icon: IconTree },
  /* 齿轮留给「设置」子项专用。系统管理的语义是"监控运行状态"，用仪表盘。 */
  { id: "system", label: "系统管理", description: "监控系统状态与运行设置", to: "/diagnostics", testid: "nav-group-system", Icon: IconGauge },
];

const GROUP_BY_PATH: Record<string, NavGroup["id"]> = {
  "/workbench": "workbench",
  "/runs": "tasks",
  "/data": "materials",
  "/knowledge": "materials",
  "/memory": "materials",
  "/extensions/network.operations/manage?tab=devices": "network_devices",
  "/extensions/network.operations/manage?tab=skills": "network_skills",
  "/extensions/network.operations/manage": "network_devices",
  "/network": "network_devices",
  "/topology": "topology",
  "/diagnostics": "system",
  "/settings": "system",
  "/users": "system",
};

function groupForItem(item: NavItem): NavGroup["id"] {
  if (item.to === "/topology") return "topology";
  if (item.to.includes("network.operations")) {
    if (item.to.includes("tab=skills") || item.to.includes("/skills")) return "network_skills";
    return "network_devices";
  }
  return GROUP_BY_PATH[item.to] || "system";
}

export function buildNavGroups(items: NavItem[]): NavGroup[] {
  const hasSplitNetworkItems = items.some((item) => item.to.includes("network.operations") && item.to.includes("tab="));
  const seenPaths = new Set<string>();
  const uniqueItems: NavItem[] = [];
  for (const item of items) {
    if (hasSplitNetworkItems && item.to === "/extensions/network.operations/manage") {
      continue;
    }
    if (seenPaths.has(item.to)) continue;
    seenPaths.add(item.to);
    uniqueItems.push(item);
  }
  const grouped = new Map<NavGroup["id"], NavItem[]>();
  for (const item of uniqueItems) {
    const groupId = groupForItem(item);
    grouped.set(groupId, [...(grouped.get(groupId) || []), item]);
  }
  return GROUP_META.map((meta) => ({
    ...meta,
    items: grouped.get(meta.id) || [],
  })).filter((group) => group.items.length > 0);
}
