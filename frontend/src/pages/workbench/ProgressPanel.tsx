import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { Button } from "../../components/Button";
import { RawData, fmtTime } from "../../kit/ui";
import { IconCheckCircle, IconChevronLeft, IconChevronRight, IconClock, IconInfo, IconWarningCircle, IconXCircle } from "../../components/Icon";
import { stageViews, type ChatMessage } from "./model";
import type { SessionTask } from "./Workbench";
import { renderMarkdown } from "../../utils/markdown";

/** 有没有可展示的进度事实：阶段输出（有字段的）、会话 task-state、或本轮实时事件。 */
export function hasProgressContent(last: ChatMessage | undefined, task: SessionTask | null, liveEvents: string[]): boolean {
  return stageViews(last?.metadata?.stage_outputs).length > 0 || !!last?.run_id || !!task?.task_id || !!task?.status || liveEvents.length > 0;
}

const OUTCOME_ZH: Record<string, string> = { complete: "完成", partial: "部分完成", failed: "失败", unknown: "结果未知", blocked: "受阻" };
export const outcomeZh = (v?: unknown) => (typeof v === "string" && v ? `${OUTCOME_ZH[v] ?? v}（${v}）` : "未上报");

export interface RunAudit {
  run_id?: string; execution_outcome?: string; final_response_summary?: string; created_at?: string; finished_at?: string; error?: unknown;
  llm_metadata?: { provider?: string; model?: string; used?: boolean };
  metadata?: { cognitive_events?: { created_at?: string; type?: string; payload?: { visible_summary?: string } }[] };
}
export interface TraceEvent { name?: string; type?: string; timestamp?: number | string; duration_ms?: number }

/** 回合结束后实时事件随 settle 清空；时间线改从已持久化的运行审计与 trace 回读（只读现有接口，不自造历史）。 */
export function usePersistedRun(ws: string | undefined, runId: string | undefined) {
  const [state, setState] = useState<{ runId?: string; audit: RunAudit | null; trace: TraceEvent[] | null; auditError?: string; traceError?: string }>({ audit: null, trace: null });
  useEffect(() => {
    if (!ws || !runId) { setState({ audit: null, trace: null }); return; }
    let alive = true;
    const base = `/api/workspaces/${enc(ws)}/runs/${enc(runId)}`;
    void Promise.all([api.get(base, { workspace_id: ws }), api.get(`${base}/trace`, { workspace_id: ws })]).then(([a, t]) => {
      if (!alive) return;
      const ab = bodyOf<RunAudit & { run?: RunAudit }>(a);
      const tb = bodyOf<{ events?: TraceEvent[]; trace?: { events?: TraceEvent[] } }>(t);
      setState({
        runId,
        audit: a.kind === "http" && a.status === 200 ? (ab?.run ?? ab ?? null) : null,
        auditError: a.kind === "http" && a.status === 200 ? undefined : a.kind === "http" ? `HTTP ${a.status}` : "网络失败",
        trace: t.kind === "http" && t.status === 200 ? (tb?.events ?? tb?.trace?.events ?? []) : null,
        traceError: t.kind === "http" && t.status === 200 ? undefined : t.kind === "http" ? `HTTP ${t.status}` : "网络失败",
      });
    });
    return () => { alive = false; };
  }, [ws, runId]);
  return state;
}

