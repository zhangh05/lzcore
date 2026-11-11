import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { Button } from "../../components/Button";
import { outcomeView } from "../../contracts/outcomeState";
import { RawData, fmtTime } from "../../kit/ui";
import { stageViews, turnFacts, type ChatMessage } from "./model";
import type { SessionTask } from "./Workbench";
import { renderMarkdown } from "../../utils/markdown";

/** 有没有可展示的进度事实：阶段输出（有字段的）、会话 task-state、或本轮实时事件。 */
export function hasProgressContent(last: ChatMessage | undefined, task: SessionTask | null, liveEvents: string[]): boolean {
  return stageViews(last?.metadata?.stage_outputs).length > 0 || !!last?.run_id || !!task?.task_id || !!task?.status || liveEvents.length > 0;
}

const OUTCOME_ZH: Record<string, string> = { complete: "完成", partial: "部分完成", failed: "失败", unknown: "结果未知", blocked: "受阻" };
const SESSION_TASK_STATUS_ZH: Record<string, string> = { completed: "执行已结束", running: "执行中", pending: "等待执行", failed: "执行报错", cancelled: "已取消", interrupted: "已中断", blocked: "受阻" };
export const outcomeZh = (v?: unknown) => (typeof v === "string" && v ? `${OUTCOME_ZH[v] ?? v}（${v}）` : "未上报");

export interface RunAudit {
  run_id?: string; execution_outcome?: string; final_response_summary?: string; created_at?: string; finished_at?: string; error?: unknown;
  llm_metadata?: { provider?: string; model?: string; used?: boolean };
  metadata?: { cognitive_events?: { created_at?: string; type?: string; payload?: { visible_summary?: string } }[] };
}
export interface TraceEvent { name?: string; type?: string; timestamp?: number | string; duration_ms?: number }
const TRACE_ZH: Record<string, string> = { turn_start: "回合开始", model: "模型调用", final: "生成最终回复", tool: "工具调用", tool_call: "工具调用", error: "错误" };
const tsText = (t?: number | string) => t === undefined ? "时间未上报" : fmtTime(typeof t === "number" ? new Date(t * 1000).toISOString() : t);

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

/**
 * 进度与证据栏：只展示后端事实，不自造阶段，不合成结论。
 * 两个事实源分开标注，互不覆盖：
 *  - 本条回复的结论：最后一条助手消息 metadata.execution_outcome（缺失即「结论未上报」）；
 *  - 会话 task-state：GET /api/runtime/sessions/<id>/task-state 的 task.status（运行时任务状态，不是消息结论）。
 */
