import { useCallback, useEffect, useRef, useState } from "react";
import { sessionsApi, jobsApi } from "../../../../frontend/src/api";
import { useChatStream } from "../../../../frontend/src/hooks/useChatStream";
import { useActiveTurn } from "../../../../frontend/src/hooks/useActiveTurn";
import { useWorkbenchStore, type ChatMsg } from "../../../../frontend/src/stores/workbench";
import { useSessionStore } from "../../../../frontend/src/stores/session";
import { scopedLocalStorageKey } from "../../../../frontend/src/utils/userScope";
import { isApiError } from "../../../../frontend/src/types";
import { MessageRow } from "../../../../frontend/src/pages/AgentWorkbench/components/MessageRow";
import { IconSparkle, IconSend, IconStop, IconPlus } from "../../../../frontend/src/components/Icon";
import type { Topology} from "./TopologyWorkspace";
import type { CanvasSelection } from "./canvasSelection";
import { resolveTopologySession } from "./TopologySessionResolver";
import { formatDate } from "../../../../frontend/src/utils/format";
import type { DrawingActivity } from "./topologyCollaboration";
import "../../../../frontend/src/pages/AgentWorkbench/AgentWorkbench.css";

const EMPTY: ChatMsg[] = [];
export type { CanvasSelection } from "./canvasSelection";

export function buildTopologyRequest(request: string) { return request.trim(); }

export function buildTopologySelection(topology: Topology, selection: CanvasSelection, allowEdit = true) {
  return { extension_id: "network.operations", skill_id: `drawing:${topology.topology_id}${allowEdit ? "" : ":ro"}`,
    resource_ids: [topology.topology_id], allow_edit: allowEdit, drawing_version: topology.version, canvas_selection: selection };
}

