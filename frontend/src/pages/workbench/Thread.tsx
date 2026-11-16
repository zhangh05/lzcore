import { renderMarkdown } from "../../utils/markdown";
import { memo, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import remend from "remend";
import { motionTokens } from "../../components/arc/lib/motion-tokens";
import { api, bodyOf, enc } from "../../api/client";
import { CopyButton } from "../../components/arc/copy-button/copy-button";
import { Button } from "../../components/Button";
import { OutcomeBar } from "../../components/OutcomeBar";
import { deriveToolAttemptState, TOOL_ATTEMPT_LABEL } from "../../contracts/outcomeState";
import { RESUMABLE_TASK_STATUSES, UNKNOWN_FLOW_COPY } from "../../contracts/unknownFlow";
import { evidenceRenderers } from "../../extension-modules/registry";
import { MemoryWriteView } from "../../kit/MemoryWriteView";
import { stableMemoryId, writeMemory, type MemoryWriteState } from "../../kit/memoryWrite";
import { FailureNote, ReceiptNote } from "../../kit/ui";
import type { HttpOutcome } from "../../contracts/auth";
import { terminalKind, turnFacts, unknownTargetHref, type ChatAttachment, type ChatMessage } from "./model";
import type { LiveTurn, SessionTask } from "./Workbench";
import { SubagentCard } from "./SubagentCard";
import { BrandGlyph } from "../../components/BrandGlyph";
import { IconArrowDown, IconAttachment, IconBook, IconBrain } from "../../components/Icon";
import { useOptionalShell } from "../../app/shellContext";
import { partitionSubagentCalls } from "./subagents";

function ToolCards({ m, ws, available }: { m: ChatMessage; ws: string; available: Set<string> }) {
  const all = m.metadata?.tool_calls ?? [];
  const renderers = evidenceRenderers(available);
  if (!all.length) return null;
  const { ordinary: calls, tasks } = partitionSubagentCalls(all);
  return (
    <>
    {tasks.length ? <div className="subagent-list" data-testid="subagent-list">{tasks.map((g) => <SubagentCard key={g.id} group={g} />)}</div> : null}
    {calls.length ? <ul className="tool-cards">
      {calls.map((c) => {
        const state = deriveToolAttemptState(c, turnFacts(m));
        const custom = renderers.map((r) => ({ r, key: r.match(c) })).find((x) => x.key);
        return (
          <li key={c.call_id ?? c.tool_id} className={`tool-card tone-${state === "unknown" ? "unknown" : state === "fail" ? "danger" : "neutral"}`} data-tool-state={state}>
            <details>
              <summary><code>{c.tool_id}</code> <span className="status-chip">{TOOL_ATTEMPT_LABEL[state]}</span> {c.summary ? <span className="muted">{c.summary}</span> : null}</summary>
              {c.result ? <pre className="json-block">{JSON.stringify(c.result, null, 2)}</pre> : <p className="muted">{state === "pending" ? "等待工具返回…" : "没有返回内容。"}</p>}
            </details>
            {custom ? custom.r.render(ws, custom.key!, c) : null}
          </li>
        );
      })}
    </ul> : null}
    </>
  );
}

/**
 * 把本轮实时状态投影成一条「进行中」的助手消息：与回合结束后服务端写回的正式消息走同一个 MessageItem、同一个位置 key，
 * 所以结束时是同一个 DOM 节点原地合并终态，而不是卸掉草稿再挂上正式回复。仅展示；终态以服务端为准。
 */
export function liveAsMessage(live: LiveTurn): ChatMessage {
  const steps = (live.steps ?? []).map((st) => ({
    call_id: st.callId, tool_id: st.toolId,
    status: st.state === "running" ? "running" : undefined, ok: st.state === "ok",
    summary: st.summary,
  }));
  return { role: "assistant", content: live.text, metadata: { client_request_id: live.clientRequestId, tool_calls: [...(live.subagentCalls ?? []), ...steps] } };
}

/** 回合结束才出现的结果栏和操作：短促淡入，不推挤正文。 */
function Reveal({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={{ opacity: 0, y: reduce ? 0 : 2 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>
      {children}
    </motion.div>
  );
}

function MemoryAction({ ws, sessionId, m }: { ws: string; sessionId: string; m: ChatMessage }) {
  const scope = `${ws}:${sessionId}:${m.message_id ?? m.metadata?.client_request_id ?? m.created_at}`;
  const [state, setState] = useState<MemoryWriteState>({ kind: "idle" });
  const blocked = state.kind === "writing" || state.kind === "written" || state.kind === "unknown" || state.kind === "readback_missing";
  return (
    <span className="memory-action">
      {!blocked ? (
        <Button variant="ghost" className="sm" icon={<IconBrain size={14} aria-hidden="true" />} onClick={async () => {
          setState({ kind: "writing" });
          setState(await writeMemory(ws, { memory_id: stableMemoryId(scope), title: m.content.slice(0, 40) || "本次结论", content: m.content, session_id: sessionId, task_id: m.metadata?.task_id }));
        }} data-testid="remember-btn">记住本次结论</Button>
      ) : null}
      <MemoryWriteView ws={ws} state={state} onState={setState} />
    </span>
  );
}

function KnowledgeAction({ ws, m }: { ws: string; m: ChatMessage }) {
  const artifactId = (m.metadata?.report_artifacts as string[] | undefined)?.[0] ?? (m.metadata?.output_artifacts as string[] | undefined)?.[0];
  const [o, setO] = useState<HttpOutcome | null>(null);
  if (!artifactId) return <span className="message-note" title="存为知识需要本轮产出文件">无产出文件，不能存为知识</span>;
  return (
    <span>
      <Button variant="ghost" className="sm" icon={<IconBook size={14} aria-hidden="true" />} onClick={async () => setO(await api.post("/api/knowledge/sources/from-artifact", { workspace_id: ws, artifact_id: artifactId }))} disabled={!!o && o.kind === "http" && o.status < 300}>存为知识</Button>
      {o ? (o.kind === "http" && o.status < 300 ? <ReceiptNote text={`已提交入库（来源状态：${String(bodyOf<{ source?: { status?: string } }>(o)?.source?.status ?? "未上报")}）`} /> : <FailureNote outcome={o} />) : null}
    </span>
  );
}

/** 对话双方的头像：助手用产品标识，用户用账户名首字（与顶栏账户按钮一致）。 */
function MessageAvatar({ role, live = false }: { role: string; live?: boolean }) {
  const shell = useOptionalShell();
  if (role === "assistant") {
    return <span className={`message-avatar is-assistant ${live ? "is-live" : ""}`} aria-hidden="true"><BrandGlyph size={16} /></span>;
  }
  const label = shell?.auth.username || "我";
  return <span className="message-avatar is-user" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>;
}

/**
 * 单条消息。回读后内容没变的消息沿用同一个对象（见 reuseUnchanged），这里 memo 后就不会重新渲染、也不会重新解析 Markdown。
 * 流式中的回复也用它渲染（streaming 非空）：边流边排版 Markdown（remend 先补齐未闭合的语法），工具调用直接按最终卡片样式显示；
 * 结束时同一个节点换上服务端终态，只有结果栏和操作按钮是新出现的。
 */
/** 消息里带的附件：图片显示缩略图（点开看原图），文件显示名称（点开下载）。都走托管文件的只读预览 / 下载接口。 */
function MessageAttachments({ ws, items }: { ws: string; items: ChatAttachment[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const url = (a: ChatAttachment, kind: "preview" | "download") => `/api/storage/files/${enc(a.file_id)}/${kind}?workspace_id=${enc(ws)}`;
  return (
    <ul className="message-attachments" data-testid="message-attachments">
      {items.map((a) => a.kind === "image" && !broken.has(a.file_id) ? (
        <li key={a.file_id} className="message-attachment is-image">
          <a href={url(a, "preview")} target="_blank" rel="noreferrer" title={a.name}>
            <img src={url(a, "preview")} alt={a.name} loading="lazy" onError={() => setBroken((b) => new Set(b).add(a.file_id))} />
          </a>
        </li>
      ) : (
        <li key={a.file_id} className="message-attachment is-file">
          <a href={url(a, "download")} title={`下载 ${a.name}`}><IconAttachment size={14} aria-hidden="true" /><span>{a.name}</span></a>
        </li>
      ))}
    </ul>
  );
}

/** 复制这条消息的原文（助手消息复制 Markdown 源文）。Arc copy-button，图标态：复制 → 对勾。 */
function MessageCopy({ text }: { text: string }) {
  return <span className="message-copy" data-testid="message-copy"><CopyButton value={text} label="复制" iconOnly variant="plain" /></span>;
}

const MessageItem = memo(function MessageItem({ m, ws, sessionId, isLast, verifyTaskId, available, streaming }: {
  m: ChatMessage; ws: string; sessionId: string; isLast: boolean; verifyTaskId?: string; available: Set<string>;
  streaming?: { status: string } | null;
}) {
  const live = !!streaming;
  const kind = m.role === "assistant" && !live ? terminalKind(m) : "normal";
  const verify = unknownTargetHref(ws, sessionId, verifyTaskId, m.metadata?.operation_id);
  // 流式时 token 很密：排版跟在输入后面做，不阻塞逐字更新。
  const content = useDeferredValue(m.content);
  const source = live ? content : m.content;
  const html = useMemo(() => (m.role === "assistant" && source ? renderMarkdown(live ? remend(source) : source) : ""), [m.role, source, live]);
  const attachments = useMemo(() => (Array.isArray(m.metadata?.attachments) ? m.metadata.attachments.filter((a) => a && typeof a.file_id === "string") : []), [m.metadata?.attachments]);
  return (
    <li className={`message role-${m.role} ${live ? "is-live is-streaming" : ""}`} data-role={m.role}
      aria-live={live ? "polite" : undefined} data-testid={live ? "live-turn" : undefined}>
      <MessageAvatar role={m.role} live={live} />
      <div className="message-main">
      {m.role !== "assistant" && attachments.length ? <MessageAttachments ws={ws} items={attachments} /> : null}
      {m.role === "assistant" ? (html ? <div className="message-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} /> : null) : <div className="message-body">{m.content}</div>}
      {m.role !== "assistant" && m.content ? <div className="message-tools"><MessageCopy text={m.content} /></div> : null}
      {m.role === "assistant" ? (
        <>
          {kind === "cancelled" ? <p className="inline-alert tone-info" role="status">本轮已按请求停止（服务端确认）。</p> : null}
          {kind === "error" ? <p className="inline-alert tone-danger" role="alert">本轮报错：{(m.errors ?? []).join("；")}</p> : null}
          <ToolCards m={m} ws={ws} available={available} />
          {live ? (
            <p className="live-status"><span className="live-dot" aria-hidden="true" /><span className="shimmer-text">{streaming!.status || "思考中…"}</span></p>
          ) : (
            <Reveal>
              <OutcomeBar facts={turnFacts(m)} toolCalls={m.metadata?.tool_calls ?? []} verifyHref={verify} resumeHref={verify} />
              {isLast || m.content ? (
                <div className={`row-actions message-actions ${isLast ? "is-last" : ""}`}>
                  {m.content ? <MessageCopy text={m.content} /> : null}
                  {isLast ? <MemoryAction ws={ws} sessionId={sessionId} m={m} /> : null}
                  {isLast ? <KnowledgeAction ws={ws} m={m} /> : null}
                </div>
              ) : null}
            </Reveal>
          )}
        </>
      ) : null}
      </div>
    </li>
  );
});

export function Thread({ ws, sessionId, messages, live, task, availableExtensions, onResume }: {
  ws: string; sessionId: string; messages: ChatMessage[]; live: LiveTurn | null;
  task: SessionTask | null; availableExtensions: Set<string>; onResume: (taskId: string) => void;
}) {
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant"), [messages]);
  const taskUnknown = !!task && (task.unknowns?.length ?? 0) > 0;
  const liveMessage = useMemo(() => (live ? liveAsMessage(live) : null), [live]);
  const status = live?.status ?? "";
  const streaming = useMemo(() => ({ status }), [status]);
  // 贴底滚动（use-stick-to-bottom，StackBlitz，MIT）：在底部时跟随流式输出；用户往上翻就松开，不抢滚动；
  // 内容高度变化（排版、工具卡片展开）也会跟上。离开底部时显示「回到底部」。
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: "instant", resize: "smooth" });
  // 换会话直接落到底部；自己发出一轮时，即使正往上翻也带回底部看回复。
  useEffect(() => { void scrollToBottom("instant"); }, [ws, sessionId, scrollToBottom]);
  const turnId = live?.clientRequestId;
  useEffect(() => {
    if (turnId) { void scrollToBottom("smooth"); return; }
    // 回合结束：结果栏、操作按钮在最后一刻出现，人还在底部就补一次贴底（往上翻着的不动）。
    void scrollToBottom({ animation: "smooth", preserveScrollPosition: true, wait: true });
  }, [turnId, scrollToBottom]);
  return (
    <div className="wb-thread-wrap">
    <div className="wb-thread" data-testid="thread" ref={scrollRef}>
      <div className="wb-thread-content" ref={contentRef}>
      {messages.length === 0 && !live ? <p className="muted">在下方输入第一句话开始。</p> : null}
      <ol className="messages">
        {/* 实时回复必须和历史消息在同一个数组里：React 只在同一组兄弟间按 key 复用节点。 */}
        {[
          ...messages.map((m, i) => (
            // 会话消息只追加不重排，按位置作 key：本地乐观插入的用户消息换成服务端版本时原地更新，不会卸载重建。
            <MessageItem key={i} m={m} ws={ws} sessionId={sessionId} isLast={m === lastAssistant}
              verifyTaskId={m.metadata?.task_id ?? (taskUnknown ? task?.task_id : undefined)} available={availableExtensions} />
          )),
          // 流式回复占下一个位置：回合结束后服务端的正式回复正好落在这里，于是同一个节点原地换上终态。
          ...(liveMessage ? [<MessageItem key={messages.length} m={liveMessage} ws={ws} sessionId={sessionId} isLast={false}
            available={availableExtensions} streaming={streaming} />] : []),
        ]}
      </ol>
      {task && !live ? <TaskResumeBar ws={ws} sessionId={sessionId} task={task} onResume={onResume} /> : null}
      </div>
    </div>
    <AnimatePresence>
      {!isAtBottom ? <JumpToBottom key="jump" live={!!live} onClick={() => void scrollToBottom("smooth")} /> : null}
    </AnimatePresence>
    </div>
  );
}

/** 回到底部：离开底部时浮在对话区下沿；正在回复时提示有新内容。 */
function JumpToBottom({ live, onClick }: { live: boolean; onClick: () => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className="jump-to-bottom" initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : 6 }}
      transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast, ease: [...motionTokens.ease.enter] }}>
      <Button variant="secondary" className="sm" icon={<IconArrowDown size={14} aria-hidden="true" />} onClick={onClick} data-testid="jump-to-bottom">
        {live ? "有新内容 · 回到底部" : "回到底部"}
      </Button>
    </motion.div>
  );
}

/** 续接条（白名单迁自 TaskResumeControl）。有未知项时先核对，不提供续接。 */
export function TaskResumeBar({ ws, sessionId, task, onResume }: { ws: string; sessionId: string; task: SessionTask; onResume: (taskId: string) => void }) {
  if (!task.task_id || !RESUMABLE_TASK_STATUSES.has(String(task.status))) return null;
  const unknown = (task.unknowns?.length ?? 0) > 0;
  return (
    <div className="inline-alert tone-info resume-bar" role="status" data-testid="resume-bar">
      <strong>任务未结束（{task.status}）</strong> {UNKNOWN_FLOW_COPY.rule}
      {unknown ? (
        <a className="btn" href={unknownTargetHref(ws, sessionId, task.task_id)} data-testid="resume-verify-first">有 {task.unknowns!.length} 项结果未知 · 先去核对</a>
      ) : (
        <Button onClick={() => onResume(task.task_id!)} data-testid="resume-task-btn">续接任务</Button>
      )}
    </div>
  );
}
