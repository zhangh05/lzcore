import { useEffect, useMemo, useState } from "react";
import { api, enc } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { canOfferConfirmedJobRetry, jobOutcomeView, type JobFacts } from "../../contracts/outcomeState";
import { listOf, useApi } from "../../kit/useApi";
import SegmentedControl from "../../components/arc/segmented-control/segmented-control";
import { Chip, ConfirmDialog, FailureNote, JsonBlock, LoadState, ReceiptNote } from "../../kit/ui";

export interface JobRow extends JobFacts {
  job_id: string; title?: string; created_at?: string; started_at?: string; finished_at?: string;
  progress?: { percent?: number; message?: string; current_step?: string } | null;
  payload?: Record<string, unknown>; input?: Record<string, unknown>; workspace_id?: string;
}

const JOB_TYPE_ZH: Record<string, string> = { agent_run: "对话回合", workflow_run: "工作流", inspection: "巡检", report: "报告", knowledge_ingest: "知识入库" };
type Filter = "all" | "active" | "failed" | "done";
const FILTERS: { key: Filter; label: string }[] = [{ key: "all", label: "全部" }, { key: "active", label: "进行中" }, { key: "failed", label: "失败" }, { key: "done", label: "已结束" }];
const POLL_MS = 5000;

function jobTitle(j: JobRow): string {
  const t = (j.title ?? "").trim();
  const type = j.job_type ? (JOB_TYPE_ZH[j.job_type] ?? j.job_type) : "作业";
  return t && !t.startsWith("Workflow: ") ? t : t ? `${type} · ${t.slice("Workflow: ".length)}` : type;
}

function duration(a?: string, b?: string): string | null {
  const s = Date.parse(a ?? ""), e = b ? Date.parse(b) : Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const sec = Math.max(0, Math.round((e - s) / 1000));
  return sec >= 3600 ? `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分` : sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
}

