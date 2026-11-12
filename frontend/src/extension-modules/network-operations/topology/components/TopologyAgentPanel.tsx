/**
 * 绘图助手（画布内对话）：迁自 frontend-legacy 版 TopologyAgentPanel，改接新前端的回合合同。
 * - 会话：仍由 resolveTopologySession 保证「1 张图 1 个会话」；首次发送才创建。
 * - 发送：新前端 /ws/agent 回合通道（realtime/TurnTransport，按 client_request_id 幂等；断线只续传 / 回读，绝不自动重发）。
 *   metadata.workbench_selection 带 drawing skill、resource_ids、allow_edit、drawing_version 与画布选择。
 * - 发送前先 prepareDrawing()：冲刷本地未保存改动并以服务端版本为基线（失败则不发送）。
 * - 回合终态后：回读会话消息（服务端终态优先），再 onCompleted() 让画布回读服务端图纸版本；面板显示发送时 / 回读后的版本号。
 * - 未知写入（连接中断、结果未知）只提示核对，不自动重放。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, bodyOf, describeFailure, enc, stableId } from "../../../../api/client";
import { clearLocalAuth, ensureLocalBrowserToken } from "../../../../api/localAuth";
import { TurnTransport, turnErrorText, wsUrl, type Frame, type TurnHandlers } from "../../../../realtime/turnTransport";
import { emitTopologyUpdated } from "../platform/realtime/turnTransport";
import { renderMarkdown } from "../../../../utils/markdown";
import { useNavigate } from "../platform/router";
import { IconSparkle, IconClose, IconSend, IconStop } from "../platform/components/Icon";
import type { Topology } from "./topologyDocument";
import type { CanvasSelection } from "./canvasSelection";
import { resolveTopologySession } from "./TopologySessionResolver";
import type { DrawingActivity } from "./topologyCollaboration";

export type { CanvasSelection } from "./canvasSelection";

export function buildTopologyRequest(request: string) {
  return request.trim();
}

export function buildTopologySelection(topology: Topology, selection: CanvasSelection, allowEdit = true) {
  return {
    extension_id: "network.operations",
    skill_id: `drawing:${topology.topology_id}${allowEdit ? "" : ":ro"}`,
    resource_ids: [topology.topology_id],
    allow_edit: allowEdit,
    drawing_version: topology.version,
    canvas_selection: selection,
  };
}

interface PanelMessage { message_id?: string; role: string; content: string; created_at?: string; run_id?: string; ok?: boolean; errors?: unknown[]; metadata?: Record<string, unknown> }
interface LivePanelTurn { clientRequestId: string; sessionId: string; text: string; status: string; jobId?: string; baseVersion: number }

const PROMPTS: [string, string][] = [
  ["绘制结构", "在当前图纸中添加两台交换机与一台路由器，分别命名并连线，排列整齐。"],
  ["整理布局", "整理当前图纸布局，保留已有对象与连接关系，避免标签重叠。"],
  ["添加标注", "为当前选中对象添加清晰的文字标注；如未选择对象，先询问标注内容。"],
];

export function TopologyAgentPanel({
  workspaceId, topology, selection, onCompleted, prepareDrawing, activities = [], onLocate, onUndoChange, onClose,
}: {
  workspaceId: string;
  topology: Topology;
  selection: CanvasSelection;
  /** 回合终态后让画布回读服务端图纸；返回 false 表示回读失败。 */
  onCompleted: () => void | Promise<boolean | void>;
  prepareDrawing?: () => Promise<Topology>;
  activities?: DrawingActivity[];
  onLocate?: (ids: string[]) => void;
  onUndoChange?: (version: number) => void;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [live, setLive] = useState<LivePanelTurn | null>(null);
  const [input, setInput] = useState("");
  const [allowEdit, setAllowEdit] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [versionNote, setVersionNote] = useState<{ before: number; readback: "reading" | "done" | "failed" } | null>(null);
  const submittingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef<TurnTransport | null>(null);

  const loadMessages = useCallback(async (sid: string) => {
    const o = await api.get(`/api/sessions/${enc(sid)}/messages`, { workspace_id: workspaceId });
    const list = bodyOf<{ messages?: PanelMessage[] }>(o)?.messages;
    if (o.kind === "http" && o.status === 200 && Array.isArray(list)) { setMessages(list); return true; }
    if (o.kind === "http" && o.status === 404) { setSessionId(null); setMessages([]); return false; }
    setError(`会话记录读取失败：${describeFailure(o)}`);
    return false;
  }, [workspaceId]);

  // 只查找已有的本图会话，不在打开面板时创建。
  useEffect(() => {
    let off = false;
    resolveTopologySession(workspaceId, topology, false).then((id) => { if (!off && id) setSessionId(id); }).catch(() => undefined);
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, topology.topology_id]);
  // 首次发送时由 submit 新建会话：此时服务端还没有这轮消息，回读会把刚发出的用户消息冲掉；终态后 settle 会再回读。
  const createdBySubmitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || createdBySubmitRef.current === sessionId) return;
    void loadMessages(sessionId);
  }, [sessionId, loadMessages]);

  useEffect(() => {
    const t = new TurnTransport({
      url: wsUrl(),
      readback: async (sid, crid) => {
        const o = await api.get(`/api/sessions/${enc(sid)}/messages`, { workspace_id: workspaceId });
        return (bodyOf<{ messages?: PanelMessage[] }>(o)?.messages ?? []).some((m) => m.role === "assistant" && m.metadata?.client_request_id === crid);
      },
      // 助手每次写入图纸，服务端都会广播 topology_updated；转给画布，回合进行中就能看到图在长。
      onBroadcast: (name, data) => { if (name === "topology_updated") emitTopologyUpdated(data); },
      onAuthRejected: () => { clearLocalAuth(); return ensureLocalBrowserToken(); },
    });
    transportRef.current = t;
    return () => { t.close(); transportRef.current = null; };
  }, [workspaceId]);
  // 有本图会话才可能有助手在写这张图（面板里或工作台里发起）：此时订阅工作区广播，画布随写入实时更新。
  // 服务端在 ping / resume 上同样校验本机浏览器令牌，先确保拿到再连。
  useEffect(() => {
    if (!sessionId) return;
    let off = false;
    void ensureLocalBrowserToken().then(() => { if (!off) transportRef.current?.subscribeBroadcasts(workspaceId); }).catch(() => undefined);
    return () => { off = true; };
  }, [sessionId, workspaceId]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, live?.text]);

  // 画布回读（或实时推送）到的新版本落在 topology.version 上；变了就不必再等回读结果。
  useEffect(() => { if (versionNote?.readback === "reading" && topology.version !== versionNote.before) setVersionNote({ ...versionNote, readback: "done" }); }, [topology.version, versionNote]);

  // 画布按服务端版本回读（reconcileServerTopology），不在这里拼本地结果；读完才能下「有没有新版本」的结论。
  const readbackDrawing = useCallback(async (before: number) => {
    setVersionNote({ before, readback: "reading" });
    let ok = false;
    try { ok = (await onCompleted()) !== false; } catch { ok = false; }
    setVersionNote((v) => v && v.before === before ? { before, readback: ok ? "done" : "failed" } : v);
  }, [onCompleted]);

  const settle = useCallback(async (sid: string, before: number, note?: string) => {
    await loadMessages(sid);
    setLive(null);
    if (note) setError(note);
    await readbackDrawing(before);
  }, [loadMessages, readbackDrawing]);

  const turnHandlers = useCallback((sid: string, baseVersion: number): TurnHandlers => ({
    onToken: (t) => setLive((l) => l && { ...l, text: l.text + t, status: "生成中" }),
    onEvent: (name, data) => setLive((l) => l && { ...l, jobId: String(data.job_id ?? l.jobId ?? "") || undefined, status: name === "tool_call" ? `调用工具 ${String(data.tool_id ?? "")}` : name === "model_started" ? "模型处理中" : l.status }),
    onDone: () => void settle(sid, baseVersion),
    onError: (f: Frame) => void settle(sid, baseVersion, turnErrorText(f)),
    onTransport: (s) => {
      if (s === "interrupted") setLive((l) => l && { ...l, status: "连接中断 · 回合可能仍在执行，正在续传 / 回读（不会自动重发）" });
      if (s === "resumed") setLive((l) => l && { ...l, status: "已重新连接 · 续传中" });
      if (s === "readback_terminal") void settle(sid, baseVersion);
    },
  }), [settle]);

  // 面板重新挂载（切到工作台再回来、刷新页面）时，上一轮可能仍在服务端执行：找到它并只续传，不重发。
  const attachedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || live || createdBySubmitRef.current === sessionId || attachedRef.current === sessionId) return;
    attachedRef.current = sessionId;
    let off = false;
    void (async () => {
      const o = await api.get("/api/jobs", { workspace_id: workspaceId, status: "running", job_type: "agent_run", limit: 50 });
      const jobs = bodyOf<{ jobs?: Array<{ job_id?: string; metadata?: { active_turn?: { session_id?: string; client_request_id?: string; status?: string } } }> }>(o)?.jobs ?? [];
      const job = jobs.find((j) => j.metadata?.active_turn?.session_id === sessionId && j.metadata.active_turn.status === "running" && j.metadata.active_turn.client_request_id);
      const crid = job?.metadata?.active_turn?.client_request_id;
      if (off || !crid) return;
      await ensureLocalBrowserToken();
      if (off || !transportRef.current) return;
      const baseVersion = topology.version;
      setLive({ clientRequestId: crid, sessionId, text: "", status: "上一轮仍在执行 · 正在接上进度", jobId: job?.job_id, baseVersion });
      transportRef.current.resumeTurn({ workspaceId, sessionId, clientRequestId: crid, handlers: turnHandlers(sessionId, baseVersion) });
    })().catch(() => undefined);
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workspaceId]);

  const running = !!live;
  const submit = async (request = input) => {
    const text = buildTopologyRequest(request);
    if (!text || running || preparing || submittingRef.current || !transportRef.current) return;
    submittingRef.current = true;
    setPreparing(true); setError(""); setVersionNote(null);
    const captured: CanvasSelection = { ...selection, node_ids: [...selection.node_ids], link_ids: [...selection.link_ids], canvas_item_ids: [...selection.canvas_item_ids], group_ids: [...selection.group_ids] };
    try {
      const baseline = prepareDrawing ? await prepareDrawing() : topology;
      let id = sessionId;
      if (!id) {
        id = await resolveTopologySession(workspaceId, topology, true);
        if (!id) { setError("无法创建本图的专属会话，指令尚未发送。"); return; }
        createdBySubmitRef.current = id;
        setSessionId(id);
      }
      await ensureLocalBrowserToken();
      const clientRequestId = stableId("cr");
      setInput("");
      setMessages((m) => [...m, { role: "user", content: text }]);
      const sid = id;
      setLive({ clientRequestId, sessionId: sid, text: "", status: "已发送 · 等待服务端受理", baseVersion: baseline.version });
      transportRef.current.sendMessage({
        workspaceId, sessionId: sid, text, clientRequestId,
        metadata: { workbench_selection: buildTopologySelection(baseline, captured, allowEdit) },
        handlers: turnHandlers(sid, baseline.version),
      });
    } catch (err) {
      setError(err instanceof Error ? `${err.message}（指令尚未发送）` : "准备图纸失败，指令尚未发送。");
    } finally {
      setPreparing(false);
      submittingRef.current = false;
    }
  };

  const stop = async () => {
    if (!live) return;
    if (!live.jobId) { setError("尚未拿到本轮的作业编号，暂不能请求停止；可以等待回合结束。"); return; }
    const o = await api.post(`/api/jobs/${enc(live.jobId)}/cancel`, { workspace_id: workspaceId, client_request_id: live.clientRequestId }, { workspace_id: workspaceId });
    setError(o.kind === "http" && o.status < 300 ? "已请求停止（受理回执，以回合终态为准）。" : `停止请求失败：${describeFailure(o)}`);
  };

  const openWorkbench = async () => {
    try {
      const sid = sessionId ?? await resolveTopologySession(workspaceId, topology, true);
      navigate(`/workbench?ws=${encodeURIComponent(workspaceId)}${sid ? `&session=${encodeURIComponent(sid)}` : ""}`);
    } catch { setError("无法打开本图的专属会话（会话接口失败），请稍后重试。"); }
  };

  return (
    <section className="topology-agent" data-testid="topology-agent-panel" aria-label="绘图助手">
      <header>
        <IconSparkle size={18} />
        <div><strong>绘图助手</strong><small>围绕这张图持续对话 · 本图专属会话</small></div>
        <div className="topology-agent-header-actions">
          <span className={running ? "agent-pulse" : ""} data-testid="agent-run-state">{running ? live.status : preparing ? "正在确认图纸版本…" : "就绪"}</span>
          {onClose ? <button type="button" className="topology-agent-close" aria-label="关闭绘图助手" data-sheet-close="" onClick={onClose}><IconClose size={16} /></button> : null}
        </div>
      </header>
      <div className="topology-agent-scope">
        <strong>{allowEdit ? "拓扑绘图 Skill（可修改本图）" : "拓扑只读分析"}</strong>
        <div className="topology-context-chip">{selection.label}<small>当前图纸 v{topology.version}{sessionId ? ` · 会话 ${sessionId}` : " · 首次发送时创建会话"}</small></div>
        <button type="button" className="btn ghost sm" onClick={() => void openWorkbench()} data-testid="agent-open-workbench">在工作台打开本图会话</button>
      </div>
      {activities.length > 0 && (
        <details className="topology-agent-activity" aria-label="图纸变化">
          <summary><strong>图纸变化记录</strong><span>{activities.length} 条 · 最新 v{activities[activities.length - 1].version}</span></summary>
          <div className="topology-agent-activity-list">
            {[...activities].reverse().map((a) => (
              <div key={`${a.version}:${a.revision_id ?? ""}`} className="topology-agent-change">
                <strong>图纸 v{a.version} · {a.source === "manual" ? "手动编辑" : "助手"} · {a.status === "displayed" ? "已保存并显示" : "已保存 · 待合并"}</strong>
                <span>新增 {a.added} · 修改 {a.modified} · 删除 {a.removed}</span>
                <div>
                  <button type="button" disabled={a.status !== "displayed" || !a.ids.length} onClick={() => onLocate?.(a.ids)}>定位变化</button>
                  {a.status === "displayed" && (a.revision_id || a.before) ? <button type="button" onClick={() => onUndoChange?.(a.version)}>撤销这次变化</button> : null}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="topology-agent-messages" ref={scrollRef} data-testid="agent-messages">
        {!messages.length && !live ? (
          <div className="topology-agent-intro">
            <IconSparkle size={28} />
            <h3>把想法画出来</h3>
            <p>描述设备、连线与布局，或选中图纸对象让助手修改。不连接真实设备；改动带版本写回本图，画布回读服务端版本后显示。</p>
            {PROMPTS.map(([label, prompt]) => <button type="button" key={label} onClick={() => setInput(prompt)}>{label}<span>→</span></button>)}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={m.message_id ?? `${i}:${m.role}`} className={`agent-msg is-${m.role}`} data-testid={`agent-msg-${m.role}`}>
            {m.role === "assistant"
              ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content ?? "") }} />
              : <div className="agent-msg-text">{m.content}</div>}
            {m.role === "assistant" && (m.ok === false || (m.errors ?? []).length) ? <small className="agent-msg-meta tone-warn">本轮报错</small> : null}
          </div>
        ))}
        {live ? <div className="agent-msg is-assistant is-live" role="status">{live.text ? <div className="agent-msg-text">{live.text}</div> : null}<small className="agent-msg-meta">{live.status}</small></div> : null}
        {versionNote ? (
          <p className="agent-version-note" role="status" data-testid="agent-version-readback">
            {topology.version !== versionNote.before
              ? `回合已结束；画布已回读服务端图纸 v${topology.version}（发送时 v${versionNote.before}）。`
              : versionNote.readback === "reading"
                ? "回合已结束；正在回读服务端图纸…"
                : versionNote.readback === "failed"
                  ? `回合已结束，但服务端图纸回读失败，画布可能不是最新（仍显示 v${topology.version}）。`
                  : `回合已结束；画布已按服务端回读，图纸仍为 v${topology.version}（发送时 v${versionNote.before}，本轮未产生新版本）。`}
            {versionNote.readback === "failed" && topology.version === versionNote.before
              ? <button type="button" className="btn ghost sm" onClick={() => void readbackDrawing(versionNote.before)}>重新回读图纸</button>
              : null}
          </p>
        ) : null}
      </div>
      {error ? <div className="topology-agent-error" role="alert">{error}{sessionId ? <button type="button" onClick={() => { setError(""); void loadMessages(sessionId); }}>重新读取</button> : null}</div> : null}
      <form className="topology-agent-composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="topology-agent-input-row">
          <textarea aria-label="绘图指令" data-testid="agent-input" rows={1} value={input}
            placeholder={allowEdit ? "描述你想画的设备、连线、分组或文字…" : "咨询拓扑结构、单点故障或连线分析（只读）…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
          {running
            ? <button type="button" className="topology-agent-stop-btn" onClick={() => void stop()} data-testid="agent-stop"><IconStop size={14} /><span>停止</span></button>
            : <button type="submit" className="topology-agent-send-btn" disabled={!input.trim() || preparing} data-testid="agent-send"><IconSend size={14} /><span>{preparing ? "确认版本中" : "发送"}</span></button>}
        </div>
        <footer>
          <div className="topology-agent-composer-meta">
            <label className="topology-agent-allow-edit"><input type="checkbox" checked={allowEdit} onChange={(e) => setAllowEdit(e.target.checked)} disabled={running || preparing} /><span>允许修改拓扑</span></label>
            <small>上下文：{selection.label}</small>
          </div>
        </footer>
      </form>
    </section>
  );
}
