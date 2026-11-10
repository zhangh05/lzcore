import { useSessionStore } from "../stores/session";

export function activeUsername(): string {
  return useSessionStore.getState().username;
}

/** 本地存储键按用户 + 工作区隔离；工作区缺失时用 "_none"，不回落任何真实工作区名。 */
export function scopedLocalStorageKey(base: string, includeWorkspace = true): string {
  const username = encodeURIComponent(activeUsername() || "public");
  if (!includeWorkspace) return `${base}:${username}`;
  const ws = encodeURIComponent(useSessionStore.getState().currentWorkspaceId || "_none");
  return `${base}:${username}:${ws}`;
}
