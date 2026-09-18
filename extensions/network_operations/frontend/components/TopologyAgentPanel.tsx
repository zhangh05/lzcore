import { useCallback, useEffect, useRef, useState } from "react";
import { sessionsApi, jobsApi } from "../../../../frontend/src/api";
import { useChatStream } from "../../../../frontend/src/hooks/useChatStream";
import { useActiveTurn } from "../../../../frontend/src/hooks/useActiveTurn";
import { useWorkbenchStore, type ChatMsg } from "../../../../frontend/src/stores/workbench";
import { useSessionStore } from "../../../../frontend/src/stores/session";
import { scopedLocalStorageKey } from "../../../../frontend/src/utils/userScope";
import { MessageRow } from "../../../../frontend/src/pages/AgentWorkbench/components/MessageRow";
import { IconSparkle, IconSend, IconStop } from "../../../../frontend/src/components/Icon";
import type { Topology} from "./TopologyWorkspace";
import type { CanvasSelection } from "./canvasSelection";
import "../../../../frontend/src/pages/AgentWorkbench/AgentWorkbench.css";

const EMPTY: ChatMsg[] = [];
export type { CanvasSelection } from "./canvasSelection";

export function buildTopologyRequest(topology: Topology, selection: CanvasSelection, request: string) {
  return `${request}\n\n当前图纸上下文：\n${JSON.stringify({ topology_id: topology.topology_id, version: topology.version, selection })}\n请先读取当前图纸，再按要求绘图。只修改用户要求的对象，不查询或操作真实设备。`;
}

export function TopologyAgentPanel({ workspaceId, topology, selection, onCompleted }: {
  workspaceId: string; topology: Topology; selection: CanvasSelection; onCompleted: () => void;
}) {
  const storageKey = scopedLocalStorageKey(`drawing_session_v2:${workspaceId}:${topology.topology_id}`);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const messages = useWorkbenchStore((state) => state.bySession[sessionId || ""] || EMPTY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const submittingRef = useRef(false);
  const refreshHistory = useCallback(async () => {
    if (!sessionId) return;
    const response = await sessionsApi.messages(sessionId, workspaceId);
    useWorkbenchStore.getState().mergeFromBackend(sessionId, response.messages);
  }, [sessionId, workspaceId]);
  const { send, stop, sending } = useChatStream({ workspaceId, sessionId, llmHealth: {} }, {
    onSessionResolved: setSessionId,
    onResult: () => { onCompleted(); },
    onInterruption: setError,
  });
  const { job, loaded, refresh } = useActiveTurn(workspaceId, sessionId, sending);
  const running = sending || job?.status === "running";

  useEffect(() => { void refreshHistory().catch(() => setError("会话记录读取失败；已有会话保留，请重试加载。")); }, [refreshHistory]);
  useEffect(() => {
    if (!loaded || sending) return;
    void refreshHistory().catch(() => setError("会话记录同步失败。"));
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => { void refreshHistory().catch(() => {}); }, 2500);
    return () => window.clearInterval(timer);
  }, [job?.status, loaded, sending, refreshHistory]);
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const submit = async (request = input) => {
    if (!request.trim() || running || preparing || submittingRef.current || !loaded && sessionId) return;
    submittingRef.current = true;
    setPreparing(true); setError("");
    try {
      let id = sessionId;
      if (!id) {
        const created = await sessionsApi.create(workspaceId, `拓扑 · ${topology.name}`);
        id = created.session.session_id;
        setSessionId(id);
        try { localStorage.setItem(storageKey, id); } catch { /* session remains available via task history */ }
        useSessionStore.getState().bumpSessionList();
      } else {
        const response = await jobsApi.list(workspaceId);
        if (response.jobs.some((item) => item.status === "running" && String(item.payload?.session_id || item.metadata?.active_turn?.session_id || "") === id)) { setError("此拓扑的任务仍在运行，可以继续查看进度。"); return; }
      }
      setInput(""); pinnedRef.current = true;
      await send({ text: buildTopologyRequest(topology, selection, request.trim()), attachments: [], effectiveSessionId: id,
        turnMetadata: { workbench_selection: { extension_id: "network.operations", skill_id: `drawing:${topology.topology_id}`, resource_ids: [topology.topology_id] } },
      });
      await refresh();
    } catch { setError("发送失败，请检查服务连接后重试。"); }
    finally { setPreparing(false); submittingRef.current = false; }
  };
  const cancel = async () => {
    if (sending) stop();
    else if (job?.job_id) { await jobsApi.cancel(job.job_id, workspaceId); await refresh(); }
  };
  return <section className="topology-agent" aria-label="拓扑协作">
    <header><IconSparkle size={18} /><div><strong>绘图对话</strong><small>围绕这张网络图持续对话</small></div><span className={running ? "agent-pulse" : ""}>{running ? "执行中" : "就绪"}</span></header>
    <div className="topology-agent-scope"><strong>拓扑绘图 Skill</strong><div className="topology-context-chip">{selection.label}<small>仅操作当前图纸</small></div></div>
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
      <textarea aria-label="拓扑协作指令" placeholder="描述你想画的设备、连线、分组或文字…" value={input} onChange={(event) => setInput(event.target.value)} rows={3} />
      {/* The footer must agree with the scope chip above. Counting devices said
    "whole topology" for a selection of unlinked nodes, contradicting the
    "2 nodes selected" right above it. */}
            <footer><small>{`上下文：${selection.label}`}</small>{running ? <button type="button" onClick={() => void cancel()}><IconStop size={14} />停止</button> : <button type="submit" disabled={!input.trim() || preparing || (!!sessionId && !loaded)}><IconSend size={14} />{preparing ? "连接中" : "发送"}</button>}</footer>
    </form>
  </section>;
}
