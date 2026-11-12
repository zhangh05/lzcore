import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearLocalAuth, ensureLocalBrowserToken } from "../../api/localAuth";
import { api, bodyOf, describeFailure, enc, stableId, uploadMultipart } from "../../api/client";
import { useShell, withWorkspace } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { NAMES } from "../../contracts/naming";
import { SESSION_CONTINUATION_EVENT, type SessionContinuation } from "../../contracts/workbench";
import { useMediaQuery } from "../../kit/useMediaQuery";
import { useApi } from "../../kit/useApi";
import { Drawer, FailureNote, KeyValues, MenuButton, Popover, RawData, fmtTime } from "../../kit/ui";
import { TurnTransport, turnErrorText, wsUrl, type Frame } from "../../realtime/turnTransport";
import { useNavigate, useSearchParams } from "../../router";
import { CatalogDrawer } from "./CatalogDrawer";
import { Composer, type SendOptions } from "./Composer";
import type { ChatMessage, SessionSummary, StopState } from "./model";
import { ProgressPanel, hasProgressContent } from "./ProgressPanel";
import { SessionColumn } from "./SessionColumn";
import type { SubagentCall } from "./subagents";
import { Thread } from "./Thread";
import { createSession } from "./useSessions";

export interface SessionTask {
  task_id?: string;
  status?: string;
  objective?: string;
  unknowns?: { kind?: string; reason?: string }[];
  recovery_goals?: { goal_id?: string; status?: string; description?: string }[];
  next_action?: string;
  run_id?: string;
  last_run_id?: string;
  objective_run_id?: string;
  updated_at?: string;
}

export interface LiveStep { callId: string; toolId: string; state: "running" | "ok" | "fail"; summary?: string; durationMs?: number }
export interface LiveTurn { clientRequestId: string; text: string; events: string[]; status: string; jobId?: string; steps?: LiveStep[]; subagentCalls?: SubagentCall[] }

/** 把实时事件投影进本轮的步骤与子任务观察；只是展示，终态仍以服务端 done/回读为准。 */
export function applyLiveEvent(l: LiveTurn, name: string, data: Record<string, unknown>): LiveTurn {
  // 作业状态广播与幂等重定向只更新作业编号（停止按钮用），不进事件列表。
  if (name === "job_updated" || name === "idempotent_redirect") return { ...l, jobId: String(data.job_id ?? l.jobId ?? "") || undefined };
  const callId = String(data.call_id ?? data.node_id ?? "");
  const toolId = String(data.tool_id ?? "");
  let steps = l.steps ?? [];
  if (name === "tool_call" && toolId) {
    const key = callId || `${toolId}-${steps.length}`;
    if (!steps.some((s) => s.callId === key)) steps = [...steps, { callId: key, toolId, state: "running" }];
  } else if (name === "tool_result" && toolId) {
    const done: LiveStep = { callId: callId || `${toolId}-${steps.length}`, toolId, state: data.ok === false ? "fail" : "ok", summary: typeof data.summary === "string" ? data.summary : undefined, durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined };
    steps = steps.some((s) => s.callId === done.callId) ? steps.map((s) => (s.callId === done.callId ? done : s)) : [...steps, done];
  }
  const subagentCalls = name === "subagent_observation" && data.result && typeof data.result === "object"
    ? [...(l.subagentCalls ?? []), { call_id: callId || undefined, tool_id: toolId || "agent.manage", ok: data.ok !== false, result: data.result as Record<string, unknown> }]
    : l.subagentCalls;
  return {
    ...l,
    steps,
    subagentCalls,
    events: [...l.events, `${name}${toolId ? ` · ${toolId}` : ""}${data.title ? ` · ${String(data.title)}` : ""}`],
    jobId: String(data.job_id ?? l.jobId ?? "") || undefined,
    status: name === "model_started" ? "模型处理中" : name === "tool_call" ? `调用工具 ${toolId}` : name === "subagent_observation" ? "子任务进行中" : l.status,
  };
}

function useTransport(ws: string | null, readback: (sid: string, crid: string) => Promise<boolean>) {
  const ref = useRef<TurnTransport | null>(null);
  const rb = useRef(readback);
  rb.current = readback;
  useEffect(() => {
    if (!ws) return;
    const t = new TurnTransport({ url: wsUrl(), readback: (s, c) => rb.current(s, c), onAuthRejected: () => { clearLocalAuth(); return ensureLocalBrowserToken(); } });
    ref.current = t;
    return () => { t.close(); ref.current = null; };
  }, [ws]);
  return ref;
}

