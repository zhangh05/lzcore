/**
 * 命名表（阶段 0 冻结）：一个概念一个名字。导航、页头、命令面板一律从这里取。
 *
 * - 页面名「任务」= 任务中心（主模型 runtime task；jobs 只是队列态）。
 * - 「资料」统一文件 / 知识 / 记忆。
 * - 「系统」是一级入口；「系统状态」只指系统里的运行状态子页。
 * - 核心里「Skill」只指工作台可选 Skill。网络 Skill 属于扩展，名称由扩展 manifest 提供，
 *   并挂在扩展名下（例如「<扩展名> · 网络 Skill 管理」），核心不写死。
 */
export const NAMES = {
  product: "联智中枢",
  workbench: "工作台",
  session: "会话",
  newSession: "新建会话",
  tasks: "任务",
  library: "资料",
  files: "文件",
  knowledge: "知识",
  memory: "记忆",
  workflows: "工作流",
  extensions: "扩展区",
  system: "系统",
  systemStatus: "系统状态",
  settings: "设置",
  skill: "Skill",
  reviewInbox: "待核对",
  workspace: "工作区",
  search: "全局搜索",
  // 阶段 5 扩展（只追加，不改已冻结的名字）
  users: "用户与组织",
  workspaceAdmin: "工作区管理",
  backups: "备份与生产",
  ecosystem: "生态导入",
  workers: "作业 worker",
} as const;

export type NameKey = keyof typeof NAMES;

/** 旧前端里同一概念的别名（P-15），新应用禁止再出现在导航 / 页头。 */
export const FORBIDDEN_ALIASES: readonly string[] = [
  "任务记录", "任务与运行记录", "运行记录",
  "文件与数据", "资料中心", "数据管理",
  "系统管理", "长期记忆",
  "网络设备与 Skill",
];

/** 核心导航 / 空态里不得出现的领域词（核心领域中立；网络只在扩展区，由 manifest 带入）。 */
export const CORE_FORBIDDEN_DOMAIN_WORDS: readonly string[] = ["网络", "设备", "拓扑", "巡检", "运维"];

export interface NavLeaf {
  key: string;
  label: string;
  path: string;
  icon: string;
  /** 阶段 5：只有 admin / platform_admin 才渲染。 */
  adminOnly?: boolean;
}

export interface NavSection extends NavLeaf {
  children?: NavLeaf[];
}

/** 单一左侧导航的核心部分（扩展区由注册表动态插入在「工作流」与「系统」之间）。 */
export const CORE_NAV_BEFORE_EXTENSIONS: readonly NavSection[] = [
  { key: "workbench", label: NAMES.workbench, path: "/workbench", icon: "chat" },
  { key: "tasks", label: NAMES.tasks, path: "/tasks", icon: "checklist" },
  {
    key: "library", label: NAMES.library, path: "/library/files", icon: "folder",
    children: [
      { key: "files", label: NAMES.files, path: "/library/files", icon: "document" },
      { key: "knowledge", label: NAMES.knowledge, path: "/library/knowledge", icon: "book" },
      { key: "memory", label: NAMES.memory, path: "/library/memory", icon: "brain" },
    ],
  },
  { key: "workflows", label: NAMES.workflows, path: "/workflows", icon: "flow" },
];

export const CORE_NAV_AFTER_EXTENSIONS: readonly NavSection[] = [
  {
    key: "system", label: NAMES.system, path: "/system", icon: "settings",
    children: [
      { key: "system-status", label: NAMES.systemStatus, path: "/system", icon: "gauge" },
      { key: "settings", label: NAMES.settings, path: "/system/settings", icon: "settings" },
      { key: "users", label: NAMES.users, path: "/system/users", icon: "settings", adminOnly: true },
      { key: "workspaces", label: NAMES.workspaceAdmin, path: "/system/workspaces", icon: "settings", adminOnly: true },
      { key: "backups", label: NAMES.backups, path: "/system/backups", icon: "settings", adminOnly: true },
      { key: "ecosystem", label: NAMES.ecosystem, path: "/system/ecosystem", icon: "settings", adminOnly: true },
      { key: "workers", label: NAMES.workers, path: "/system/workers", icon: "settings", adminOnly: true },
    ],
  },
];

/** 扩展页在核心里的展示名：扩展名 + manifest 路由名，保证网络 Skill 不与核心 Skill 混名。 */
export function extensionRouteTitle(extensionName: string, routeLabel: string): string {
  return routeLabel && routeLabel !== extensionName ? `${extensionName} · ${routeLabel}` : extensionName;
}

/** 阶段 5：角色判断统一在这里（role 词：admin / operator / viewer；platform_admin 为平台级）。 */
export const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "所有者", admin: "管理员", developer: "开发者", operator: "操作员", viewer: "只读" };
/** 普通用户可分配的角色（backend/api/identity_routes.py：viewer / operator / developer）。 */
export const ASSIGNABLE_ROLES = ["viewer", "operator", "developer"] as const;
export function roleLabel(r?: string): string { return r ? ROLE_LABEL[r] ?? r : "未上报"; }
export function isAdmin(auth?: { role?: string; platform_admin?: boolean } | null): boolean {
  return !!auth && (auth.platform_admin === true || auth.role === "admin");
}