const TONE_ICON = { ok: IconCheckCircle, danger: IconXCircle, warn: IconWarningCircle, info: IconInfo } as const;
const OUTCOME_PLAIN: Record<string, { label: string; tone: keyof typeof TONE_ICON; hint: string }> = {
  complete: { label: "已完成", tone: "ok", hint: "这一轮的任务做完了。" },
  partial: { label: "部分完成", tone: "warn", hint: "完成了一部分，剩下的可以继续追问。" },
  failed: { label: "没有完成", tone: "danger", hint: "这一轮出错了，可以换个说法重试。" },
  blocked: { label: "被卡住了", tone: "warn", hint: "需要你确认或补充信息后才能继续。" },
  unknown: { label: "结果待确认", tone: "warn", hint: "有操作的结果还不确定，建议核对一下。" },
};
/** 结果码 → 用户看得懂的标签和色调（任务页、详情栏共用）。 */
export function outcomePlain(v?: string): { label: string; tone: "ok" | "warn" | "danger" | "info" } | null {
  if (!v) return null;
  const o = OUTCOME_PLAIN[v];
  return o ? { label: o.label, tone: o.tone } : { label: v, tone: "info" };
}
const TASK_PLAIN: Record<string, string> = { completed: "已结束", running: "进行中", pending: "排队中", failed: "出错了", cancelled: "已取消", interrupted: "中途停止", blocked: "等你处理" };
const GOAL_PLAIN: Record<string, string> = { done: "完成", completed: "完成", running: "进行中", pending: "待办", failed: "失败", blocked: "受阻" };
const STEP_PLAIN: Record<string, string> = { turn_start: "收到你的消息，开始处理", model: "调用模型思考", final: "整理并发出回复", tool: "使用工具", tool_call: "使用工具", error: "遇到错误" };

const LIVE_PLAIN: Record<string, string> = {
  turn_started: "开始处理", run_started: "开始处理", model_started: "模型正在思考", tool_call: "使用工具", tool_call_started: "使用工具",
  tool_result: "工具返回结果", tool_call_finished: "工具返回结果", subagent_observation: "子任务汇报进展", review_started: "检查结果",
  validation_completed: "检查完成", publication_started: "整理回复", turn_finished: "处理结束", task_completed: "任务完成",
};
/** 实时事件 "名称 · 工具 · 标题" → 用户看得懂的一行；未知事件保留原名，不吞掉。 */
export function liveLabel(raw: string): { label: string; detail?: string } {
  const [name, ...rest] = raw.split(" · ");
  return { label: LIVE_PLAIN[name] ?? name, detail: rest.join(" · ") || undefined };
}

