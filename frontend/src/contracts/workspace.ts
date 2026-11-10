/**
 * 工作区契约（A13-切换）。列表来自 `GET /api/workspaces`，禁止写死 default 工作区。
 * 当前工作区选择顺序：URL `?ws=` → 本地记忆（且仍在列表中）→ auth.home_workspace_id → 列表第一项。
 */
export interface WorkspaceSummary {
  workspace_id: string;
  name?: string;
  organization_id?: string;
  is_default?: boolean;
}

export function workspaceDisplayName(ws: WorkspaceSummary): string {
  return ws.name && ws.name.trim() ? ws.name : ws.workspace_id;
}

export function pickCurrentWorkspace(
  list: WorkspaceSummary[],
  prefs: { fromUrl?: string | null; remembered?: string | null; home?: string | null },
): string | null {
  const ids = new Set(list.map((w) => w.workspace_id));
  for (const candidate of [prefs.fromUrl, prefs.remembered, prefs.home]) {
    if (candidate && ids.has(candidate)) return candidate;
  }
  return list[0]?.workspace_id ?? null;
}
