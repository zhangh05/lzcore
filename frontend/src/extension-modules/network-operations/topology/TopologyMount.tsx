/**
 * 旧拓扑画布（TopologyPage → TopologyWorkspace，原样迁入）接到新壳的挂载点：
 * - 工作区 / 用户名从新壳注入旧 session store（旧画布按 workspaceId 读写，不回落任何默认工作区）
 * - 深链：进入时把旧 `topology_id` / 通用 `id` 规范化成 `topology`（P-30）
 * - 未保存守卫：旧画布通过 desktopDirty 报告未保存键 → 新壳 useNavigationGuard（站内跳转 + beforeunload）
 * - 旧画布依赖的全局确认框 / 表单框宿主（ConfirmHost / FormDialogHost）在这里挂一次
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigationGuard } from "../../../router";
import TopologyPage from "./TopologyPage";
import { useSessionStore } from "./platform/stores/session";
import { isAnyDirty, onDirtyChange } from "./platform/desktop/bridge";
import { ConfirmHost } from "./platform/components/ConfirmDialog";
import { FormDialogHost } from "./platform/components/FormDialog";
import { normalizeTopologyHref, readTopologyParam } from "./topologyParams";

export const TOPOLOGY_UNSAVED_MESSAGE = "拓扑有未保存的改动，确定离开吗？";

export default function TopologyMount({ ws, username }: { ws: string; username: string }) {
  const storeWs = useSessionStore((s) => s.currentWorkspaceId);
  useEffect(() => {
    useSessionStore.getState().setWorkspace(ws);
    useSessionStore.getState().setUsername(username);
  }, [ws, username]);
  useEffect(() => {
    const next = normalizeTopologyHref(window.location.href);
    if (next) window.history.replaceState(window.history.state, "", next);
  }, []);

  const [dirty, setDirty] = useState(isAnyDirty());
  useEffect(() => onDirtyChange(setDirty), []);
  // 同一画布内（仍在拓扑 tab、且是同一张图）的 URL 改动不拦；离开拓扑或换图都要确认。
  const shouldBlock = useCallback((target: string) => {
    const t = new URL(target, window.location.origin);
    const here = new URL(window.location.href);
    if (t.pathname !== here.pathname) return true;
    if ((t.searchParams.get("tab") ?? "") !== "topologies") return true;
    const want = readTopologyParam(t.search);
    return Boolean(want) && want !== readTopologyParam(here.search);
  }, []);
  useNavigationGuard(dirty, TOPOLOGY_UNSAVED_MESSAGE, shouldBlock);

  return (
    <div className="topology-mount" data-testid="topology-mount" data-dirty={dirty ? "1" : "0"}>
      {storeWs === ws ? <TopologyPage /> : <p className="muted">正在打开图纸…</p>}
      <ConfirmHost />
      <FormDialogHost />
    </div>
  );
}
