import { memo } from "react";
import type { ActiveTurnSnapshot } from "../../../types";
import type { ChatMsg } from "../../../stores/workbench";
import { IconBolt, IconCheck, IconChevronLeft, IconChevronRight, IconDocument, IconProbe, IconShield } from "../../../components/Icon";
import { buildTaskProgress } from "../../../utils/taskProgress";
import { formatStreamElapsedSeconds } from "../../../utils/streamElapsed";

type Props = {
  latestAssistant?: ChatMsg;
  snapshot?: ActiveTurnSnapshot;
  turnRunning: boolean;
  onShowTimeline: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

function statusText(status: string, evidenceCount: number): string {
  if (status === "running") return evidenceCount ? `正在处理 · ${evidenceCount} 次工具调用完成` : "正在处理";
  if (status === "succeeded") return evidenceCount ? `本轮已完成 · ${evidenceCount} 次工具调用完成` : "本轮已完成";
  if (status === "failed") return "本轮需要检查";
  return "等待任务";
}

function EvidenceIcon({ title }: { title: string }) {
  if (/防火墙|策略|安全|network|device/i.test(title)) return <IconShield size={15} />;
  if (/流量|数据|分析|python/i.test(title)) return <IconBolt size={15} />;
  if (/健康|检查|诊断/i.test(title)) return <IconProbe size={15} />;
  return <IconDocument size={14} />;
}

export const TaskProgressPanel = memo(function TaskProgressPanel({
  latestAssistant,
  snapshot,
  turnRunning,
  onShowTimeline,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const model = buildTaskProgress(latestAssistant, snapshot, { turnRunning });
  const visibleEvidence = model.evidence.slice(0, 6);

  return (
    <aside
      className={`task-progress-panel${collapsed ? " is-collapsed" : ""}`}
      aria-label="任务进度"
      data-testid="task-progress-panel"
    >
      {/*
        The rail answers "what is the agent doing right now" without becoming a
        log. Its header states the turn the way an operator would refer to it —
        which run, how long, how many tools, how many sources — and every one of
        those values is observed rather than estimated.
      */}
      <header className="task-progress-header">
        <div className="task-progress-header-title">
          <span className="task-progress-kicker">实时状态</span>
          <h2>任务进度</h2>
        </div>
        <span className={`task-progress-summary ${model.status}`}>
          <span className="status-dot" />
          <span className="task-progress-summary-text">
            {statusText(model.status, model.evidence.filter((item) => item.status === "done").length)}
          </span>
        </span>
        <div className="task-rail-facts">
          {model.runId ? (
            <span className="meta-fact" title={`运行 ${model.runId}`}>
              <span className="meta-label">run</span>
              <span className="meta">{model.runId.slice(0, 8)}</span>
            </span>
          ) : null}
          {model.elapsedMs !== undefined ? (
            <span className="meta-fact">
              <span className="meta-label">elapsed</span>
              <span className="meta">{formatStreamElapsedSeconds(model.elapsedMs)}</span>
            </span>
          ) : null}
          {model.toolCount > 0 ? (
            <span className="meta-fact">
              <span className="meta-label">tools</span>
              <span className="meta">{model.toolCount}</span>
            </span>
          ) : null}
        </div>
        <button
          className="task-progress-collapse"
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开实时状态" : "收起实时状态"}
          title={collapsed ? "展开实时状态" : "收起实时状态"}
        >
          <span className={"task-progress-summary " + model.status} aria-hidden="true">
            <span className="status-dot" />
          </span>
          {collapsed ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}
          <span>{collapsed ? "展开" : "收起"}</span>
        </button>
      </header>

      <div className="task-phase-list">
        {/* Overview first, details on demand: a stage states its title, state
            and observed duration, and only the open one carries prose and
            evidence. The active stage is open so the rail still narrates a
            running turn without any interaction. */}
        {model.phases.map((phase, index) => (
          <details className={`task-phase ${phase.state}`} key={phase.id} open={phase.state === "active"}>
            <summary className="task-phase-summary">
              <span className={`task-phase-index ${phase.state}`}>
                {phase.state === "done" ? <IconCheck size={12} weight="bold" /> : index + 1}
              </span>
              <h3>{phase.title}</h3>
              {/* Sub-second spans round to "0s" and tell the reader nothing, so
                  they are omitted rather than printed. */}
              {phase.durationMs !== undefined && phase.durationMs >= 1000 ? (
                <span className="meta-duration" title="该阶段已观测事件的时间跨度，不代表独占耗时">{formatStreamElapsedSeconds(phase.durationMs)}</span>
              ) : null}
              <span className={`task-phase-status-tag ${phase.state}`}>
                {phase.state === "done"
                  ? "已完成"
                  : phase.state === "active"
                  ? "进行中"
                  : phase.state === "failed"
                  ? "需检查"
                  : "等待中"}
              </span>
            </summary>
            <div className="task-phase-content">
              <p>{phase.description}</p>
              {phase.id === "evidence" && visibleEvidence.length > 0 ? (
                <div className="task-evidence-list">
                  {visibleEvidence.map((item) => (
                    <article className={`task-evidence ${item.status}`} key={item.id}>
                      <span className="task-evidence-icon">
                        <EvidenceIcon title={item.title} />
                      </span>
                      <div className="task-evidence-meta">
                        <strong>{item.title}</strong>
                        <span>来源：{item.source}</span>
                        {item.summary ? <small>{item.summary}</small> : null}
                      </div>
                      <span className="task-evidence-status" aria-label={item.status === "unknown" ? "结果未知" : item.status === "running" ? "进行中" : item.status === "done" ? "已完成" : "失败"}>
                        {item.status === "running" ? (
                          <span className="spinner-mini" />
                        ) : item.status === "done" ? (
                          <IconCheck size={14} weight="bold" />
                        ) : item.status === "unknown" ? "结果未知" : (
                          "!"
                        )}
                      </span>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        ))}
      </div>

      <footer className="task-progress-footer">
        <span className="task-progress-audit-note">
          <IconShield size={14} />
          <span>所有工具调用与分析结果均来自真实运行记录</span>
        </span>
        <button type="button" className="task-progress-timeline-btn" onClick={onShowTimeline}>
          查看完整时间线
        </button>
      </footer>
    </aside>
  );
});
