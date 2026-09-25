import { memo, useCallback, useState } from "react";
import type { ActiveTurnSnapshot } from "../../../types";
import type { ChatMsg } from "../../../stores/workbench";
import {
  IconAlert,
  IconArrowUpRight,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconDocument,
  IconProbe,
  IconShield,
  IconSparkle,
} from "../../../components/Icon";
import { buildTaskProgress, formatRunSummaryMarkdown } from "../../../utils/taskProgress";
import { formatStreamElapsedSeconds } from "../../../utils/streamElapsed";

type Props = {
  latestAssistant?: ChatMsg;
  snapshot?: ActiveTurnSnapshot;
  turnRunning: boolean;
  onShowTimeline: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

function statusLabel(status: string, toolCount: number): string {
  if (status === "running") return toolCount > 0 ? `已调用 ${toolCount} 个工具` : "实时处理中";
  if (status === "succeeded") return toolCount > 0 ? `${toolCount} 次工具调用已完成` : "纯模型分析，无外部调用";
  if (status === "failed") return "本轮需要排查";
  return "等待任务";
}

function EvidenceIcon({ title }: { title: string }) {
  if (/防火墙|策略|安全|network|device/i.test(title)) return <IconShield size={14} />;
  if (/流量|数据|分析|python/i.test(title)) return <IconBolt size={14} />;
  if (/健康|检查|诊断|probe/i.test(title)) return <IconProbe size={14} />;
  return <IconDocument size={14} />;
}

const GANTT_COLORS = [
  "var(--accent)", // 理解问题: 蓝色/主色
  "#8b5cf6",       // 收集证据: 紫色
  "#f59e0b",       // 分析判断: 琥珀黄
  "#10b981",       // 形成建议: 翡翠绿
];

export const TaskProgressPanel = memo(function TaskProgressPanel({
  latestAssistant,
  snapshot,
  turnRunning,
  onShowTimeline,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const model = buildTaskProgress(latestAssistant, snapshot, { turnRunning });
  const visibleEvidence = model.evidence.slice(0, 8);
  const [copiedRunId, setCopiedRunId] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const handleCopyRunId = useCallback(() => {
    if (!model.runId) return;
    navigator.clipboard.writeText(model.runId).then(() => {
      setCopiedRunId(true);
      setTimeout(() => setCopiedRunId(false), 2000);
    });
  }, [model.runId]);

  const handleCopySummary = useCallback(() => {
    const summary = formatRunSummaryMarkdown(model);
    navigator.clipboard.writeText(summary).then(() => {
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    });
  }, [model]);

  const handleLocateTool = useCallback((callOrToolId: string) => {
    // 跨面板双向联动：寻找主会话流中对应的工具卡片并高亮平滑滚动
    let target = document.getElementById(`tool-call-${callOrToolId}`) ||
      document.querySelector(`[data-call-id="${callOrToolId}"]`);

    if (!target) {
      const cards = document.querySelectorAll(".tool-call-card, .live-tool-chip");
      for (const card of Array.from(cards)) {
        if (card.textContent?.includes(callOrToolId)) {
          target = card as HTMLElement;
          break;
        }
      }
    }

    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("highlight-flash");
      setTimeout(() => {
        target?.classList.remove("highlight-flash");
      }, 2000);
    }
  }, []);

  // 实测耗时阶段过滤（仅对有实测有效秒数的阶段渲染 Mini Gantt，过滤 sub-second 0s 干扰）
  const measuredPhases = model.phases.filter(
    (p) => typeof p.durationMs === "number" && p.durationMs >= 1000,
  );
  const totalMeasuredMs = measuredPhases.reduce((acc, p) => acc + (p.durationMs || 0), 0);
  const showGantt = measuredPhases.length >= 2 && totalMeasuredMs > 0;

  if (collapsed) {
    return (
      <aside
        className="task-progress-panel is-collapsed"
        aria-label="任务进度（已收起）"
        data-testid="task-progress-panel"
      >
        <button
          className="task-progress-collapse"
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={false}
          aria-label="展开任务进度"
          title="展开任务进度"
          data-testid="btn-expand-task-progress"
        >
          <span className={"task-progress-summary " + model.status} aria-hidden="true">
            <span className="status-dot" />
          </span>
          <IconChevronLeft size={14} />
          <span>展开</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="task-progress-panel"
      aria-label="任务进度"
      data-testid="task-progress-panel"
    >
      {/* ── 头部状态与元数据胶囊 ──────────────────────── */}
      <header className="task-progress-header">
        <div className="task-progress-header-top">
          <div className="task-progress-header-title">
            <span className="task-progress-kicker">实时状态</span>
            <h2>任务进度</h2>
          </div>
          <button
            className="task-progress-collapse"
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={true}
            aria-label="收起任务进度"
            title="收起任务进度"
            data-testid="btn-collapse-task-progress"
          >
            <IconChevronRight size={14} />
            <span>收起</span>
          </button>
        </div>

        {/* 状态徽章条 */}
        <div className="task-status-banner">
          <span className={`task-status-badge ${model.status}`}>
            {model.status === "running" ? (
              <>
                <span className="pulse-radar" />
                <span>正在处理</span>
              </>
            ) : model.status === "succeeded" ? (
              <>
                <IconCheck size={13} weight="bold" />
                <span>执行完成</span>
              </>
            ) : model.status === "failed" ? (
              <>
                <IconAlert size={13} weight="bold" />
                <span>需检查</span>
              </>
            ) : (
              <span>等待任务</span>
            )}
          </span>
          <span className="task-status-desc">
            {statusLabel(model.status, model.evidence.length)}
          </span>
        </div>

        {/* 元数据胶囊组 */}
        <div className="task-rail-facts">
          {model.runId ? (
            <button
              type="button"
              className={`meta-pill meta-pill-run${copiedRunId ? " is-copied" : ""}`}
              onClick={handleCopyRunId}
              title={`点击复制完整 Run ID: ${model.runId}`}
            >
              {copiedRunId ? <IconCheck size={11} weight="bold" /> : <IconCopy size={11} />}
              <span className="meta-label">RUN</span>
              <span className="meta">{copiedRunId ? "已复制" : model.runId.slice(0, 8)}</span>
            </button>
          ) : null}

          {model.elapsedMs !== undefined ? (
            <span className="meta-pill" title={`本轮运行时长: ${formatStreamElapsedSeconds(model.elapsedMs)}`}>
              <IconClock size={11} />
              <span className="meta-label">耗时</span>
              <span className="meta">{formatStreamElapsedSeconds(model.elapsedMs)}</span>
            </span>
          ) : null}

          {model.toolCount > 0 ? (
            <span className="meta-pill" title={`共触发 ${model.toolCount} 次工具调用`}>
              <IconBolt size={11} />
              <span className="meta-label">工具</span>
              <span className="meta">{model.toolCount}</span>
            </span>
          ) : null}
        </div>
      </header>

      {/* ── 滚动内容主区 ─────────────────────────────── */}
      <div className="task-progress-body">
        {/* 运行态实时动态反馈横幅 */}
        {model.status === "running" && (
          <div className="task-in-flight-card" data-testid="task-in-flight">
            <div className="task-in-flight-header">
              <span className="in-flight-badge">
                <span className="spinner-mini" />
                <span>实时调度中</span>
              </span>
              <span className="in-flight-phase">
                阶段 {model.activeIndex + 1}/4 · {model.phases[model.activeIndex]?.title}
              </span>
            </div>
            {model.activeTool ? (
              <div className="task-in-flight-tool">
                <span className="in-flight-icon">
                  <EvidenceIcon title={model.activeTool.title} />
                </span>
                <div className="in-flight-info">
                  <strong>正在调用：{model.activeTool.title}</strong>
                  <span>来源：{model.activeTool.source}</span>
                  {model.activeTool.summary && <small>{model.activeTool.summary}</small>}
                </div>
              </div>
            ) : (
              <p className="task-in-flight-note">
                {model.phases[model.activeIndex]?.description || "模型正在依据当前事实推演下一步行动..."}
              </p>
            )}
            <div className="live-scan-track">
              <div className="live-scan-bar" />
            </div>
          </div>
        )}

        {/* 垂直时间轴 Stepper */}
        <div className="task-phase-list">
          {model.phases.map((phase, index) => {
            const isLast = index === model.phases.length - 1;
            const nextPhase = model.phases[index + 1];
            // 连线状态判定：当前完成且下一步已进入或完成时连线为完成色
            const spineDone = phase.state === "done" && (nextPhase?.state === "done" || nextPhase?.state === "active");
            const spineActive = phase.state === "active";

            return (
              <div
                className={`task-stepper-item ${phase.state}${isLast ? " is-last" : ""}`}
                key={phase.id}
              >
                {/* 垂直轴线 */}
                {!isLast && (
                  <div
                    className={`stepper-spine${spineDone ? " is-done" : spineActive ? " is-active" : ""}`}
                    aria-hidden="true"
                  />
                )}

                <details
                  className={`task-phase ${phase.state}`}
                  open={phase.state === "active"}
                >
                  <summary className="task-phase-summary">
                    <span className={`task-phase-index ${phase.state}`}>
                      {phase.state === "done" ? (
                        <IconCheck size={12} weight="bold" />
                      ) : phase.state === "failed" ? (
                        <IconAlert size={12} weight="bold" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <div className="task-phase-title-wrap">
                      <h3>{phase.title}</h3>
                      {phase.durationMs !== undefined && phase.durationMs >= 1000 ? (
                        <span
                          className="meta-duration"
                          title="该阶段已观测事件的时间跨度，不代表独占耗时"
                        >
                          {formatStreamElapsedSeconds(phase.durationMs)}
                        </span>
                      ) : null}
                    </div>
                    <span className={`task-phase-status-tag ${phase.state}`}>
                      {phase.state === "done"
                        ? "已完成"
                        : phase.state === "active"
                        ? "进行中"
                        : phase.state === "failed"
                        ? "需检查"
                        : "等待中"}
                    </span>
                    <IconChevronDown size={13} className="task-phase-caret" />
                  </summary>

                  <div className="task-phase-content">
                    <p>{phase.description}</p>
                    {phase.id === "evidence" && visibleEvidence.length > 0 ? (
                      <div className="task-evidence-list">
                        {visibleEvidence.map((item) => (
                          <article
                            className={`task-evidence ${item.status}`}
                            key={item.id}
                            onClick={() => handleLocateTool(item.id)}
                            role="button"
                            tabIndex={0}
                            title="点击定位到左侧对话流对应工具卡片"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleLocateTool(item.id);
                              }
                            }}
                          >
                            <span className="task-evidence-icon">
                              <EvidenceIcon title={item.title} />
                            </span>
                            <div className="task-evidence-meta">
                              <strong>{item.title}</strong>
                              <span>来源：{item.source}</span>
                              {item.summary ? <small>{item.summary}</small> : null}
                            </div>
                            <span
                              className="task-evidence-status"
                              aria-label={
                                item.status === "unknown"
                                  ? "结果未知"
                                  : item.status === "running"
                                  ? "进行中"
                                  : item.status === "done"
                                  ? "已完成"
                                  : "失败"
                              }
                            >
                              {item.status === "running" ? (
                                <span className="spinner-mini" />
                              ) : item.status === "done" ? (
                                <IconCheck size={13} weight="bold" />
                              ) : item.status === "unknown" ? (
                                "未知"
                              ) : (
                                "!"
                              )}
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        {/* Mini Gantt 阶段实测耗时占比条 */}
        {showGantt && (
          <div className="task-gantt-section" data-testid="task-gantt-section">
            <div className="task-section-header">
              <span className="task-section-title">
                <IconClock size={12} />
                <span>实测耗时占比</span>
              </span>
              <span className="task-section-meta">共 {formatStreamElapsedSeconds(totalMeasuredMs)}</span>
            </div>
            <div className="task-gantt-bar" role="img" aria-label="阶段耗时分布">
              {measuredPhases.map((phase) => {
                const phaseIdx = model.phases.findIndex((p) => p.id === phase.id);
                const percent = Math.max(8, Math.round(((phase.durationMs || 0) / totalMeasuredMs) * 100));
                const color = GANTT_COLORS[phaseIdx % GANTT_COLORS.length];
                return (
                  <div
                    key={phase.id}
                    className="task-gantt-segment"
                    style={{ width: `${percent}%`, backgroundColor: color }}
                    title={`${phase.title}: ${formatStreamElapsedSeconds(phase.durationMs || 0)} (${percent}%)`}
                  />
                );
              })}
            </div>
            <div className="task-gantt-legend">
              {measuredPhases.map((phase) => {
                const phaseIdx = model.phases.findIndex((p) => p.id === phase.id);
                const percent = Math.round(((phase.durationMs || 0) / totalMeasuredMs) * 100);
                const color = GANTT_COLORS[phaseIdx % GANTT_COLORS.length];
                return (
                  <div key={phase.id} className="gantt-legend-item">
                    <span className="legend-dot" style={{ backgroundColor: color }} />
                    <span className="legend-name">{phase.title}</span>
                    <span className="legend-val">{formatStreamElapsedSeconds(phase.durationMs || 0)} ({percent}%)</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 本轮执行成果与工具足迹（消灭空白，常驻可查） ──────────── */}
        <section className="task-footprint-section" data-testid="task-footprint-section">
          <div className="task-section-header">
            <span className="task-section-title">
              <IconBolt size={12} />
              <span>本轮调用足迹与证据</span>
              <span className="footprint-badge">{model.evidence.length}</span>
            </span>
            {model.evidence.length > 0 && (
              <span className="footprint-tip">点击定位卡片</span>
            )}
          </div>

          {model.evidence.length > 0 ? (
            <div className="task-footprint-grid">
              {model.evidence.map((item, idx) => (
                <div
                  key={item.id}
                  className={`task-footprint-card ${item.status}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleLocateTool(item.id)}
                  title="点击在左侧对话中高亮定位"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleLocateTool(item.id);
                    }
                  }}
                >
                  <div className="footprint-card-icon">
                    <EvidenceIcon title={item.title} />
                  </div>
                  <div className="footprint-card-main">
                    <div className="footprint-card-title-row">
                      <span className="footprint-card-seq">#{idx + 1}</span>
                      <strong>{item.title}</strong>
                      <span className="footprint-card-source">{item.source}</span>
                    </div>
                    {item.summary ? (
                      <p className="footprint-card-summary">{item.summary}</p>
                    ) : (
                      <span className="footprint-card-hint">已采集真实运行时指标</span>
                    )}
                  </div>
                  <div className="footprint-card-action">
                    <span className={`footprint-status-tag ${item.status}`}>
                      {item.status === "done"
                        ? "已完成"
                        : item.status === "running"
                        ? "运行中"
                        : item.status === "unknown"
                        ? "未知"
                        : "异常"}
                    </span>
                    <IconArrowUpRight size={13} className="footprint-jump-icon" />
                  </div>
                </div>
              ))}
            </div>
          ) : model.status === "succeeded" ? (
            <div className="task-footprint-empty">
              <span className="footprint-empty-icon">
                <IconSparkle size={18} />
              </span>
              <div className="footprint-empty-text">
                <strong>纯上下文推演完成</strong>
                <p>本轮任务由模型直接基于上下文知识与既有事实推导得出，未触发外部网络设备或沙箱调用。</p>
              </div>
            </div>
          ) : (
            <div className="task-footprint-empty is-waiting">
              <span className="footprint-empty-icon">
                <IconDocument size={16} />
              </span>
              <div className="footprint-empty-text">
                <span>暂无外部工具调用记录</span>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── 底部操作栏 ───────────────────────────────── */}
      <footer className="task-progress-footer">
        <div className="task-footer-actions">
          <button
            type="button"
            className={`task-action-btn${copiedSummary ? " is-copied" : ""}`}
            onClick={handleCopySummary}
            title="将本轮执行状态与工具调用记录复制为 Markdown 报告"
          >
            {copiedSummary ? <IconCheck size={12} weight="bold" /> : <IconCopy size={12} />}
            <span>{copiedSummary ? "已复制" : "复制摘要"}</span>
          </button>

          <button
            type="button"
            className="task-progress-timeline-btn"
            onClick={onShowTimeline}
            title="查看底层全部 Runtime Events 原始时序流"
          >
            <IconClock size={12} />
            <span>完整时间线</span>
          </button>
        </div>

        <div className="task-progress-audit-note">
          <IconShield size={12} />
          <span>工具调用均来自真实运行记录</span>
        </div>
      </footer>
    </aside>
  );
});
