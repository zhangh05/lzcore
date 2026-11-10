import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "../../components/Button";
import type { ChatMessage, StageOutput } from "./model";
import type { SessionTask } from "./Workbench";

/** 进度与证据栏：只展示后端 stage_outputs 与 task-state 步骤，不自造阶段。可收起、可拖宽。 */
export function ProgressPanel({ last, task, liveEvents, collapsed, onToggle }: {
  last?: ChatMessage; task: SessionTask | null; liveEvents: string[]; collapsed: boolean; onToggle: () => void;
}) {
  const [width, setWidth] = useState(320);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [view, setView] = useState<"progress" | "timeline">("progress");
  if (collapsed) return <aside className="wb-progress is-collapsed" aria-label="进度栏（已收起）"><Button variant="ghost" onClick={onToggle} aria-label="展开进度栏">«</Button></aside>;
  const stages: StageOutput[] = last?.metadata?.stage_outputs ?? [];
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
          <h3>阶段输出</h3>
          {stages.length ? (
            <ol className="stage-list" data-testid="stage-outputs">
              {stages.map((s, i) => <li key={i}><strong>{s.title ?? s.stage}</strong>{s.status ? <span className="status-chip">{s.status}</span> : null}<p className="muted">{s.summary}</p></li>)}
            </ol>
          ) : <p className="muted">后端未返回 stage_outputs。</p>}
          <h3>任务步骤</h3>
          {task ? (
            <>
              <p className="muted">任务 {task.task_id} · 状态 {task.status ?? "未上报"} · 未知项 {task.unknowns?.length ?? 0}</p>
              {(task.recovery_goals ?? []).length ? (
                <ol className="stage-list">{task.recovery_goals!.map((g, i) => <li key={g.goal_id ?? i}>{g.description ?? g.goal_id} <span className="status-chip">{g.status}</span></li>)}</ol>
              ) : <p className="muted">没有步骤 / 目标记录。</p>}
            </>
          ) : <p className="muted">本会话还没有任务状态。</p>}
        </>
      ) : (
        <ol className="timeline" data-testid="timeline">
          {liveEvents.length ? liveEvents.map((e, i) => <li key={i}>{e}</li>) : <li className="muted">本轮还没有实时事件。</li>}
        </ol>
      )}
    </aside>
  );
}
