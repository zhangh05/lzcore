import { renderMarkdown } from "../../utils/markdown";
import { useMemo, useState } from "react";
import { api, bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import { OutcomeBar } from "../../components/OutcomeBar";
import { deriveToolAttemptState, TOOL_ATTEMPT_LABEL } from "../../contracts/outcomeState";
import { RESUMABLE_TASK_STATUSES, UNKNOWN_FLOW_COPY } from "../../contracts/unknownFlow";
import { evidenceRenderers } from "../../extension-modules/registry";
import { MemoryWriteView } from "../../kit/MemoryWriteView";
import { stableMemoryId, writeMemory, type MemoryWriteState } from "../../kit/memoryWrite";
import { FailureNote, ReceiptNote } from "../../kit/ui";
import type { HttpOutcome } from "../../contracts/auth";
import { terminalKind, turnFacts, unknownTargetHref, type ChatMessage } from "./model";
import type { LiveTurn, SessionTask } from "./Workbench";
import { SubagentCard } from "./SubagentCard";
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
              {c.result ? <pre className="json-block">{JSON.stringify(c.result, null, 2)}</pre> : <p className="muted">没有返回内容。</p>}
            </details>
            {custom ? custom.r.render(ws, custom.key!, c) : null}
          </li>
        );
      })}
    </ul> : null}
    </>
  );
}

const STEP_LABEL = { running: "进行中", ok: "已返回", fail: "失败" } as const;
const STEP_TONE = { running: "info", ok: "ok", fail: "danger" } as const;

/** 本轮实时进展：工具步骤（tool_call/tool_result）与子任务观察。仅展示；终态以服务端为准。 */
function LiveProgress({ live }: { live: LiveTurn }) {
  const steps = live.steps ?? [];
  const { tasks } = partitionSubagentCalls(live.subagentCalls ?? []);
  if (!steps.length && !tasks.length) return null;
  return (
    <div className="live-progress" data-testid="live-progress">
      {tasks.length ? <div className="subagent-list">{tasks.map((g) => <SubagentCard key={g.id} group={g} />)}</div> : null}
      {steps.length ? (
        <ol className="live-steps" aria-label="本轮工具步骤">
          {steps.map((st) => (
            <li key={st.callId} data-step-state={st.state}>
              <span className={`status-chip tone-${STEP_TONE[st.state]}`}>{STEP_LABEL[st.state]}</span>
              <code>{st.toolId}</code>
              {st.durationMs != null ? <span className="muted">{Math.round(st.durationMs)}ms</span> : null}
              {st.summary ? <span className="muted live-step-summary">{st.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function MemoryAction({ ws, sessionId, m }: { ws: string; sessionId: string; m: ChatMessage }) {
  const scope = `${ws}:${sessionId}:${m.message_id ?? m.metadata?.client_request_id ?? m.created_at}`;
  const [state, setState] = useState<MemoryWriteState>({ kind: "idle" });
  const blocked = state.kind === "writing" || state.kind === "written" || state.kind === "unknown" || state.kind === "readback_missing";
  return (
    <span className="memory-action">
      {!blocked ? (
        <Button onClick={async () => {
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
  if (!artifactId) return <span className="muted" title="存为知识需要本轮产出文件">（无产出文件，不能存为知识）</span>;
  return (
    <span>
      <Button onClick={async () => setO(await api.post("/api/knowledge/sources/from-artifact", { workspace_id: ws, artifact_id: artifactId }))} disabled={!!o && o.kind === "http" && o.status < 300}>存为知识</Button>
      {o ? (o.kind === "http" && o.status < 300 ? <ReceiptNote text={`已提交入库（来源状态：${String(bodyOf<{ source?: { status?: string } }>(o)?.source?.status ?? "未上报")}）`} /> : <FailureNote outcome={o} />) : null}
    </span>
  );
}

export function Thread({ ws, sessionId, messages, live, task, availableExtensions, onResume }: {
  ws: string; sessionId: string; messages: ChatMessage[]; live: LiveTurn | null;
  task: SessionTask | null; availableExtensions: Set<string>; onResume: (taskId: string) => void;
}) {
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant"), [messages]);
  const taskUnknown = !!task && (task.unknowns?.length ?? 0) > 0;
  return (
    <div className="wb-thread" data-testid="thread">
      {messages.length === 0 && !live ? <p className="muted">在下方输入第一句话开始。</p> : null}
      <ol className="messages">
        {messages.map((m, i) => {
          const kind = m.role === "assistant" ? terminalKind(m) : "normal";
          const verify = unknownTargetHref(ws, sessionId, m.metadata?.task_id ?? (taskUnknown ? task?.task_id : undefined), m.metadata?.operation_id);
          return (
            <li key={m.message_id ?? i} className={`message role-${m.role}`} data-role={m.role}>
              {m.role === "assistant" ? <div className="message-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} /> : <div className="message-body">{m.content}</div>}
              {m.role === "assistant" ? (
                <>
                  {kind === "cancelled" ? <p className="inline-alert tone-info" role="status">本轮已按请求停止（服务端确认）。</p> : null}
                  {kind === "error" ? <p className="inline-alert tone-danger" role="alert">本轮报错：{(m.errors ?? []).join("；")}</p> : null}
                  <ToolCards m={m} ws={ws} available={availableExtensions} />
                  <OutcomeBar facts={turnFacts(m)} toolCalls={m.metadata?.tool_calls ?? []} verifyHref={verify} resumeHref={verify} />
                  {m === lastAssistant ? (
                    <div className="row-actions">
                      <MemoryAction ws={ws} sessionId={sessionId} m={m} />
                      <KnowledgeAction ws={ws} m={m} />
                    </div>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
        {live ? (
          <li className="message role-assistant is-live" aria-live="polite" data-testid="live-turn">
            <div className="message-body">{live.text || "…"}</div>
            <LiveProgress live={live} />
            <p className="muted">{live.status}</p>
          </li>
        ) : null}
      </ol>
      {task && !live ? <TaskResumeBar ws={ws} sessionId={sessionId} task={task} onResume={onResume} /> : null}
    </div>
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
