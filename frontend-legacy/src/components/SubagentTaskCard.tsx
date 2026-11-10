import { useEffect, useState } from "react";
import { IconAlert, IconCheck, IconClock, IconUsers } from "./Icon";
import { subagentEvidenceState, subagentRoleLabel, subagentStatusLabel, type SubagentGroup } from "../utils/subagentTracking";
import "./SubagentTaskCard.css";

const CHECKS: Record<string,string> = {pending:"待验证",passed:"通过",failed:"失败",unknown:"结果待核对"};
const ACTIVITY: Record<string,string> = {model_started: "等待模型响应", model_completed: "模型已响应", execution_started: "正在执行工具", tool_result: "已取得工具结果"};
export function SubagentTaskCard({ group }: { group: SubagentGroup }) {
  const observation = group.latest;
  const live = ["created", "running"].includes(observation.status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const start = Date.parse(observation.startedAt);
  const finish = observation.finishedAt ? Date.parse(observation.finishedAt) : now;
  const seconds = Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, Math.floor((finish-start)/1000)) : null;
  const progress = observation.progress;
  const activity = ACTIVITY[String(progress.event || "")] || "";
  const failed = ["failed", "cancelled", "canceled"].includes(observation.status);
  const uncertain = subagentEvidenceState(observation) === "unknown";
  const complete = observation.status === "succeeded" && !uncertain;
  return <section id={`tool-call-subagent-${group.id}`} className="subagent-card" data-testid="subagent-task-card" data-task-id={group.id}>
    <div className="subagent-card-heading">
      <IconUsers size={16} aria-hidden="true" />
      <strong>{subagentRoleLabel(observation.profile)}</strong>
      <span className={`subagent-task-status ${uncertain ? "unknown" : live ? "live" : failed ? "fail" : complete ? "complete" : "unknown"}`}>
        {live ? <IconClock size={13} /> : complete ? <IconCheck size={13} /> : <IconAlert size={13} />}
        {subagentStatusLabel(observation)}
      </span>
      {seconds != null && <span className="subagent-elapsed">运行 {seconds}s</span>}
    </div>
    {observation.instruction && <p className="subagent-instruction">{observation.instruction}</p>}
    <div className="subagent-activity">
      {activity && <span>{activity}</span>}
      {typeof progress.model_responses === "number" && <span>模型响应 {progress.model_responses} 次</span>}
      {typeof progress.tool_results === "number" && <span>工具结果 {progress.tool_results} 项</span>}
      {Boolean(progress.completion_status) && <span>验证：{CHECKS[String(progress.completion_status)] || "状态待核对"}</span>}
    </div>
    {Boolean(observation.output.tracking) && (observation.output.tracking as Record<string,unknown>).auto_polling === "stopped" && live && <p>观察已暂停，子任务仍在运行。</p>}
    {observation.output.content_complete === false && <p>完整结果未取得，请核对原任务与结果引用。</p>}
    <details className="subagent-observations"><summary>观察记录 · {group.observations.length} 次</summary>
      <div className="subagent-task-id">{group.id}</div>
      {Boolean(progress.tool) && <p>最近工具：{String(progress.tool)}{progress.action ? ` / ${String(progress.action)}` : ""}</p>}
      {group.observations.map((item,index) => <div key={`${item.call.call_id}-${index}`} className="subagent-observation">
        <span>{index+1}. {subagentStatusLabel(item)}</span>
        <span>{item.call.ok ? "读取成功" : "读取失败"}</span>
        {item.call.duration_ms != null && <span>读取 {Math.round(item.call.duration_ms)}ms</span>}
        {item.call.summary && <p>{item.call.summary}</p>}
      </div>)}
    </details>
  </section>;
}