export function ProgressPanel({ ws, last, task, liveEvents, collapsed, onToggle }: {
  ws?: string; last?: ChatMessage; task: SessionTask | null; liveEvents: string[]; collapsed: boolean; onToggle: () => void;
}) {
  const [width, setWidth] = useState(320);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [view, setView] = useState<"progress" | "timeline">("progress");
  const lastRun = last?.run_id ?? (typeof last?.metadata?.run_id === "string" ? last.metadata.run_id : undefined);
  const persisted = usePersistedRun(ws, liveEvents.length ? undefined : lastRun);
  if (collapsed) return <aside className="wb-progress is-collapsed" aria-label="进度栏（已收起）"><Button variant="ghost" onClick={onToggle} aria-label="展开进度栏">«</Button></aside>;
  const stages = stageViews(last?.metadata?.stage_outputs);
  const msgOutcome = last ? outcomeView(turnFacts(last)) : null;
  const msgRun = last?.run_id ?? (typeof last?.metadata?.run_id === "string" ? last.metadata.run_id : undefined);
  // 真实 runtime.task_state.v1 的 task 用 last_run_id / objective_run_id；兼容旧 run_id。
  const taskRun = task?.last_run_id ?? task?.run_id ?? task?.objective_run_id;
  const sameRun = !!msgRun && !!taskRun && msgRun === taskRun;
  const onDown = (e: PointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, w: width }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(Math.max(240, Math.min(640, drag.current.w + (drag.current.x - e.clientX)))); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth((w) => Math.min(640, w + 16));
    if (e.key === "ArrowRight") setWidth((w) => Math.max(240, w - 16));
  };
  return (
    <aside className="wb-progress" style={{ width }} aria-label="进度与证据" data-testid="progress-panel">
      <div className="resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整进度栏宽度" aria-valuenow={width} aria-valuemin={240} aria-valuemax={640} tabIndex={0}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onKeyDown={onKey} />
      <div className="row-actions">
        <button type="button" className={`tab ${view === "progress" ? "is-active" : ""}`} onClick={() => setView("progress")}>进度</button>
        <button type="button" className={`tab ${view === "timeline" ? "is-active" : ""}`} onClick={() => setView("timeline")} data-testid="timeline-tab">时间线</button>
        <span className="grow" />
        <Button variant="ghost" onClick={onToggle} aria-label="收起进度栏">»</Button>
      </div>
      {view === "progress" ? (
        <>
          <h3>本条回复的结论</h3>
          {msgOutcome ? (
            <div data-testid="progress-message-outcome">
              <p><span className={`status-chip tone-${msgOutcome.tone}`}>回复结论：{outcomeZh(last?.metadata?.execution_outcome)}</span></p>
              <details><summary className="muted">回复记录来源</summary><p className="muted">消息 execution_outcome：{outcomeZh(last?.metadata?.execution_outcome)} · 来源：最后一条回复 metadata{msgRun ? ` · run ${msgRun}` : ""}{last?.created_at ? ` · ${fmtTime(last.created_at)}` : ""}</p></details>
            </div>
          ) : <p className="muted">本会话还没有回复。</p>}
          {msgRun && persisted.runId === msgRun ? (
            <div data-testid="progress-run-outcome">
              <p><span className="status-chip">运行结论：{persisted.audit ? outcomeZh(persisted.audit.execution_outcome) : `不可读（${persisted.auditError}）`}</span></p>
              <details><summary className="muted">运行记录来源</summary><p className="muted">运行审计 execution_outcome：{persisted.audit ? outcomeZh(persisted.audit.execution_outcome) : "未上报"} · 来源：GET /api/workspaces/{ws}/runs/{msgRun}（与消息字段是两个事实源，分别显示）</p></details>
            </div>
          ) : null}
          <h3>阶段输出</h3>
          {stages.length ? (
            <ol className="stage-list" data-testid="stage-outputs">
              {stages.map((s) => <li key={s.key}><strong>{s.title}</strong>{s.status ? <span className="status-chip">{s.status}</span> : null}{s.text ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.text) }} /> : null}</li>)}
            </ol>
          ) : <p className="muted">尚无阶段输出。</p>}
          <h3>会话任务状态</h3>
          {task && (task.task_id || task.status) ? (
            <div data-testid="progress-task-state">
              <p><span className="status-chip">{SESSION_TASK_STATUS_ZH[task.status ?? ""] ?? task.status ?? "状态未上报"}</span> · 待核对 {task.unknowns?.length ?? 0} 项</p>
              {msgRun && taskRun && !sameRun ? <p className="inline-alert tone-warn">此任务与最后一条回复属于不同运行。</p> : null}
              <details><summary className="muted">会话任务来源</summary><p className="muted">task-state：{task.status ?? "未上报"} · 来源：会话 task-state（运行时任务状态，不等于回复结论）</p><p className="muted">任务 {task.task_id ?? "—"}{taskRun ? ` · run ${taskRun}` : ""}</p></details>
              {(task.recovery_goals ?? []).length ? (
                <ol className="stage-list">{task.recovery_goals!.map((g, i) => <li key={g.goal_id ?? i}>{g.description ?? g.goal_id} <span className="status-chip">{g.status}</span></li>)}</ol>
              ) : <p className="muted">没有步骤 / 目标记录。</p>}
            </div>
          ) : <p className="muted">本会话还没有任务状态。</p>}
        </>
      ) : (
        liveEvents.length ? (
          <>
            <p className="muted">来源：本轮实时事件（进行中）</p>
            <ol className="timeline" data-testid="timeline">{liveEvents.map((e, i) => <li key={i}>{e}</li>)}</ol>
          </>
        ) : !lastRun ? (
          <ol className="timeline" data-testid="timeline"><li className="muted">本会话还没有运行记录。</li></ol>
        ) : persisted.runId !== lastRun ? (
          <ol className="timeline" data-testid="timeline"><li className="muted">正在读取 run {lastRun} 的持久化记录…</li></ol>
        ) : (
          <div data-testid="timeline-persisted">
            <p className="muted">已结束回合 · 来源：GET /api/workspaces/{ws}/runs/{lastRun}/trace 与运行审计（持久化记录，非实时）</p>
            {persisted.audit ? (
              <p data-testid="timeline-run-summary">
                <span className="status-chip">{outcomeZh(persisted.audit.execution_outcome)}</span>{" "}
                <span className="muted">{persisted.audit.created_at ? fmtTime(persisted.audit.created_at) : "开始时间未上报"} → {persisted.audit.finished_at ? fmtTime(persisted.audit.finished_at) : "结束时间未上报"}
                  {persisted.audit.llm_metadata?.provider ? ` · 模型 ${persisted.audit.llm_metadata.provider}/${persisted.audit.llm_metadata.model ?? "?"}` : ""}</span>
              </p>
            ) : <p className="muted">运行审计不可读（{persisted.auditError}）。</p>}
            {persisted.trace ? (
              persisted.trace.length ? (
                <ol className="timeline" data-testid="timeline">
                  {persisted.trace.map((e, i) => <li key={i}><strong>{TRACE_ZH[e.type ?? ""] ?? e.name ?? e.type ?? "事件"}</strong> <span className="muted">{tsText(e.timestamp)}{typeof e.duration_ms === "number" ? ` · ${e.duration_ms} ms` : ""}{e.name && TRACE_ZH[e.type ?? ""] && e.name !== TRACE_ZH[e.type ?? ""] ? ` · ${e.name}` : ""}</span></li>)}
                </ol>
              ) : <ol className="timeline" data-testid="timeline"><li className="muted">该 run 的 trace 没有事件。</li></ol>
            ) : <p className="muted">trace 不可读（{persisted.traceError}）。</p>}
            {(persisted.audit?.metadata?.cognitive_events ?? []).length ? (
              <>
                <h3>推理过程摘要</h3>
                <ol className="timeline" data-testid="timeline-cognitive">
                  {persisted.audit!.metadata!.cognitive_events!.map((c, i) => <li key={i}>{c.payload?.visible_summary ?? c.type} <span className="muted">{c.created_at ? fmtTime(c.created_at) : ""}</span></li>)}
                </ol>
              </>
            ) : null}
            {persisted.audit?.final_response_summary ? <p className="muted">运行摘要：{persisted.audit.final_response_summary}</p> : null}
            <RawData value={{ audit: persisted.audit, trace: persisted.trace }} label="运行审计 / trace 原始数据" />
          </div>
        )
      )}
    </aside>
  );
}
