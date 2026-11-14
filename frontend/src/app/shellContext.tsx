import { setDesktopPrincipal } from "../desktop/bridge";
import { clearLocalAuth } from "../api/localAuth";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { httpGet } from "../api/http";
import type { AuthStatus } from "../contracts/auth";
import { registryFromResponse, type ExtensionRegistryState } from "../contracts/extensions";
import { pickCurrentWorkspace, type WorkspaceSummary } from "../contracts/workspace";
import { useLocation, useNavigate } from "../router";
import { scopedKey } from "./prefs";
import { clearApiCache } from "../kit/useApi";

type WorkspacesState =
  | { kind: "loading" }
  | { kind: "ready"; list: WorkspaceSummary[] }
  | { kind: "error"; reason: string };

interface ShellValue {
  auth: AuthStatus;
  workspaces: WorkspacesState;
  workspaceId: string | null;
  switchWorkspace: (id: string) => void;
  extensions: ExtensionRegistryState;
  /** 带上当前工作区的应用内路径。 */
  hrefFor: (path: string) => string;
  signOut: () => Promise<void>;
}

const ShellContext = createContext<ShellValue | null>(null);

/** 可选读取：组件在没有外壳的地方（独立渲染、测试）也能退回默认值。 */
export function useOptionalShell(): ShellValue | null {
  return useContext(ShellContext);
}

export function useShell(): ShellValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error("ShellProvider is required");
  return v;
}

export function withWorkspace(path: string, ws: string | null): string {
  if (!ws) return path;
  const [base, hash = ""] = path.split("#");
  const url = new URL(base, "http://app.local");
  url.searchParams.set("ws", ws);
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`;
}

export function ShellProvider({ auth, onSignedOut, children }: { auth: AuthStatus; onSignedOut: () => void; children: ReactNode }) {
  useEffect(() => { setDesktopPrincipal(auth.username ?? ""); return () => setDesktopPrincipal(""); }, [auth.username]);
  const location = useLocation();
  const navigate = useNavigate();
  const urlWs = new URLSearchParams(location.search).get("ws");
  const rememberKey = scopedKey(auth.username, "workspace");
  const [workspaces, setWorkspaces] = useState<WorkspacesState>({ kind: "loading" });
  const [extensions, setExtensions] = useState<ExtensionRegistryState>({ kind: "loading" });

  useEffect(() => {
    let off = false;
    void httpGet("/api/workspaces").then((o) => {
      if (off) return;
      if (o.kind === "network_error") return setWorkspaces({ kind: "error", reason: "无法连接服务，工作区列表未读取。" });
      const list = (o.body as { workspaces?: WorkspaceSummary[] })?.workspaces;
      if (o.status !== 200 || !Array.isArray(list)) return setWorkspaces({ kind: "error", reason: `工作区列表读取失败（HTTP ${o.status}）。` });
      setWorkspaces({ kind: "ready", list: list.filter((w) => w && typeof w.workspace_id === "string") });
    });
    void httpGet("/api/extensions").then((o) => {
      if (off) return;
      if (o.kind === "network_error") return setExtensions({ kind: "error", reason: "无法连接服务" });
      if (o.status !== 200) return setExtensions({ kind: "error", reason: `HTTP ${o.status}` });
      setExtensions(registryFromResponse(o.body, auth.role || undefined));
    });
    return () => { off = true; };
  }, [auth.role]);

  const workspaceId = useMemo(() => {
    if (workspaces.kind !== "ready") return null;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(rememberKey); } catch { /* ignore */ }
    return pickCurrentWorkspace(workspaces.list, { fromUrl: urlWs, remembered, home: auth.home_workspace_id });
  }, [workspaces, urlWs, rememberKey, auth.home_workspace_id]);

  // 让 URL 始终带上当前工作区（工作区是一等公民，可分享）。
  useEffect(() => {
    if (workspaceId && urlWs !== workspaceId) {
      navigate(withWorkspace(`${location.pathname}${location.search}${location.hash}`, workspaceId), { replace: true });
    }
  }, [workspaceId, urlWs, location.pathname, location.search, location.hash, navigate]);


  const switchWorkspace = useCallback((id: string) => {
    try { localStorage.setItem(rememberKey, id); } catch { /* ignore */ }
    navigate(withWorkspace(location.pathname, id));
  }, [rememberKey, navigate, location.pathname]);

  const hrefFor = useCallback((path: string) => withWorkspace(path, workspaceId), [workspaceId]);
  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    clearLocalAuth();
    clearApiCache();
    onSignedOut();
  }, [onSignedOut]);

  const value: ShellValue = { auth, workspaces, workspaceId, switchWorkspace, extensions, hrefFor, signOut };
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
