import type { CSSProperties, ReactNode } from "react";
import { MetricCard } from "../../components/arc/metric-card/metric-card";
import { IconCheckCircle, IconClock, IconInfo, IconWarningCircle, IconXCircle } from "../../components/Icon";
import { Chip, fmtTime } from "../../kit/ui";
import { outcomePlain } from "../workbench/ProgressPanel";

export type RunRow = Record<string, string>;

/** 去掉 Markdown 记号，压成一行。 */
export const plainText = (v?: string) => (v ?? "").replace(/[#*`|>_~]{1,}/g, " ").replace(/(^|\s)-{1,}(\s|$)/g, " ").replace(/\s+/g, " ").trim();

/** 一句话标题 + 余下内容：在第一个句读处断开，标题不超过 48 字。 */
export function splitHeadline(text: string): [string, string] {
  const t = plainText(text);
  const m = t.slice(0, 64).match(/^(.{6,48}?)[。！？；：:](.*)$/);
  if (m) return [m[1], (m[2] + t.slice(64)).trim()];
  return t.length > 48 ? [`${t.slice(0, 46)}…`, t.slice(46)] : [t, ""];
}

/** 「刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:20 / 11月12日 09:41」。 */
export function relativeTime(v?: string, now = Date.now()): string {
  const d = new Date(v ?? "");
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "时间未上报";
  const sec = Math.round((now - ms) / 1000);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sec < 45) return "刚刚";
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `${Math.round(sec / 3600)} 小时前`;
  if (ms >= today.getTime() - 86_400_000) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 分组标题：今天 / 昨天 / 11月12日 星期三。 */
export function dayLabel(v?: string, now = Date.now()): string {
  const d = new Date(v ?? "");
  if (!Number.isFinite(d.getTime())) return "更早";
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const week = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

const TONE_ICON: Record<string, ReactNode> = {
  ok: <IconCheckCircle size={18} aria-hidden="true" />,
  warn: <IconWarningCircle size={18} aria-hidden="true" />,
  danger: <IconXCircle size={18} aria-hidden="true" />,
  info: <IconInfo size={18} aria-hidden="true" />,
  neutral: <IconClock size={18} aria-hidden="true" />,
};

const runText = (r: RunRow) => r.title ?? r.goal ?? r.final_response_summary ?? r.intent ?? "";

/** 运行记录：按天分组的卡片行。整行可点开详情；结果用图标 + 标签双重表达。 */
export function RunList({ rows, onOpen, testId }: { rows: RunRow[]; onOpen: (id: string) => void; testId?: string }) {
  const groups: { label: string; items: RunRow[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.created_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(r); else groups.push({ label, items: [r] });
  }
  let index = 0;
  return (
    <div className="run-groups" data-testid={testId}>
      {groups.map((g) => (
        <section key={g.label} className="run-group" aria-label={g.label}>
          <h3 className="run-day"><span>{g.label}</span><span className="run-day-count">{g.items.length}</span></h3>
          <ul className="run-list">
            {g.items.map((r) => {
              const o = outcomePlain(r.execution_outcome);
              const tone = o?.tone ?? "neutral";
              const [head, rest] = splitHeadline(runText(r));
              return (
                <li key={r.run_id} style={{ "--i": index++ } as CSSProperties}>
                  <button type="button" className={`run-row tone-${tone}`} data-row={r.run_id} onClick={() => onOpen(r.run_id)} title={`运行编号 ${r.run_id}`}>
                    <span className="run-icon">{TONE_ICON[tone]}</span>
                    <span className="run-body">
                      <strong className="run-title">{head || "（没有摘要）"}</strong>
                      {rest ? <span className="run-sub">{rest}</span> : null}
                    </span>
                    <span className="run-side">
                      <Chip tone={tone}>{o?.label ?? r.status ?? "未上报"}</Chip>
                      <time dateTime={r.created_at} title={fmtTime(r.created_at)}>{relativeTime(r.created_at)}</time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 任务页顶部概览：数字随数据变化滚动。 */
export function TasksOverview({ runs, active, failedJobs }: { runs: RunRow[]; active: number; failedJobs: number }) {
  const today = dayLabel(new Date().toISOString());
  const todayRuns = runs.filter((r) => dayLabel(r.created_at) === today);
  const done = runs.filter((r) => r.execution_outcome === "complete").length;
  const attention = runs.filter((r) => ["failed", "partial", "blocked", "unknown"].includes(r.execution_outcome ?? "")).length + failedJobs;
  const rate = runs.length ? Math.round((done / runs.length) * 100) : 0;
  return (
    <div className="tasks-overview" data-testid="tasks-overview">
      <MetricCard label="进行中" value={active} context={active ? "后台正在执行" : "当前没有在跑的任务"} />
      <MetricCard label="今天的运行" value={todayRuns.length} context={`累计 ${runs.length} 次`} />
      <MetricCard label="完成率" value={rate} suffix="%" context={`${done} 次已完成`} />
      <MetricCard label="需要关注" value={attention} context={attention ? "未完成、待确认或失败" : "一切正常"} />
    </div>
  );
}
