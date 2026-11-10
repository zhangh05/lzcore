import { useState } from "react";
import { api, enc } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { canOfferConfirmedJobRetry, jobOutcomeView, type JobFacts } from "../../contracts/outcomeState";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, ConfirmDialog, FailureNote, JsonBlock, LoadState, ReceiptNote } from "../../kit/ui";

export interface JobRow extends JobFacts { job_id: string; created_at?: string; payload?: Record<string, unknown>; input?: Record<string, unknown>; workspace_id?: string }

const ACTIVE = new Set(["queued", "running", "cancel_requested"]);

/** 作业队列附列：只是队列态。取消、失败重试（确认框列出将重放的内容；未知态禁用）、删除（确认串）。 */
export function JobsColumn({ ws }: { ws: string }) {
  const [jobs, reload] = useApi("/api/jobs", { workspace_id: ws, limit: 50 });
  const [retry, setRetry] = useState<JobRow | null>(null);
  const [del, setDel] = useState<JobRow[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const done = (label: string) => (o: HttpOutcome) => { setResult({ label, o }); reload(); };
  const list = listOf<JobRow>(jobs, "jobs");
  return (
    <aside className="jobs-column card" aria-label="作业队列" data-testid="jobs-column">
      <h2>作业队列 <span className="muted">（仅队列态，不代表任务结论）</span></h2>
      {result ? (result.o.kind === "http" && result.o.status < 300 ? <ReceiptNote text={`${result.label}已提交`} /> : <FailureNote outcome={result.o} />) : null}
      {sel.size ? <div className="row-actions"><Button variant="danger" onClick={() => setDel(list.filter((j) => sel.has(j.job_id)))} data-testid="jobs-batch-delete">删除所选（{sel.size}）</Button></div> : null}
      <LoadState value={jobs} onReload={reload}>{() => list.length === 0 ? <p className="muted">队列为空。</p> : (
        <ul className="job-list">
          {list.map((j) => {
            const v = jobOutcomeView(j);
            const retryable = canOfferConfirmedJobRetry(j);
            return (
              <li key={j.job_id} className="job-item" data-job={j.job_id} data-goal={v.goal}>
                <label><input type="checkbox" checked={sel.has(j.job_id)} disabled={ACTIVE.has(String(j.status))} aria-label={`选择 ${j.job_id}`}
                  onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(j.job_id); else n.delete(j.job_id); setSel(n); }} /> <code>{j.job_id}</code></label>
                <div className="row-actions">
                  <Chip>{v.queueLabel}</Chip>
                  <Chip tone={v.tone} testId="job-goal">{v.goalLabel}</Chip>
                </div>
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
