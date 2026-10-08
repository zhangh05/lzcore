import { useEffect, useRef, useState } from "react";
import { useAsync, AsyncView } from "../components/common";
import { sessionsApi } from "../api";
import { useSessionStore, useUIStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";
import { useToastStore } from "../stores/toast";
import { isApiError } from "../types";
import type { Session } from "../types";
import { IconArchive, IconChecklist, IconChevronRight, IconClose, IconEdit, IconMore, IconPlus, IconSearch, IconTrash, IconWorkspace } from "../components/Icon";
import { confirm } from "../components/ConfirmDialog";
import { APP_EVENTS } from "../utils/appEvents";
import { useNavigate } from "../router";

const SESSION_PREVIEW_LIMIT = 12;

/** Workspace and conversation navigation; execution history belongs to /runs. */
export function Sidebar() {
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const switchWbSession = useWorkbenchStore((s) => s.switchSession);
  const toast = useToastStore((s) => s.show);
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  const [editingSessId, setEditingSessId] = useState<string | null>(null);
  const [editingSessName, setEditingSessName] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const pendingCreatedSessionIdRef = useRef<string | null>(null);

  const navigate = useNavigate();

  const sessList = useAsync<{ sessions: Session[] }>(
    (s) => sessionsApi.list(currentWorkspaceId, "active", s),
    [currentWorkspaceId],
    (d) => (d.sessions ?? []).length === 0,
  );
  // Keep session navigation fresh after completed turns and cross-page edits.
  const sessListRef = useRef(sessList.reload);
  sessListRef.current = sessList.reload;

  // Cross-page session-list invalidation: any component (e.g. OperationsPage
  // restoring a session) bumps sessionListVersion and the sidebar re-fetches.
  const sessionListVersion = useSessionStore((s) => s.sessionListVersion);
  const firstSessionBump = useRef(true);
  useEffect(() => {
    if (firstSessionBump.current) { firstSessionBump.current = false; return; }
    sessListRef.current();
  }, [sessionListVersion]);

  useEffect(() => {
    const onRunCompleted = () => {
      sessListRef.current();
    };
    window.addEventListener(APP_EVENTS.RUN_COMPLETED, onRunCompleted);
    return () => window.removeEventListener(APP_EVENTS.RUN_COMPLETED, onRunCompleted);
  }, []);

  useEffect(() => {
    const pendingCreatedSessionId = pendingCreatedSessionIdRef.current;
    if (sessList.state.kind === "empty") {
      if (!pendingCreatedSessionId && currentSessionId) { setCurrentSession(null); switchWbSession(null); }
      return;
    }
    if (sessList.state.kind !== "success") return;
    if (pendingCreatedSessionId) {
      pendingCreatedSessionIdRef.current = null;
      setCurrentSession(pendingCreatedSessionId);
      switchWbSession(pendingCreatedSessionId);
      return;
    }
    const sessions = sessList.state.data.sessions ?? [];
    if (!currentSessionId || !sessions.some((s) => s.session_id === currentSessionId)) {
      const fallbackSessionId = sessions[0]?.session_id ?? null;
      setCurrentSession(fallbackSessionId);
      switchWbSession(fallbackSessionId);
    }
  }, [currentSessionId, currentWorkspaceId, sessList.state, setCurrentSession, switchWbSession]);

  async function onNewSession() {
    if (!currentWorkspaceId) {
      toast({ kind: "warning", title: "未选择 workspace" });
      return;
    }
    try {
      const res = await sessionsApi.create(currentWorkspaceId, "");
      if (res?.session) {
        pendingCreatedSessionIdRef.current = res.session.session_id;
        setCurrentSession(res.session.session_id);
        switchWbSession(res.session.session_id);
        sessList.reload();
        toast({ kind: "success", title: "新会话已创建", body: res.session.session_id });
      }
    } catch (e: unknown) {
      toast({
        kind: "error",
        title: "创建会话失败",
        body: isApiError(e) ? e.message : String(e),
        request_id: isApiError(e) ? e.request_id : undefined,
      });
    }
  }

  async function onArchive(sess: Session) {
    if (!currentWorkspaceId) return;
    try {
      await sessionsApi.archive(sess.session_id, currentWorkspaceId);
      if (currentSessionId === sess.session_id) {
        setCurrentSession(null);
      }
      useSessionStore.getState().bumpSessionList();
      toast({ kind: "success", title: "已归档", body: sess.session_id });
    } catch (e: unknown) {
      toast({
        kind: "error",
        title: "归档失败",
        body: isApiError(e) ? e.message : String(e),
        request_id: isApiError(e) ? e.request_id : undefined,
      });
    }
  }

  async function onRenameSession(sess_id: string) {
    if (!editingSessName.trim() || !currentWorkspaceId) { cancelEditSession(); return; }
    try {
      await sessionsApi.rename(sess_id, currentWorkspaceId, editingSessName.trim());
      useSessionStore.getState().bumpSessionList();
      toast({ kind: "success", title: "会话已重命名" });
      cancelEditSession();
    } catch (e: unknown) {
      toast({ kind: "error", title: "重命名失败", body: isApiError(e) ? e.message : String(e) });
    }
  }

  async function onDeleteSession(sess: Session) {
    if (!currentWorkspaceId) return;
    const accepted = await confirm({
      title: "永久删除会话？",
      body: `「${sess.title || sess.session_id}」的消息和记录将被彻底清除，此操作不可撤销。`,
      confirmLabel: "永久删除",
      destructive: true,
    });
    if (!accepted) return;
    try {
      await sessionsApi.delete(sess.session_id, currentWorkspaceId);
      useWorkbenchStore.getState().clear(sess.session_id);
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.includes("drawing_session_v2") && localStorage.getItem(k) === sess.session_id) {
            localStorage.removeItem(k);
          }
        }
      } catch { /* ignore storage error */ }
      if (currentSessionId === sess.session_id) { setCurrentSession(null); switchWbSession(null); }
      useSessionStore.getState().bumpSessionList();
      toast({ kind: "success", title: "已永久删除", body: sess.session_id });
    } catch (e: unknown) {
      // 404 = already deleted on disk → just reload the list
      if (isApiError(e) && e.status === 404) {
        useWorkbenchStore.getState().clear(sess.session_id);
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.includes("drawing_session_v2") && localStorage.getItem(k) === sess.session_id) {
              localStorage.removeItem(k);
            }
          }
        } catch { /* ignore storage error */ }
        if (currentSessionId === sess.session_id) { setCurrentSession(null); switchWbSession(null); }
        useSessionStore.getState().bumpSessionList();
        return;
      }
      toast({ kind: "error", title: "删除失败", body: isApiError(e) ? e.message : String(e) });
    }
  }

  function startEditSession(sess: Session) {
    setEditingSessId(sess.session_id);
    setEditingSessName(sess.title || "");
  }

  function cancelEditSession() {
    setEditingSessId(null);
    setEditingSessName("");
  }

  return (
    <div data-testid="sidebar" className="sidebar-content">
      <div className="sidebar-workspace" title={currentWorkspaceId || "未选择工作区"}>
        <span className="sidebar-workspace-mark" aria-hidden="true"><IconWorkspace size={16} /></span>
        <div><strong>{currentWorkspaceId || "未选择"}</strong><span>当前工作区</span></div>
      </div>
      <div className="sidebar-shortcuts" aria-label="工作台快捷操作">
        <button
          className="sidebar-shortcut sidebar-new-session"
          onClick={onNewSession}
          disabled={!currentWorkspaceId}
          data-testid="btn-new-session"
          type="button"
        >
          <IconPlus size={16} weight="bold" aria-hidden="true" /><span>新会话</span>
        </button>
      </div>

      {/* 会话 */}
      <div className="sidebar-panel sidebar-session-panel">
        <div className="sidebar-panel-title">
          <span>最近会话</span>
          {sessList.state.kind === "success" && (sessList.state.data.sessions ?? []).length > 0 ? (
            <span className="sidebar-panel-count" aria-label={`共 ${(sessList.state.data.sessions ?? []).length} 个活跃会话`}>
              {(sessList.state.data.sessions ?? []).length}
            </span>
          ) : null}
        </div>
        {sessList.state.kind === "success" && (sessList.state.data.sessions ?? []).length > 3 ? (
          <label className="sidebar-search">
            <IconSearch size={14} aria-hidden="true" />
            <span className="sr-only">筛选会话</span>
            <input
              type="search"
              value={sessionQuery}
              placeholder="筛选会话"
              onChange={(event) => setSessionQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && sessionQuery) { event.stopPropagation(); setSessionQuery(""); } }}
              data-testid="sidebar-session-filter"
            />
          </label>
        ) : null}
        <AsyncView
          state={sessList.state}
          onRetry={sessList.reload}
          skeleton="list"
          emptyText="暂无活跃会话"
          emptyHint="点击 + 新建"
        >
          {(d) => {
            const query = sessionQuery.trim().toLocaleLowerCase();
            const source = query
              ? (d.sessions ?? []).filter((sess) => (sess.title || sess.session_id).toLocaleLowerCase().includes(query))
              : (d.sessions ?? []);
            const preview = previewSessions(source, query ? null : currentSessionId);
            const hiddenCount = hiddenSessionCount(source, query ? null : currentSessionId);
            return (
            <div className="list" data-testid="sess-list">
              {preview.map((sess) => (
                <div
                  key={sess.session_id}
                  className={
                    "list-item session-item" +
                    (currentSessionId === sess.session_id ? " active" : "")
                  }
                  data-testid={`sess-${sess.session_id}`}
                >
                  <button
                    onClick={() => { cancelEditSession(); setCurrentSession(sess.session_id); switchWbSession(sess.session_id); setMobileNavOpen(false); }}
                    data-testid={`sess-btn-${sess.session_id}`}
                    aria-label={`会话：${sess.title || sess.session_id}`}
                    type="button"
                    className="session-item-main"
                  >
                    {editingSessId === sess.session_id ? (
                      <input
                        className="input input-xs"
                        value={editingSessName}
                        onChange={(e) => setEditingSessName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.stopPropagation(); void onRenameSession(sess.session_id); }
                          if (e.key === "Escape") { e.stopPropagation(); cancelEditSession(); }
                        }}
                        onBlur={cancelEditSession}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="title" title={sess.title || sess.session_id}>
                        {sess.title || sess.session_id}
                      </span>
                    )}
                    {sess.message_count > 0 && (
                      <span className="meta">{sess.message_count}</span>
                    )}
                  </button>
                  {editingSessId === sess.session_id ? (
                    <div className="row-flex-xs">
                      <button className="btn sm btn-xs" onClick={(e) => { e.stopPropagation(); void onRenameSession(sess.session_id); }} type="button">保存</button>
                      <button className="btn sm ghost btn-xs-compact" aria-label="取消重命名" onClick={(e) => { e.stopPropagation(); cancelEditSession(); }} type="button"><IconClose size={13} aria-hidden="true" /></button>
                    </div>
                  ) : (
                    <details className="session-menu">
                      <summary
                        onClick={(e) => e.stopPropagation()}
                        className="btn ghost sm icon-only session-more-trigger"
                        title="会话操作"
                        aria-label={`打开“${sess.title || sess.session_id}”的会话操作`}
                        data-testid={`session-menu-trigger-${sess.session_id}`}
                      >
                        <IconMore size={15} weight="bold" />
                      </summary>
                      <div className="session-action-menu" role="menu" aria-label="会话操作">
                        <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); e.currentTarget.closest("details")?.removeAttribute("open"); startEditSession(sess); }}>
                          <IconEdit size={14} /><span>重命名</span>
                        </button>
                        <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); e.currentTarget.closest("details")?.removeAttribute("open"); void onArchive(sess); }} data-testid={`btn-archive-${sess.session_id}`}>
                          <IconArchive size={14} /><span>归档</span>
                        </button>
                        <button type="button" role="menuitem" className="danger" onClick={(e) => { e.stopPropagation(); e.currentTarget.closest("details")?.removeAttribute("open"); void onDeleteSession(sess); }}>
                          <IconTrash size={14} /><span>永久删除</span>
                        </button>
                      </div>
                    </details>
                  )}
                </div>
              ))}
              {query && preview.length === 0 ? (
                <div className="list-item muted-row" role="status">
                  <span className="meta">没有匹配“{sessionQuery.trim()}”的会话</span>
                </div>
              ) : null}
              {hiddenCount > 0 && (
                <div className="list-item muted-row">
                  <span className="meta">
                    另有 {hiddenCount} 个活跃会话
                  </span>
                </div>
              )}
            </div>
            );
          }}
        </AsyncView>
      </div>

      <button type="button" className="sidebar-history-link" onClick={() => {
        setMobileNavOpen(false);
        navigate("/runs");
      }}><IconChecklist size={16} aria-hidden="true" /><span>任务与运行记录</span><IconChevronRight className="sidebar-history-tail" size={12} aria-hidden="true" /></button>
    </div>
  );
}

function previewSessions(sessions: Session[], currentSessionId: string | null): Session[] {
  const preview = sessions.slice(0, SESSION_PREVIEW_LIMIT);
  if (!currentSessionId || preview.some((s) => s.session_id === currentSessionId)) {
    return preview;
  }
  const selected = sessions.find((s) => s.session_id === currentSessionId);
  return selected ? [...preview, selected] : preview;
}

function hiddenSessionCount(sessions: Session[], currentSessionId: string | null): number {
  return Math.max(0, sessions.length - previewSessions(sessions, currentSessionId).length);
}
