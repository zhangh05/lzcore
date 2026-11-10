import { ACTION_LABEL, outcomeView, toolAttemptSummary, type ToolCallFacts, type TurnFacts } from "../contracts/outcomeState";
import { Link } from "../router";

/**
 * 单一结论条：目标结论 + 工具尝试统计 + 下一步动作。工作台、任务中心共用。
 * 未知态是常驻 alert，动作只有核对 / 标记 / 续接（都深链到可核对的那一条），没有重试。
 */
export function OutcomeBar({ facts, toolCalls = [], verifyHref, resumeHref, running, testId }: {
  facts: TurnFacts; toolCalls?: ToolCallFacts[]; verifyHref?: string; resumeHref?: string; running?: boolean; testId?: string;
}) {
  const v = outcomeView(facts, { running });
  const tools = toolCalls.length ? toolAttemptSummary(toolCalls, facts) : "未调用工具";
  return (
    <div className={`outcome-bar tone-${v.tone}`} role={v.persistentAlert ? "alert" : "status"} data-testid={testId ?? "outcome-bar"} data-goal={v.goal}>
      <span className={`status-chip tone-${v.tone}`} data-testid="goal-label">{v.goalLabel}</span>
      <span className="outcome-tools">{tools}</span>
      <span className="outcome-actions">
        {v.actions.map((a) => {
          if (a === "view_detail") return null;
          const href = a === "resume" ? (resumeHref ?? verifyHref) : verifyHref;
          return href ? <Link key={a} to={href} className="btn" data-action={a}>{ACTION_LABEL[a]}</Link>
            : <span key={a} className="muted" data-action={a}>{ACTION_LABEL[a]}（无可定位条目）</span>;
        })}
      </span>
    </div>
  );
}
