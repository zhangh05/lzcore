import { useEffect, useState } from "react";
import { IconAlert, IconCheck, IconClock, IconUsers, IconXCircle } from "../../components/Icon";
import {
  SUBAGENT_ACTIVITY, SUBAGENT_CHECKS, subagentRoleLabel, subagentState, subagentStatusLabel, type SubagentGroup,
} from "./subagents";

const TONE = { running: "info", done: "ok", failed: "danger", unknown: "unknown" } as const;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function elapsed(startedAt: string, finishedAt: string, now: number): string | null {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.max(0, Math.floor((end - start) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** 一个子 Agent 任务：角色、状态（以 task_status 为准）、指令、进度与全部观察记录。 */
export function SubagentCard({ group }: { group: SubagentGroup }) {
  const o = group.latest;
  const state = subagentState(o);
  const now = useNow(state === "running");
  const time = elapsed(o.startedAt, o.finishedAt, now);
  const p = o.progress;
  const activity = SUBAGENT_ACTIVITY[String(p.event || "")] || "";
  const Icon = state === "running" ? IconClock : state === "done" ? IconCheck : state === "failed" ? IconXCircle : IconAlert;
  const tracking = (o.output.tracking ?? {}) as Record<string, unknown>;
  return (
    <section className={`subagent-card tone-${TONE[state]}`} data-testid="subagent-card" data-subtask-id={group.id} data-state={state}>
      <header className="subagent-head">
        <IconUsers size={16} aria-hidden />
        <strong>{subagentRoleLabel(o.profile)}</strong>
        <span className={`status-chip tone-${TONE[state]}`} data-testid="subagent-status"><Icon size={12} aria-hidden />{subagentStatusLabel(o)}</span>
        {time ? <span className="muted">{state === "running" ? "已运行" : "用时"} {time}</span> : null}
      </header>
      {o.instruction ? <p className="subagent-instruction">{o.instruction}</p> : null}
      <div className="subagent-progress">
        {activity ? <span>{activity}</span> : null}
        {typeof p.model_responses === "number" ? <span>模型响应 {p.model_responses} 次</span> : null}
        {typeof p.tool_results === "number" ? <span>工具结果 {p.tool_results} 项</span> : null}
        {p.completion_status ? <span>验证：{SUBAGENT_CHECKS[String(p.completion_status)] || "状态待核对"}</span> : null}
      </div>
      {tracking.auto_polling === "stopped" && state === "running" ? <p className="muted">观察已暂停，子任务仍在运行。</p> : null}
      {o.output.content_complete === false ? <p className="inline-alert tone-unknown">完整结果未取得，请核对原任务与结果引用。</p> : null}
      <details className="subagent-observations">
        <summary>观察记录 · {group.observations.length} 次</summary>
        <p className="muted"><code>{group.id}</code>{p.tool ? ` · 最近工具：${String(p.tool)}${p.action ? ` / ${String(p.action)}` : ""}` : ""}</p>
        <ol>
          {group.observations.map((item, i) => (
            <li key={`${item.call.call_id ?? "obs"}-${i}`}>
              {subagentStatusLabel(item)} · {item.call.ok === false ? "读取失败" : "读取成功"}
              {item.call.duration_ms != null ? ` · ${Math.round(item.call.duration_ms)}ms` : ""}
              {item.call.summary ? <span className="muted"> · {item.call.summary}</span> : null}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