export function Workbench() {
  const { workspaceId: ws, extensions } = useShell();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = params.get("session");
  const intent = params.get("intent");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [task, setTask] = useState<SessionTask | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [stopState, setStopState] = useState<StopState>("idle");
  const [stopError, setStopError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState({ sessions: false, progress: false });
  const [drawer, setDrawer] = useState<"catalog" | "info" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [agentStatus] = useApi(ws ? "/api/agent/status" : null);
  const [llm] = useApi(ws ? "/api/agent/llm/status" : null);
  const creating = useRef(false);
  const narrow = useMediaQuery("(max-width: 760px)");
  const compact = useMediaQuery("(max-width: 1280px)");
  const [panel, setPanel] = useState<"sessions" | "progress" | null>(null);
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusBtn = useRef<HTMLButtonElement>(null);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  useEffect(() => setPanel(null), [ws, sessionId, narrow, compact]);

  const available = useMemo(() => new Set(extensions.kind === "ready" ? extensions.extensions.filter((e) => e.lifecycle?.enabled !== false && (e.lifecycle?.status ?? "ready") === "ready").map((e) => e.extension_id) : []), [extensions]);

  const openSession = useCallback((id: string) => { setPanel(null); navigate(withWorkspace(`/workbench?session=${enc(id)}`, ws)); }, [navigate, ws]);

  const newSession = useCallback(async () => {
    if (!ws || creating.current) return;
    creating.current = true;
    setCreateError(null);
    const r = await createSession(ws);
    creating.current = false;
    if (r.session) openSession(r.session.session_id);
    else setCreateError(describeFailure(r.outcome));
  }, [ws, openSession]);

  // 命令面板 / 外部入口的「新建会话」意图：真正创建会话。
  useEffect(() => { if (intent === "new-session" && ws) void newSession(); }, [intent, ws, newSession]);

  const loadMessages = useCallback(async () => {
    if (!ws || !sessionId) { setMessages([]); return []; }
    const o = await api.get(`/api/sessions/${enc(sessionId)}/messages`, { workspace_id: ws });
    const list = bodyOf<{ messages?: ChatMessage[] }>(o)?.messages;
    if (o.kind === "http" && o.status === 200 && Array.isArray(list)) { setMessages(list); setMsgError(null); return list; }
    setMsgError(describeFailure(o));
    return null;
  }, [ws, sessionId]);

  const loadTask = useCallback(async () => {
    if (!ws || !sessionId) { setTask(null); return; }
    const o = await api.get(`/api/runtime/sessions/${enc(sessionId)}/task-state`, { workspace_id: ws });
    setTask(bodyOf<{ task_state?: { task?: SessionTask } }>(o)?.task_state?.task ?? null);
  }, [ws, sessionId]);

  // 当前会话详情只从这里回读（GET /api/sessions/<id>）：首次进入、会话栏改名 / 归档 / 恢复之后、回合结束（可能自动起标题）之后。
  const loadSession = useCallback(async () => {
    if (!ws || !sessionId) { setSession(null); return; }
    const o = await api.get(`/api/sessions/${enc(sessionId)}`, { workspace_id: ws });
    if (o.kind === "http" && o.status === 200) setSession(bodyOf<{ session?: SessionSummary }>(o)?.session ?? null);
  }, [ws, sessionId]);

  useEffect(() => {
    setLive(null); setStopState("idle"); setStopError(null);
    void loadMessages(); void loadTask(); void loadSession();
  }, [ws, sessionId, loadMessages, loadTask, loadSession]);

  const onSessionChanged = useCallback((id: string, op: "rename" | "archive" | "restore" | "remove") => {
    if (id !== sessionId) return;
    if (op === "remove") { navigate(withWorkspace("/workbench", ws)); return; }
    void loadSession();
  }, [sessionId, loadSession, navigate, ws]);

  const readback = useCallback(async (sid: string, crid: string) => {
    if (!ws) return false;
    const o = await api.get(`/api/sessions/${enc(sid)}/messages`, { workspace_id: ws });
    const list = bodyOf<{ messages?: ChatMessage[] }>(o)?.messages ?? [];
    return list.some((m) => m.role === "assistant" && m.metadata?.client_request_id === crid);
  }, [ws]);
  const transport = useTransport(ws, readback);

  const settle = useCallback(async (note?: string) => {
    // 服务端终态优先：回合结束后用服务端消息替换本地流式内容。
    await loadMessages();
    await loadTask();
    await loadSession();
    setSessionsVersion((n) => n + 1); // 回合可能自动起标题：列表与主标题一起回读
    setLive(null);
    setStopState("idle");
    if (note) setStopError(note);
  }, [loadMessages, loadTask, loadSession]);

  const turnHandlers = useMemo(() => ({
    onToken: (t: string) => setLive((l) => l && { ...l, text: l.text + t, status: "生成中" }),
    onEvent: (name: string, data: Record<string, unknown>) => setLive((l) => l && applyLiveEvent(l, name, data)),
    onDone: () => void settle(),
    onError: (f: Frame) => void settle(turnErrorText(f)),
    onTransport: (s: "interrupted" | "resumed" | "readback_terminal") => {
      if (s === "interrupted") setLive((l) => l && { ...l, status: "连接中断 · 回合可能仍在执行，正在续传 / 回读（不会自动重发）" });
      if (s === "resumed") setLive((l) => l && { ...l, status: "已重新连接 · 续传中" });
      if (s === "readback_terminal") void settle();
    },
  }), [settle]);

  const send = useCallback(async (text: string, opts: SendOptions) => {
    if (!ws || !sessionId || !transport.current) return false;
    await ensureLocalBrowserToken();
    const uploaded: { file_id: string; name: string; kind: string; mime_type: string; size_bytes: number }[] = [];
    for (const a of opts.attachments) {
      if (a.file_id) { uploaded.push({ file_id: a.file_id, name: a.name, kind: a.kind, mime_type: a.file?.type || "application/octet-stream", size_bytes: a.size }); continue; }
      if (!a.file) continue;
      const o = await uploadMultipart(`/api/workspaces/${enc(ws)}/artifacts/upload`, { workspace_id: ws, session_id: sessionId, artifact_type: "chat_attachment", title: a.name }, a.file);
      const id = bodyOf<{ file?: { file_id?: string } }>(o);
      const fid = id?.file?.file_id;
      if (o.kind !== "http" || o.status >= 300 || !fid) { setStopError(`附件「${a.name}」上传失败：${describeFailure(o)}；消息未发送，若上传结果未知请先核对文件列表。`); return false; }
      uploaded.push({ file_id: fid, name: a.name, kind: a.kind, mime_type: a.file.type || "application/octet-stream", size_bytes: a.size });
    }
    const clientRequestId = stableId("cr");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setLive({ clientRequestId, text: "", events: [], status: "已发送 · 等待服务端受理" });
    setStopState("idle"); setStopError(null);
    const metadata: Record<string, unknown> = {};
    if (opts.workbenchSelection) metadata.workbench_selection = opts.workbenchSelection;
    if (uploaded.length) metadata.attachments = uploaded;
    if (opts.resumeTaskId) metadata.resume_task_id = opts.resumeTaskId;
    transport.current.sendMessage({ workspaceId: ws, sessionId, text, clientRequestId, metadata, handlers: turnHandlers });
    return true;
  }, [ws, sessionId, transport, turnHandlers]);

  // 重新进入会话（刷新、从别处跳回），或扩展通知「会话将继续执行」（如审批通过后自动续接）时：
  // 找到这个会话正在服务端执行的回合，只续传日志，绝不重发 message。
  const liveRef = useRef(live);
  liveRef.current = live;
  const attachRunning = useCallback(async (isOff: () => boolean, preferred?: SessionContinuation) => {
    if (!ws || !sessionId) return false;
    const o = await api.get("/api/jobs", { workspace_id: ws, status: "running", job_type: "agent_run", limit: 50 });
    const jobs = bodyOf<{ jobs?: Array<{ job_id?: string; metadata?: { active_turn?: { session_id?: string; client_request_id?: string; status?: string } } }> }>(o)?.jobs ?? [];
    const mine = jobs.filter((j) => j.metadata?.active_turn?.session_id === sessionId && j.metadata.active_turn.status === "running" && j.metadata.active_turn.client_request_id);
    const job = mine.find((j) => preferred?.client_request_id && j.metadata?.active_turn?.client_request_id === preferred.client_request_id)
      ?? mine.find((j) => preferred?.job_id && j.job_id === preferred.job_id) ?? mine[0];
    const crid = job?.metadata?.active_turn?.client_request_id;
    if (isOff() || !crid || liveRef.current) return false;
    await ensureLocalBrowserToken();
    if (isOff() || liveRef.current || !transport.current) return false;
    setLive({ clientRequestId: crid, text: "", events: [], status: "上一轮仍在执行 · 正在接上进度", jobId: job?.job_id });
    transport.current.resumeTurn({ workspaceId: ws, sessionId, clientRequestId: crid, handlers: turnHandlers });
    return true;
  }, [ws, sessionId, transport, turnHandlers]);
  useEffect(() => {
    let off = false;
    void attachRunning(() => off).catch(() => undefined);
    return () => { off = true; };
  }, [attachRunning]);
  useEffect(() => {
    let off = false;
    const onContinue = (ev: Event) => {
      const detail = (ev as CustomEvent<SessionContinuation>).detail ?? {};
      if (detail.session_id && detail.session_id !== sessionId) return;
      // 续接回合由服务端后台启动，可能稍晚才出现在作业列表里：有界地找几次；找不到就回读消息。
      void (async () => {
        // 有请求 ID（审批续接直接跑在服务端，不一定有作业记录）：直接按它续传；续传不到时传输层会转为回读消息等终态。
        if (detail.client_request_id && sessionId && ws && transport.current && !liveRef.current) {
          await ensureLocalBrowserToken();
          if (off || liveRef.current || !transport.current) return;
          setLive({ clientRequestId: detail.client_request_id, text: "", events: [], status: "审批已通过 · 正在接着执行", jobId: detail.job_id });
          transport.current.resumeTurn({ workspaceId: ws, sessionId, clientRequestId: detail.client_request_id, handlers: turnHandlers });
          return;
        }
        for (let i = 0; i < 8 && !off; i++) {
          if (liveRef.current || await attachRunning(() => off, detail).catch(() => false)) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!off) { await loadMessages(); await loadTask(); }
      })();
    };
    window.addEventListener(SESSION_CONTINUATION_EVENT, onContinue);
    return () => { off = true; window.removeEventListener(SESSION_CONTINUATION_EVENT, onContinue); };
  }, [attachRunning, sessionId, loadMessages, loadTask, ws, transport, turnHandlers]);

  const stop = useCallback(async () => {
    if (!ws || !live) return;
    if (!live.jobId) { setStopState("no_job"); return; }
    setStopState("requesting"); setStopError(null);
    const o = await api.post(`/api/jobs/${enc(live.jobId)}/cancel`, { workspace_id: ws, client_request_id: live.clientRequestId }, { workspace_id: ws });
    if (o.kind === "http" && o.status < 300) setStopState("requested");
    else { setStopState("failed"); setStopError(`停止请求失败：${describeFailure(o)}`); }
  }, [ws, live]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  if (!ws) return <div className="page"><p role="status">正在确定工作区…</p></div>;
  const statusBody = agentStatus.state === "ok" ? agentStatus.data : null;
  const llmBody = llm.state === "ok" ? llm.data : null;
  const modelSnapshot = (llmBody ?? {}) as { status?: string; connected?: boolean; enabled?: boolean; key_configured?: boolean;
    health?: { checked_at?: string; last_checked_at?: string; connected?: boolean; configured?: boolean; last_error_type?: string | null } | null;
    last_success?: { at?: string } | null; recent_failure?: { at?: string } | null };
  // 「最近检测」优先读连接探测结果 health（它才是检测本身）；health 缺失时再回落到顶层字段。顶层与探测不一致时在 title 里如实写出。
  const probe = modelSnapshot.health ?? null;
  const modelLabel = modelSnapshot.status ?? (modelSnapshot.enabled === false ? "未启用"
    : probe?.connected === true ? "已连接" : probe?.connected === false ? (probe.last_error_type ? `未连接（${probe.last_error_type}）` : "未连接")
    : modelSnapshot.connected === true ? "已连接" : modelSnapshot.key_configured === false ? "待配置" : modelSnapshot.connected === false ? "未连接" : "未上报");
  const probeMismatch = probe && typeof probe.connected === "boolean" && typeof modelSnapshot.connected === "boolean" && probe.connected !== modelSnapshot.connected;
  // 「最近检测」来自 GET /api/agent/llm/status（连接探测 / 最近成功失败记录）；「本轮响应」来自本会话消息。二者分开显示，不互相代替。
  // 「最近检测」只认探测自身的时间；最近成功 / 最近失败是另外两件事，分开写，不拿一个多月前的成功时间冒充检测时间。
  const probeAt = modelSnapshot.health?.checked_at ?? modelSnapshot.health?.last_checked_at;
  const probeText = llm.state === "ok" ? `${modelLabel}${probeAt ? `（${fmtTime(probeAt)}）` : "（时间未上报）"}` : llm.state === "error" ? "不可读" : "读取中";
  const lastSuccessText = llm.state === "ok" ? (modelSnapshot.last_success?.at ? fmtTime(modelSnapshot.last_success.at) : "未上报") : "—";
  const recentFailure = modelSnapshot.recent_failure as { at?: string; error_type?: string; error_summary?: string } | null | undefined;
  const recentFailureText = llm.state === "ok" ? (recentFailure?.at ? `${fmtTime(recentFailure.at)}${recentFailure.error_type ? ` · ${recentFailure.error_type}` : ""}` : "无") : "—";
  const runtimeText = agentStatus.state === "ok" ? String((statusBody as Record<string, unknown>)?.status ?? ((statusBody as Record<string, unknown>)?.runtime_engine ? "已接入" : "未上报")) : agentStatus.state === "error" ? "不可读" : "读取中";
  const modelTone = llm.state !== "ok" ? "unknown" : modelLabel === "已连接" ? "ok" : modelLabel === "未上报" ? "unknown" : "warn";
  const turnText = live ? live.status : lastAssistant
    ? `${lastAssistant.ok === false || lastAssistant.metadata?.status === "error" || (lastAssistant.errors ?? []).length ? "本轮报错" : "已收到回复"}${lastAssistant.created_at ? `（${fmtTime(lastAssistant.created_at)}）` : ""}`
    : sessionId ? "本会话暂无回复" : "未选择会话";
  const progressFacts = hasProgressContent(lastAssistant, task, live?.events ?? []);
  const progressRail = !compact && progressFacts;
  return (
    <div className="workbench" data-testid="workbench">
      {!narrow ? <SessionColumn ws={ws} currentId={sessionId} onOpen={openSession} onNew={() => void newSession()} collapsed={collapsed.sessions} onToggle={() => setCollapsed((c) => ({ ...c, sessions: !c.sessions }))} onChanged={onSessionChanged} refreshKey={sessionsVersion} /> : null}
      <section className="wb-main" aria-label="对话">
        <header className="wb-header">
          {narrow ? <Button onClick={() => setPanel("sessions")}>会话列表</Button> : null}
          <h1 className="page-title" tabIndex={-1} title={session?.title || undefined} data-testid="wb-title">{session?.title || (sessionId ? "未命名会话" : NAMES.workbench)}</h1>
          <span className="status-chip" data-testid="turn-response" title={`本轮响应：${turnText}（来源：本会话消息 / 实时回合；完整状态见「状态细节」）`}>本轮响应：{turnText}</span>
          <button type="button" ref={statusBtn} className="btn ghost sm wb-status-btn" aria-haspopup="dialog" aria-expanded={statusOpen} onClick={() => setStatusOpen((o) => !o)} data-testid="open-status-details">
            <span className={`status-dot tone-${modelTone}`} aria-hidden="true" />状态细节
          </button>
          <Popover anchor={statusBtn} open={statusOpen} onClose={closeStatus} label="运行状态细节" className="status-details" testId="status-details">
            <dl>
              <div><dt>运行时（GET /api/agent/status）</dt><dd data-testid="agent-status">运行时：{runtimeText}</dd></div>
              <div><dt>模型连接探测（GET /api/agent/llm/status · health）</dt>
                <dd data-testid="llm-health" title={probeMismatch ? `顶层 connected=${String(modelSnapshot.connected)} 与探测 health.connected=${String(probe?.connected)} 不一致，以探测为准` : "连接检测，不代表本轮回复"}>模型最近检测：{probeText}{probeMismatch ? "（顶层字段与探测不一致，以探测为准）" : ""}</dd></div>
              <div><dt>模型最近成功调用（last_success）</dt><dd data-testid="llm-last-success">最近成功：{lastSuccessText}</dd></div>
              <div><dt>模型最近失败（recent_failure）</dt><dd data-testid="llm-recent-failure">最近失败：{recentFailureText}</dd></div>
              <div><dt>本轮响应（本会话消息 / 实时回合）</dt><dd>{turnText}</dd></div>
            </dl>
          </Popover>
          <span className="grow" />
          {!progressRail || collapsed.progress ? <Button className="sm" onClick={() => setPanel("progress")} data-testid="open-progress">进度与证据</Button> : null}
          <Button className="sm" onClick={() => void newSession()} data-testid="header-new-session">{NAMES.newSession}</Button>
          <MenuButton label="更多操作" className="btn ghost sm" testId="wb-more" menuTestId="wb-more-menu" items={[
            { key: "catalog", label: "能力目录", onSelect: () => setDrawer("catalog"), testId: "open-catalog" },
            ...(sessionId ? [{ key: "info", label: "会话信息", onSelect: () => setDrawer("info"), testId: "open-session-info" }] : []),
          ]}>更多 ▾</MenuButton>
        </header>
        {params.get("notice") === "create_failed" && !createError ? <p className="inline-alert tone-warn" role="alert" data-testid="create-failed">新建会话失败（服务端未创建会话），可以再点「新建会话」重试。</p> : null}
        {createError ? <p className="inline-alert tone-warn" role="alert">新建会话失败：{createError}</p> : null}
        {msgError ? <p className="inline-alert tone-warn" role="alert">消息读取失败：{msgError}</p> : null}
        {stopError ? <p className="inline-alert tone-warn" role="alert" data-testid="stop-error">{stopError}</p> : null}
        {sessionId && params.get("resume_task") && !live ? (
          <div className="inline-alert tone-info" role="status" data-testid="resume-from-review">
            已在待核对中完成标记。续接只重放传输日志，未知写入只回查、不重放。
            <Button onClick={() => void send("继续当前任务。先核对已有结果和未完成事项；未知写入只回查，不重放。", { attachments: [], resumeTaskId: params.get("resume_task")! })} data-testid="resume-from-review-btn">续接任务</Button>
          </div>
        ) : null}
        {sessionId ? (
          <>
            <Thread ws={ws} sessionId={sessionId} messages={messages} live={live} task={task} availableExtensions={available}
              onResume={(taskId) => void send("继续当前任务。先核对已有结果和未完成事项；未知写入只回查，不重放。", { attachments: [], resumeTaskId: taskId })} />
            <Composer key={`${ws}:${sessionId}`} ws={ws} session={session} running={!!live} stopState={stopState} onSend={send} onStop={() => void stop()} />
          </>
        ) : (
          <div className="empty-state" data-testid="workbench-empty">
            <h2 className="empty-state-title">选择或新建一个会话</h2>
            <p className="empty-state-reason">会话列表在左侧；也可以按 Ctrl K 选择「新建会话」。</p>
            <Button variant="primary" onClick={() => void newSession()} data-testid="empty-new-session">新建会话并开始</Button>
          </div>
        )}
      </section>
      {progressRail ? <ProgressPanel ws={ws} last={lastAssistant} task={task} liveEvents={live?.events ?? []} collapsed={collapsed.progress} onToggle={() => setCollapsed((c) => ({ ...c, progress: !c.progress }))} /> : null}
      {panel ? <Drawer title={panel === "sessions" ? "会话列表" : "进度与证据"} onClose={() => setPanel(null)}>
        <div className="wb-panel-drawer">
          {panel === "sessions" ? <SessionColumn ws={ws} currentId={sessionId} onOpen={openSession} onNew={() => void newSession()} collapsed={false} onToggle={() => setPanel(null)} onChanged={onSessionChanged} refreshKey={sessionsVersion} />
            : <ProgressPanel ws={ws} last={lastAssistant} task={task} liveEvents={live?.events ?? []} collapsed={false} onToggle={() => setPanel(null)} />}
        </div>
      </Drawer> : null}
      {drawer === "catalog" ? <CatalogDrawer ws={ws} onClose={() => setDrawer(null)} /> : null}
      {drawer === "info" && sessionId ? (
        <Drawer title="会话信息" onClose={() => setDrawer(null)} testId="session-info">
          <KeyValues items={[["会话", <code key="s">{sessionId}</code>], ["标题", session?.title], ["状态", session?.status], ["创建", fmtTime(session?.created_at)], ["消息数", String(messages.length)], ["任务", task?.task_id]]} />
          <Button onClick={() => {
            const blob = new Blob([JSON.stringify({ session, messages }, null, 2)], { type: "application/json" });
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `session-${sessionId}.json`; a.click();
          }} data-testid="export-session">导出 JSON</Button>
          {task ? <><h3>任务状态（task-state）</h3><KeyValues items={[["状态", task.status ?? "未上报"], ["任务", task.task_id], ["目标", task.objective], ["下一步", task.next_action], ["未知项", String(task.unknowns?.length ?? 0)]]} /><RawData value={task} label="task-state 原始数据" /></> : null}
          {llm.state === "error" ? <FailureNote outcome={llm.outcome} /> : null}
        </Drawer>
      ) : null}
    </div>
  );
}