function shortTime(v?: string): string {
  const d = new Date(v ?? "");
  if (Number.isNaN(d.getTime())) return "时间未上报";
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString("zh-CN", sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function inFilter(j: JobRow, f: Filter): boolean {
  const st = String(j.status ?? "");
  if (f === "active") return ACTIVE.has(st);
  if (f === "failed") return st === "failed" || st === "error";
  if (f === "done") return !ACTIVE.has(st);
  return true;
}

const ACTIVE = new Set(["queued", "running", "cancel_requested"]);

/** 状态点颜色：失败红，其余灰。队列走完不等于目标完成，所以不用绿色。 */
function statusTone(j: JobRow): "danger" | "neutral" {
  const st = String(j.status ?? "");
  return st === "failed" || st === "error" ? "danger" : "neutral";
}

const JOB_ERROR_ZH: Record<string, string> = {
  backend_restart_during_job: "执行期间服务重启了，这次没有跑完",
  cancelled_by_user: "已被手动取消",
  timeout: "执行超时",
  job_timeout: "执行超时",
  worker_lost: "执行进程意外退出",
};
/** 常见错误码换成人话；其余原样显示（不吞掉真实错误）。 */
export const jobErrorText = (e: string) => JOB_ERROR_ZH[e.trim()] ?? e;

/** 作业队列附列：只是队列态。取消、失败重试（确认框列出将重放的内容；未知态禁用）、删除（确认串）。 */
export function JobsColumn({ ws }: { ws: string }) {
  const [jobs, reload] = useApi("/api/jobs", { workspace_id: ws, limit: 50 });
  const [retry, setRetry] = useState<JobRow | null>(null);
  const [del, setDel] = useState<JobRow[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const done = (label: string) => (o: HttpOutcome) => { setResult({ label, o }); reload(); };
  const all = listOf<JobRow>(jobs, "jobs");
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => all.filter((j) => inFilter(j, filter)), [all, filter]);
  const hasActive = all.some((j) => ACTIVE.has(String(j.status)));
  // 有排队 / 运行中的作业时定期回读队列状态；全部结束后停止。
  useEffect(() => {
    if (!hasActive) return;
    const t = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [hasActive, reload]);
  return (
    <aside className={`jobs-column card ${sel.size ? "has-selection" : ""}`} aria-label="作业队列" data-testid="jobs-column">
      <h2>{hasActive ? <span className="live-dot is-live" aria-hidden="true" /> : null}后台队列{hasActive ? <span className="muted jobs-live">自动刷新中</span> : null}</h2>
      <p className="muted jobs-sub">排队和执行情况。任务是否真正做成，以左侧任务详情为准。</p>
      {result ? (result.o.kind === "http" && result.o.status < 300 ? <ReceiptNote text={`${result.label}已提交`} /> : <FailureNote outcome={result.o} />) : null}
      <SegmentedControl label="按状态筛选作业" className="job-filters" value={filter} onValueChange={(v) => setFilter(v as Filter)}
        options={FILTERS.map((f) => ({ value: f.key, label: f.label, accessory: f.key === "all" ? undefined : <span className="tab-count">{all.filter((j) => inFilter(j, f.key)).length}</span> }))} />
      {sel.size ? <div className="row-actions"><Button variant="danger" onClick={() => setDel(list.filter((j) => sel.has(j.job_id)))} data-testid="jobs-batch-delete">删除所选（{sel.size}）</Button></div> : null}
      <LoadState value={jobs} onReload={reload}>{() => list.length === 0 ? <p className="muted">{all.length ? "没有符合筛选的作业。" : "队列为空。"}</p> : (
        <ul className="job-list">
          {list.map((j) => {
            const v = jobOutcomeView(j);
            const retryable = canOfferConfirmedJobRetry(j);
            return (
              <li key={j.job_id} className={`job-item ${ACTIVE.has(String(j.status)) ? "is-active" : ""}`} data-job={j.job_id} data-goal={v.goal} title={`作业编号 ${j.job_id}`}>
                <div className="job-head">
                  <span className={`live-dot ${ACTIVE.has(String(j.status)) ? "is-live" : `tone-${statusTone(j)}`}`} aria-hidden="true" />
                  <input type="checkbox" checked={sel.has(j.job_id)} disabled={ACTIVE.has(String(j.status))} aria-label={`选择 ${j.job_id}`}
                    onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(j.job_id); else n.delete(j.job_id); setSel(n); }} />
                  <strong className="job-title" title={j.title}>{jobTitle(j)}</strong>
                </div>
                <div className="job-meta muted">
                  <span>{shortTime(j.created_at)}</span>
                  {j.started_at ? <span>{ACTIVE.has(String(j.status)) ? "已运行" : "用时"} {duration(j.started_at, j.finished_at)}</span> : null}
                </div>
                <div className="row-actions">
                  <Chip>{v.queueLabel}</Chip>
                  {v.goal !== "not_reported" ? <Chip tone={v.tone} testId="job-goal">{v.goalLabel}</Chip> : null}
                </div>
                {ACTIVE.has(String(j.status)) && (j.progress?.message || j.progress?.current_step || (j.progress?.percent ?? 0) > 0) ? (
                  <p className="job-progress muted">
                    {(j.progress?.percent ?? 0) > 0 ? <progress max={100} value={j.progress!.percent} aria-label="作业进度" /> : null}
                    {j.progress?.message || j.progress?.current_step}
                  </p>
                ) : null}
                {j.error && v.goal !== "unknown" ? <p className="job-error" title={j.error}>{jobErrorText(j.error)}</p> : null}
                {v.goal === "unknown" ? <p className="inline-alert tone-unknown" role="alert" data-testid="job-unknown">作业报错但执行可能仍在继续（结果未知 · 需核对）；不能直接重试。</p> : null}
                <div className="row-actions">
                  {ACTIVE.has(String(j.status)) && j.status !== "cancel_requested" ? <Button onClick={async () => done("取消请求")(await api.post(`/api/jobs/${enc(j.job_id)}/cancel`, { workspace_id: ws }))}>请求取消</Button> : null}
                  {j.status === "failed" || j.status === "error" ? (
                    <Button onClick={() => setRetry(j)} disabled={!retryable} title={retryable ? undefined : "结果未知，先核对"} data-testid="job-retry">重试作业（需确认）</Button>
                  ) : null}
                  {!ACTIVE.has(String(j.status)) ? <Button variant="ghost" onClick={() => setDel([j])} data-testid="job-delete">删除</Button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}</LoadState>
      {retry ? (
        <ConfirmDialog title="确认重试作业" confirmLabel="重新入队" testId="job-retry-dialog" onCancel={() => setRetry(null)}
          details={<>
            <p>将把作业 <code>{retry.job_id}</code>（{retry.job_type ?? "类型未上报"}）整体重新入队一次。以下内容会被重放：</p>
            <JsonBlock value={retry.payload ?? retry.input ?? { note: "服务端未返回作业输入" }} />
            <p className="muted">若作业中含外部写入，重放可能再次写入。</p>
          </>}
          onConfirm={async () => { const j = retry; setRetry(null); done("重试请求")(await api.post(`/api/jobs/${enc(j.job_id)}/retry`, { workspace_id: ws })); }} />
      ) : null}
      {del ? (() => {
        const ids = del.map((j) => j.job_id).sort();
        const single = ids.length === 1;
        const confirmation = single ? `DELETE ${ids[0]}` : `DELETE JOBS ${ids.join(",")}`;
        return (
          <ConfirmDialog title={single ? "删除作业" : `删除 ${ids.length} 个作业`} confirmText={confirmation} confirmLabel="删除" testId="job-delete-dialog" onCancel={() => setDel(null)}
            details={<p>将删除：{ids.map((i) => <code key={i}>{i} </code>)}。运行中的作业不能删除。</p>}
            onConfirm={async () => {
              setDel(null); setSel(new Set());
              const o = single
                ? await api.del(`/api/jobs/${enc(ids[0])}`, { workspace_id: ws, confirmation })
                : await api.del("/api/jobs/batch-delete", { workspace_id: ws, job_ids: ids, confirmation });
              done("删除请求")(o);
            }} />
        );
      })() : null}
    </aside>
  );
}
