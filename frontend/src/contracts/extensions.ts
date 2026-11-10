/**
 * 扩展注册表接口（阶段 0 冻结）。
 *
 * 数据源：`GET /api/extensions` → `{ ok, extensions: ExtensionCatalogItem[] }`
 * （backend/api/extension_routes.py:23、extensions/runtime.py:623-642）。
 * 核心只消费 catalog，不 import `extensions/**`；导航和路由全部由 catalog 生成。
 * 扩展不可用 / 加载失败：说明原因，绝不导向 404。
 * 前端模块（manifest `module`）在阶段 6 才挂载；阶段 1 只渲染说明占位。
 */

export interface ExtensionFrontendRoute {
  path: string;
  module?: string;
  label?: string;
  description?: string;
  icon?: string;
  order?: number;
}

export interface ExtensionLifecycle {
  extension_id?: string;
  enabled?: boolean;
  status?: string;
  failure_count?: number;
  last_error?: string;
}

export interface ExtensionCatalogItem {
  extension_id: string;
  name: string;
  version?: string;
  description?: string;
  capabilities?: string[];
  tools?: string[];
  frontend_routes?: ExtensionFrontendRoute[];
  workflow_templates?: unknown[];
  permissions?: string[];
  metadata?: { minimum_role?: string; minimum_write_role?: string };
  source?: string;
  lifecycle?: ExtensionLifecycle;
}

export interface ExtensionMount {
  extensionId: string;
  extensionName: string;
  path: string;
  label: string;
  description: string;
  icon: string;
  order: number;
  available: boolean;
  /** 不可用原因（available=false 时必有）。 */
  reason?: string;
}

export type ExtensionRegistryState =
  | { kind: "loading" }
  | { kind: "ready"; extensions: ExtensionCatalogItem[]; mounts: ExtensionMount[] }
  | { kind: "error"; reason: string };

const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, developer: 2, admin: 3, owner: 4 };

/** 扩展可用性。只读 lifecycle 与 minimum_role，不猜。 */
export function extensionAvailability(ext: ExtensionCatalogItem, role?: string): { available: boolean; reason?: string } {
  const lc = ext.lifecycle ?? {};
  if (lc.enabled === false) return { available: false, reason: "该扩展已停用，请在系统中启用后再使用。" };
  const status = String(lc.status ?? "ready");
  if (status !== "ready") {
    const detail = lc.last_error ? `：${lc.last_error}` : "";
    return { available: false, reason: `扩展状态为「${status}」，暂不可用${detail}` };
  }
  const min = ext.metadata?.minimum_role;
  if (min && role !== undefined && role !== "" && (ROLE_RANK[role] ?? -1) < (ROLE_RANK[min] ?? 0)) {
    return { available: false, reason: `需要「${min}」及以上角色。` };
  }
  return { available: true };
}

export function deriveExtensionMounts(catalog: ExtensionCatalogItem[], role?: string): ExtensionMount[] {
  const mounts: ExtensionMount[] = [];
  for (const ext of catalog) {
    const availability = extensionAvailability(ext, role);
    for (const route of ext.frontend_routes ?? []) {
      if (!route?.path || !route.path.startsWith("/extensions/")) continue;
      mounts.push({
        extensionId: ext.extension_id,
        extensionName: ext.name || ext.extension_id,
        path: route.path,
        label: route.label || ext.name || ext.extension_id,
        description: route.description || ext.description || "",
        icon: route.icon || "puzzle",
        order: typeof route.order === "number" ? route.order : 100,
        ...availability,
      });
    }
  }
  return mounts.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function registryFromResponse(body: unknown, role?: string): ExtensionRegistryState {
  const extensions = (body as { extensions?: unknown })?.extensions;
  if (!Array.isArray(extensions)) return { kind: "error", reason: "扩展目录返回格式无法识别。" };
  const items = extensions.filter((x): x is ExtensionCatalogItem => !!x && typeof (x as ExtensionCatalogItem).extension_id === "string");
  return { kind: "ready", extensions: items, mounts: deriveExtensionMounts(items, role) };
}

export type ExtensionRouteResolution =
  | { kind: "not_extension_path" }
  | { kind: "loading" }
  | { kind: "overview" }
  | { kind: "mounted"; mount: ExtensionMount }
  | { kind: "unavailable"; mount: ExtensionMount; reason: string }
  | { kind: "registry_error"; reason: string }
  | { kind: "not_installed"; reason: string };

/** `/extensions/**` 路由解析。任何情况下都不返回 404，而是带原因的说明态。 */
export function resolveExtensionRoute(pathname: string, state: ExtensionRegistryState): ExtensionRouteResolution {
  if (pathname !== "/extensions" && !pathname.startsWith("/extensions/")) return { kind: "not_extension_path" };
  if (pathname === "/extensions") return { kind: "overview" };
  if (state.kind === "loading") return { kind: "loading" };
  if (state.kind === "error") return { kind: "registry_error", reason: `扩展目录读取失败：${state.reason}` };
  const mount = state.mounts.find((m) => pathname === m.path || pathname.startsWith(`${m.path}/`));
  if (!mount) return { kind: "not_installed", reason: "该扩展未安装、已卸载，或没有提供界面入口。" };
  if (!mount.available) return { kind: "unavailable", mount, reason: mount.reason ?? "扩展暂不可用。" };
  return { kind: "mounted", mount };
}

/** 扩展区导航项：只来自注册表。注册表失败时返回空，由壳显示原因。 */
export function extensionNavItems(state: ExtensionRegistryState): ExtensionMount[] {
  return state.kind === "ready" ? state.mounts : [];
}
