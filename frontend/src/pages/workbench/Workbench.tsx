import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureLocalBrowserToken } from "../../api/localAuth";
import { api, bodyOf, describeFailure, enc, stableId, uploadMultipart } from "../../api/client";
import { useShell, withWorkspace } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { NAMES } from "../../contracts/naming";
import { useMediaQuery } from "../../kit/useMediaQuery";
import { useApi } from "../../kit/useApi";
import { Drawer, FailureNote, JsonBlock, KeyValues, fmtTime } from "../../kit/ui";
import { TurnTransport, wsUrl, type Frame } from "../../realtime/turnTransport";
import { useNavigate, useSearchParams } from "../../router";
import { CatalogDrawer } from "./CatalogDrawer";
import { Composer, type SendOptions } from "./Composer";
import type { ChatMessage, SessionSummary, StopState } from "./model";
import { ProgressPanel } from "./ProgressPanel";
import { SessionColumn } from "./SessionColumn";
import { Thread } from "./Thread";
import { createSession } from "./useSessions";

export interface SessionTask {
  task_id?: string;
  status?: string;
  objective?: string;
  unknowns?: { kind?: string; reason?: string }[];
  recovery_goals?: { goal_id?: string; status?: string; description?: string }[];
  next_action?: string;
}

interface LiveTurn { clientRequestId: string; text: string; events: string[]; status: string; jobId?: string }

function useTransport(ws: string | null, readback: (sid: string, crid: string) => Promise<boolean>) {
  const ref = useRef<TurnTransport | null>(null);
  const rb = useRef(readback);
  rb.current = readback;
  useEffect(() => {
    if (!ws) return;
    const t = new TurnTransport({ url: wsUrl(), readback: (s, c) => rb.current(s, c) });
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

  useEffect(() => {
    setLive(null); setStopState("idle"); setStopError(null);
    void loadMessages(); void loadTask();
    if (ws && sessionId) {
      void api.get(`/api/sessions/${enc(sessionId)}`, { workspace_id: ws }).then((o) => setSession(bodyOf<{ session?: SessionSummary }>(o)?.session ?? null));
    } else setSession(null);
  }, [ws, sessionId, loadMessages, loadTask]);

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
    setLive(null);
    setStopState("idle");
    if (note) setStopError(note);
  }, [loadMessages, loadTask]);

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
    transport.current.sendMessage({
      workspaceId: ws, sessionId, text, clientRequestId, metadata,
      handlers: {
        onToken: (t) => setLive((l) => l && { ...l, text: l.text + t, status: "生成中" }),
        onEvent: (name, data) => setLive((l) => l && {
          ...l,
          events: [...l.events, `${name}${data.tool_id ? ` · ${String(data.tool_id)}` : ""}${data.title ? ` · ${String(data.title)}` : ""}`],
          jobId: String(data.job_id ?? l.jobId ?? "") || undefined,
          status: name === "model_started" ? "模型处理中" : name === "tool_call" ? `调用工具 ${String(data.tool_id ?? "")}` : l.status,
        }),
        onDone: () => void settle(),
        onError: (f: Frame) => void settle(`本轮报错：${String(f.message ?? f.error ?? "未知错误")}`),
        onTransport: (s) => {
          if (s === "interrupted") setLive((l) => l && { ...l, status: "连接中断 · 回合可能仍在执行，正在续传 / 回读（不会自动重发）" });
          if (s === "resumed") setLive((l) => l && { ...l, status: "已重新连接 · 续传中" });
          if (s === "readback_terminal") void settle();
        },
      },
    });
    return true;
  }, [ws, sessionId, transport, settle]);

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
  const modelSnapshot = (llmBody ?? {}) as { status?: string; connected?: boolean; enabled?: boolean; key_configured?: boolean };
  const modelLabel = modelSnapshot.status ?? (modelSnapshot.enabled === false ? "未启用" : modelSnapshot.connected === true ? "已连接" : modelSnapshot.key_configured === false ? "待配置" : modelSnapshot.connected === false ? "未连接" : "未上报");
  return (
    <div className="workbench" data-testid="workbench">
      {!narrow ? <SessionColumn ws={ws} currentId={sessionId} onOpen={openSession} onNew={() => void newSession()} collapsed={collapsed.sessions} onToggle={() => setCollapsed((c) => ({ ...c, sessions: !c.sessions }))} /> : null}
      <section className="wb-main" aria-label="对话">
        <header className="wb-header">
          {narrow ? <Button onClick={() => setPanel("sessions")}>会话列表</Button> : null}
          <h1 className="page-title" tabIndex={-1}>{session?.title || (sessionId ? "未命名会话" : NAMES.workbench)}</h1>
          <span className="status-chip" data-testid="agent-status" title="GET /api/agent/status">运行时：{agentStatus.state === "ok" ? String((statusBody as Record<string, unknown>)?.status ?? ((statusBody as Record<string, unknown>)?.runtime_engine ? "已接入" : "未上报")) : agentStatus.state === "error" ? "不可读" : "读取中"}</span>
          <span className="status-chip" data-testid="llm-health">模型：{llm.state === "ok" ? modelLabel : llm.state === "error" ? "不可读" : "读取中"}</span>
          <span className="grow" />
          {compact ? <Button onClick={() => setPanel("progress")}>进度与证据</Button> : null}
          <Button onClick={() => void newSession()} data-testid="header-new-session">{NAMES.newSession}</Button>
          <Button onClick={() => setDrawer("catalog")} data-testid="open-catalog">能力目录</Button>
          {sessionId ? <Button onClick={() => setDrawer("info")}>会话信息</Button> : null}
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
      {!compact ? <ProgressPanel last={lastAssistant} task={task} liveEvents={live?.events ?? []} collapsed={collapsed.progress} onToggle={() => setCollapsed((c) => ({ ...c, progress: !c.progress }))} /> : null}
      {panel ? <Drawer title={panel === "sessions" ? "会话列表" : "进度与证据"} onClose={() => setPanel(null)}>
        <div className="wb-panel-drawer">
          {panel === "sessions" ? <SessionColumn ws={ws} currentId={sessionId} onOpen={openSession} onNew={() => void newSession()} collapsed={false} onToggle={() => setPanel(null)} />
            : <ProgressPanel last={lastAssistant} task={task} liveEvents={live?.events ?? []} collapsed={false} onToggle={() => setPanel(null)} />}
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
          {task ? <><h3>任务状态（task-state）</h3><JsonBlock value={task} /></> : null}
          {llm.state === "error" ? <FailureNote outcome={llm.outcome} /> : null}
        </Drawer>
      ) : null}
    </div>
  );
}