/** 毫秒 → 人话：不到 1 秒 / 3.2 秒 / 1 分 05 秒。 */
export function humanDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return "不到 1 秒";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m} 分 ${String(sec).padStart(2, "0")} 秒`;
}
const clock = (v?: string | number) => {
  if (v === undefined || v === "") return "";
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour12: false });
};
const elapsed = (a?: string, b?: string) => {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) ? humanDuration(ms) : null;
};

/**
 * 本轮详情：先告诉用户「结果怎样、做了什么」，技术来源折叠在最后。
 * 只展示后端事实，不自造阶段，不合成结论：结果卡优先用回复自带的结论，缺失时才用同一轮的运行记录，并注明来自运行记录；
 * 回复结论、运行记录、会话任务三个来源在「技术细节」里分开写清。
 */
export function ProgressPanel({ ws, last, task, liveEvents, collapsed, onToggle }: {
  ws?: string; last?: ChatMessage; task: SessionTask | null; liveEvents: string[]; collapsed: boolean; onToggle: () => void;
}) {
  const [width, setWidth] = useState(340);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const lastRun = last?.run_id ?? (typeof last?.metadata?.run_id === "string" ? last.metadata.run_id : undefined);
  const running = liveEvents.length > 0;
  const persisted = usePersistedRun(ws, running ? undefined : lastRun);
  if (collapsed) return <aside className="wb-progress is-collapsed" aria-label="本轮详情（已收起）"><Button variant="ghost" onClick={onToggle} aria-label="展开本轮详情" icon={<IconChevronLeft size={16} aria-hidden="true" />} /></aside>;
  const stages = stageViews(last?.metadata?.stage_outputs);
  const msgRun = lastRun;
  const audit = msgRun && persisted.runId === msgRun ? persisted.audit : null;
  const auditReady = !!msgRun && persisted.runId === msgRun;
  const msgOutcome = typeof last?.metadata?.execution_outcome === "string" ? last.metadata.execution_outcome : undefined;
  const outcomeKey = msgOutcome ?? audit?.execution_outcome;
  const outcome = outcomeKey ? OUTCOME_PLAIN[outcomeKey] ?? { label: outcomeKey, tone: "info" as const, hint: "" } : null;
  const fromAudit = !msgOutcome && !!audit?.execution_outcome;
  // 真实 runtime.task_state.v1 的 task 用 last_run_id / objective_run_id；兼容旧 run_id。
  const taskRun = task?.last_run_id ?? task?.run_id ?? task?.objective_run_id;
  const sameRun = !!msgRun && !!taskRun && msgRun === taskRun;
  const goals = task?.recovery_goals ?? [];
  const unknowns = task?.unknowns?.length ?? 0;
  const thoughts = (audit?.metadata?.cognitive_events ?? []).filter((c) => c.payload?.visible_summary);
  const model = audit?.llm_metadata?.model;
  const took = elapsed(audit?.created_at, audit?.finished_at);
  const onDown = (e: PointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, w: width }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(Math.max(260, Math.min(640, drag.current.w + (drag.current.x - e.clientX)))); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth((w) => Math.min(640, w + 16));
    if (e.key === "ArrowRight") setWidth((w) => Math.max(260, w - 16));
  };
  const ToneIcon = running ? IconClock : outcome ? TONE_ICON[outcome.tone] : IconInfo;
  return (
    <aside className="wb-progress" style={{ width }} aria-label="本轮详情" data-testid="progress-panel">
      <div className="resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整详情栏宽度" aria-valuenow={width} aria-valuemin={260} aria-valuemax={640} tabIndex={0}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onKeyDown={onKey} />
      <header className="pp-head">
        <h2>本轮详情</h2>
        <Button variant="ghost" onClick={onToggle} aria-label="收起本轮详情" icon={<IconChevronRight size={16} aria-hidden="true" />} />
      </header>

      <section className={`pp-result tone-${running ? "info" : outcome?.tone ?? "info"}`} data-testid="progress-result">
        <span className="pp-result-icon" aria-hidden="true"><ToneIcon size={20} /></span>
        <div className="pp-result-body">
          <strong>{running ? "正在处理…" : outcome?.label ?? (last ? "结果未上报" : "还没有回复")}</strong>
          <p>{running ? "可以在下面看到实时进展。" : outcome?.hint || (last ? "这条回复没有附带完成状态。" : "发一条消息后，这里会显示处理结果。")}</p>
          {!running && (took || model || audit?.finished_at) ? (
            <dl className="pp-facts">
              {took ? <div><dt>用时</dt><dd>{took}</dd></div> : null}
              {model ? <div><dt>模型</dt><dd>{model}</dd></div> : null}
              {audit?.finished_at ? <div><dt>完成于</dt><dd>{clock(audit.finished_at)}</dd></div> : null}
            </dl>
          ) : null}
          {fromAudit ? <p className="pp-note">结果来自这一轮的运行记录。</p> : null}
        </div>
      </section>

      {task && (task.objective || goals.length || unknowns) ? (
        <section className="pp-section" data-testid="progress-task">
          <h3>任务</h3>
          {task.objective ? <p className="pp-objective">{task.objective}</p> : null}
          {goals.length ? (
            <ul className="pp-goals">{goals.map((g, i) => <li key={g.goal_id ?? i} data-state={g.status}><span className="pp-goal-dot" aria-hidden="true" />{g.description ?? "未命名步骤"}<span className="pp-goal-state">{GOAL_PLAIN[g.status ?? ""] ?? g.status ?? ""}</span></li>)}</ul>
          ) : null}
          {unknowns ? <p className="inline-alert tone-warn">有 {unknowns} 项操作结果还不确定，建议到「待核对」里确认。</p> : null}
        </section>
      ) : null}

      <section className="pp-section">
        <h3>处理过程</h3>
        {running ? (
          <ol className="pp-steps is-live" data-testid="timeline">{liveEvents.map((e, i) => <li key={i} className={i === liveEvents.length - 1 ? "is-current" : ""}><span className="pp-step-dot" aria-hidden="true" /><span className="pp-step-label">{liveLabel(e).label}{liveLabel(e).detail ? <span className="pp-step-extra"> · {liveLabel(e).detail}</span> : null}</span></li>)}</ol>
        ) : !lastRun ? (
          <p className="pp-empty">还没有处理记录。</p>
        ) : !auditReady ? (
          <p className="pp-empty">正在读取处理记录…</p>
        ) : persisted.trace?.length ? (
          <ol className="pp-steps" data-testid="timeline">
            {persisted.trace.map((e, i) => {
              const label = STEP_PLAIN[e.type ?? ""] ?? e.name ?? "处理步骤";
              // 回合开始 / 模型调用 / 最终回复的 name 只是同义标签，不再重复；工具等步骤才补上具体名称。
              const extra = e.name && STEP_PLAIN[e.type ?? ""] && !["turn_start", "model", "final"].includes(e.type ?? "") ? e.name : null;
              return (
                <li key={i}><span className="pp-step-dot" aria-hidden="true" />
                  <span className="pp-step-label">{label}{extra ? <span className="pp-step-extra"> · {extra}</span> : null}</span>
                  <span className="pp-step-meta">{[clock(e.timestamp), humanDuration(e.duration_ms)].filter(Boolean).join(" · ")}</span>
                </li>
              );
            })}
          </ol>
        ) : <p className="pp-empty">{persisted.trace ? "这一轮没有记录到处理步骤。" : "处理记录暂时读不到。"}</p>}
      </section>

      {thoughts.length ? (
        <section className="pp-section" data-testid="timeline-cognitive">
          <h3>思路要点</h3>
          <ul className="pp-thoughts">{thoughts.map((c, i) => <li key={i}>{c.payload!.visible_summary}</li>)}</ul>
        </section>
      ) : null}

      {stages.length ? (
        <section className="pp-section">
          <h3>中间结果</h3>
          <ol className="pp-stages" data-testid="stage-outputs">
            {stages.map((s) => (
              <li key={s.key}>
                <details>
                  <summary><span>{s.title}</span>{s.status ? <span className="pp-goal-state">{GOAL_PLAIN[s.status] ?? s.status}</span> : null}</summary>
                  {s.text ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.text) }} /> : null}
                </details>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <details className="pp-tech" data-testid="progress-tech">
        <summary>技术细节</summary>
        <dl className="pp-tech-list">
          <div data-testid="progress-message-outcome"><dt>回复结论</dt><dd>{outcomeZh(msgOutcome)}{msgRun ? ` · run ${msgRun}` : ""}{last?.created_at ? ` · ${fmtTime(last.created_at)}` : ""}</dd></div>
          {msgRun ? (
            <div data-testid="progress-run-outcome"><dt>运行记录</dt><dd>{auditReady ? (audit ? outcomeZh(audit.execution_outcome) : `读取失败（${persisted.auditError}）`) : "读取中"} · GET /api/workspaces/{ws}/runs/{msgRun}</dd></div>
          ) : null}
          {task && (task.task_id || task.status) ? (
            <div data-testid="progress-task-state"><dt>会话任务</dt><dd>{TASK_PLAIN[task.status ?? ""] ?? task.status ?? "未上报"}（{task.status ?? "未上报"}） · 任务 {task.task_id ?? "—"}{taskRun ? ` · run ${taskRun}` : ""}{msgRun && taskRun && !sameRun ? " · 与本条回复不是同一轮" : ""}</dd></div>
          ) : null}
          {auditReady && persisted.trace ? <div><dt>步骤来源</dt><dd>GET /api/workspaces/{ws}/runs/{msgRun}/trace</dd></div> : null}
        </dl>
        {auditReady ? <RawData value={{ audit: persisted.audit, trace: persisted.trace }} label="原始记录" /> : null}
      </details>
    </aside>
  );
}