export function TopologyAgentPanel({ workspaceId, topology, selection, onCompleted, prepareDrawing, activities = [], onLocate, onUndoChange }: {
  workspaceId: string; topology: Topology; selection: CanvasSelection; onCompleted: () => void;
  prepareDrawing?: () => Promise<Topology>;
  activities?: DrawingActivity[];
  onLocate?: (ids: string[]) => void;
  onUndoChange?: (version: number) => void;
}) {
  const storageKey = scopedLocalStorageKey(`drawing_session_v2:${workspaceId}:${topology.topology_id}`);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [allowEdit, setAllowEdit] = useState(true);
  const sessionListVersion = useSessionStore((state) => state.sessionListVersion);
  const messages = useWorkbenchStore((state) => state.bySession[sessionId || ""] || EMPTY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const submittingRef = useRef(false);
  const refreshHistory = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await sessionsApi.messages(sessionId, workspaceId);
      useWorkbenchStore.getState().mergeFromBackend(sessionId, response.messages);
    } catch (err: unknown) {
      const isNotFound = (isApiError(err) && err.status === 404) ||
        (typeof err === "object" && err !== null && (err as { status?: number }).status === 404);
      if (isNotFound) {
        useWorkbenchStore.getState().clear(sessionId);
        try { localStorage.removeItem(storageKey); } catch {}
        setSessionId(null);
        setError("");
        return;
      }
      throw err;
    }
  }, [sessionId, workspaceId, storageKey]);
  const { send, stop, sending } = useChatStream({ workspaceId, sessionId, llmHealth: {} }, {
    onSessionResolved: setSessionId,
    onResult: () => { onCompleted(); },
    onInterruption: setError,
  });
  const { job, loaded, refresh } = useActiveTurn(workspaceId, sessionId, sending);
  const running = sending || job?.status === "running";

  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(storageKey); } catch {}
    if (!sessionId) {
      if (stored && stored !== sessionId) {
        setSessionId(stored);
      } else if (!stored) {
        resolveTopologySession(workspaceId, topology, false)
          .then((foundId) => {
            if (foundId) setSessionId(foundId);
          })
          .catch(() => {});
      }
    } else if (stored === sessionId) {
      try {
        localStorage.setItem(
          scopedLocalStorageKey(`workbench_skill:${sessionId}`),
          JSON.stringify({
            skill_key: `network.operations:drawing:${topology.topology_id}`,
            resource_ids: [topology.topology_id],
          }),
        );
      } catch {}
      if (!sending) {
        void refreshHistory().catch(() => setError("会话记录读取失败；已有会话保留，请重试加载。"));
      }
    } else if (!stored) {
      useWorkbenchStore.getState().clear(sessionId);
      setSessionId(null);
      setError("");
    }
  }, [sessionListVersion, sessionId, storageKey, refreshHistory, sending, topology, workspaceId]);
  useEffect(() => {
    if (!loaded || sending || !sessionId) return;
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => { void refreshHistory().catch(() => {}); }, 2500);
    return () => window.clearInterval(timer);
  }, [job?.status, loaded, sending, sessionId, refreshHistory]);
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleResetSession = async () => {
    if (running || !sessionId) return;
    if (!confirm("确定要为当前图纸开启新会话吗？既有对话将被清空并重新开始。")) return;
    const oldId = sessionId;
    try {
      await sessionsApi.delete(oldId, workspaceId).catch(() => {});
    } finally {
      useWorkbenchStore.getState().clear(oldId);
      try {
        localStorage.removeItem(storageKey);
        localStorage.removeItem(scopedLocalStorageKey(`workbench_skill:${oldId}`));
      } catch {}
      setSessionId(null);
      setError("");
      useSessionStore.getState().bumpSessionList();
    }
  };

  const submit = async (request = input) => {
    if (!request.trim() || running || preparing || submittingRef.current) return;
    submittingRef.current = true;
    setPreparing(true); setError("");
    const capturedSelection = { ...selection, node_ids: [...selection.node_ids], link_ids: [...selection.link_ids],
      canvas_item_ids: [...selection.canvas_item_ids], group_ids: [...selection.group_ids] };
    try {
      const baseline = prepareDrawing ? await prepareDrawing() : topology;
      let id = sessionId;
      if (!id) {
        id = await resolveTopologySession(workspaceId, topology, true);
        if (!id) return;
        setSessionId(id);
      } else {
        try {
          const response = await jobsApi.list(workspaceId);
          if (response.jobs?.some((item) => item.status === "running" && String(item.payload?.session_id || item.metadata?.active_turn?.session_id || "") === id)) {
            setError("此拓扑的任务仍在运行，可以继续查看进度。");
            return;
          }
        } catch {
          // If pre-flight jobs check encounters a network blip, proceed to send via websocket
        }
      }
      setInput(""); pinnedRef.current = true;
      await send({ text: buildTopologyRequest(request), attachments: [], effectiveSessionId: id,
        turnMetadata: { workbench_selection: buildTopologySelection(baseline, capturedSelection, allowEdit) },
      });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "发送失败，请检查服务连接后重试。"); }
    finally { setPreparing(false); submittingRef.current = false; }
  };
  const cancel = async () => {
    if (sending) stop();
    else if (job?.job_id) { await jobsApi.cancel(job.job_id, workspaceId); await refresh(); }
  };
  return <section className="topology-agent" aria-label="拓扑协作">
    <header>
      <IconSparkle size={18} />
      <div><strong>绘图对话</strong><small>围绕这张网络图持续对话</small></div>
      <div className="topology-agent-header-actions">
        {sessionId && messages.length > 0 && !running && (
          <button
            type="button"
            className="topology-agent-new-chat-btn"
            title="清空当前图纸对话，开启新会话"
            onClick={() => void handleResetSession()}
          >
            <IconPlus size={13} />
            <span>新对话</span>
          </button>
        )}
        <span className={running ? "agent-pulse" : ""}>{running ? "执行中" : "就绪"}</span>
      </div>
    </header>
    <div className="topology-agent-scope">
      <strong>{allowEdit ? "拓扑绘图 Skill" : "拓扑只读分析"}</strong>
      <div className="topology-context-chip">
        {selection.label}
        <small>{allowEdit ? "可修改当前图纸" : "只读模式，不可修改"}</small>
      </div>
    </div>
    {activities.length > 0 && <details className="topology-agent-activity" aria-label="图纸变化">
      <summary><strong>图纸变化记录</strong><span>{activities.length} 条 · 最新 v{activities[activities.length - 1].version}</span></summary>
      <div className="topology-agent-activity-list">
      {[...activities].reverse().map(activity => <div key={activity.version} className="topology-agent-change">
        <strong>图纸 v{activity.version} · {activity.source === "manual" ? "手动编辑 · " : "Agent · "}{activity.status === "displayed" ? "已保存并显示" : "已保存 · 待合并"}</strong>
        {activity.saved_at && <time dateTime={activity.saved_at}>{formatDate(activity.saved_at)}</time>}
        <span>新增 {activity.added} · 修改 {activity.modified} · 删除 {activity.removed}</span>
        {activity.removedLabels.length > 0 && <small title={activity.removedLabels.join("、")}>已删除：{activity.removedLabels.slice(0, 3).join("、")}{activity.removedLabels.length > 3 ? "…" : ""}</small>}
        <div>
          <button type="button" disabled={activity.status !== "displayed" || !activity.ids.length} onClick={() => onLocate?.(activity.ids)}>定位变化</button>
          {activity.status === "displayed" && (activity.revision_id || activity.before) && <button type="button" onClick={() => onUndoChange?.(activity.version)}>撤销这次变化</button>}
        </div>
      </div>)}
      </div>
    </details>}
    <div className="topology-agent-messages" ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50; }}>
      {!messages.length && <div className="topology-agent-intro"><IconSparkle size={28} /><h3>把想法画出来</h3><p>描述设备、连线与布局，或选中图纸对象让 Skill 修改。不连接真实设备。</p>{[
        ["绘制结构", "在当前图纸中添加两台交换机与一台路由器，分别命名并连线，排列整齐。"],
        ["整理布局", "整理当前图纸布局，保留已有对象与连接关系，避免标签重叠。"],
        ["添加标注", "为当前选中对象添加清晰的文字标注；如未选择对象，先询问标注内容。"],
      ].map(([label, prompt]) => <button key={label} onClick={() => setInput(prompt)}>{label}<span>→</span></button>)}</div>}
      {messages.map((message, index) => <MessageRow key={message.id} m={message} idx={index} total={messages.length} lastUserInput="" onRetryOriginal={() => {}} />)}
      {running && !sending && <p role="status">服务端任务仍在运行，正在同步结果…</p>}
    </div>
    {error && <div className="topology-agent-error" role="alert">{error}<button onClick={() => { void refreshHistory().then(() => setError("")).catch(() => {}); }}>重试加载</button></div>}
    <form className="topology-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        aria-label="拓扑协作指令"
        placeholder={allowEdit ? "描述你想画的设备、连线、分组或文字…" : "向 Agent 咨询拓扑结构、单点故障或连线分析（只读模式）…"}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (input.trim() && !running && !preparing) {
              void submit();
            }
          }
        }}
        rows={3}
      />
      <footer>
        <div className="topology-agent-composer-meta">
          <label className="topology-agent-allow-edit" title={allowEdit ? "已允许 Agent 修改图纸" : "已锁定为只读分析模式"}>
            <input
              type="checkbox"
              checked={allowEdit}
              onChange={(event) => setAllowEdit(event.target.checked)}
              disabled={running || preparing}
            />
            <span>允许修改拓扑</span>
          </label>
          <small>{preparing ? "正在确认图纸版本…" : `上下文：${selection.label}`}</small>
        </div>
        {running ? (
          <button type="button" className="topology-agent-stop-btn" onClick={() => void cancel()} title="停止当前生成任务">
            <IconStop size={14} />
            <span>停止</span>
          </button>
        ) : (
          <button
            type="submit"
            className="topology-agent-send-btn"
            disabled={!input.trim() || preparing}
            title={!input.trim() ? "输入内容后可发送" : preparing ? "正在建立连接..." : "发送指令 (Enter)"}
          >
            <IconSend size={14} />
            <span>{preparing ? "连接中" : "发送"}</span>
          </button>
        )}
      </footer>
    </form>
  </section>;
}
