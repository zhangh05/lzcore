import { useCallback, useEffect, useState } from "react";
import { api, bodyOf, describeFailure, enc } from "../api/client";
import { withWorkspace } from "../app/shellContext";
import { Button } from "../components/Button";
import type { LedgerOperation, ReviewItem } from "../contracts/reviewRecords";
import {
  advanceUnknownFlow, canSubmitMark, expectedConfirmation, initialUnknownFlow, UNKNOWN_FLOW_STEP_LABEL,
  type Resolution, type UnknownFlowEvent, type UnknownFlowState, type UnknownTarget,
} from "../contracts/unknownFlow";
import { JsonBlock, KeyValues } from "../kit/ui";
import { Link } from "../router";

/** 从深链参数构造核对目标。 */
export function targetFromParams(params: URLSearchParams, ws: string): UnknownTarget | null {
  const source = params.get("source");
  const id = params.get("id");
  if (!source || !id) return null;
  const taskId = params.get("task") ?? undefined;
  if (source === "ledger") return { kind: "ledger", operationId: id, workspaceId: ws, taskId };
  if (source === "review_item") return { kind: "review_item", itemId: id, artifactId: params.get("artifact") ?? "", workspaceId: ws, taskId };
  if (source === "task") return { kind: "task", taskId: id, workspaceId: ws };
  return null;
}

type Readback = { result: "still_unknown" | "reconciled"; record: unknown } | { error: string };

const LEDGER_RESOLVED = new Set(["succeeded", "failed", "reconciled"]);

async function readBack(target: UnknownTarget, sessionId: string | null): Promise<Readback> {
  const ws = target.workspaceId;
  if (target.kind === "ledger") {
    const o = await api.get("/api/admin/operation-ledger", { workspace_id: ws, limit: 500 });
    if (o.kind === "http" && o.status === 403) return { error: "写操作账本只有管理员能读取和标记。请让管理员打开这个核对链接完成标记，之后你再回读。" };
    const ops = bodyOf<{ operations?: LedgerOperation[] }>(o)?.operations;
    if (o.kind !== "http" || o.status !== 200 || !ops) return { error: describeFailure(o) };
    const op = ops.find((x) => x.operation_id === target.operationId);
    if (!op) return { error: "账本里找不到这条记录（可能已被清理）。" };
    return { result: LEDGER_RESOLVED.has(op.status) ? "reconciled" : "still_unknown", record: op };
  }
  if (target.kind === "review_item") {
    const o = await api.get(`/api/workspaces/${enc(ws)}/review-items`);
    const items = bodyOf<{ items?: ReviewItem[] }>(o)?.items;
    if (o.kind !== "http" || o.status !== 200 || !items) return { error: describeFailure(o) };
    const it = items.find((x) => x.item_id === target.itemId);
    if (!it) return { error: "找不到这条审阅项。" };
    return { result: (it.status ?? "pending") === "pending" ? "still_unknown" : "reconciled", record: it };
  }
  if (!sessionId) return { error: "深链缺少会话参数，无法读取该任务的 task-state。" };
  const o = await api.get(`/api/runtime/sessions/${enc(sessionId)}/task-state`, { workspace_id: ws });
  const task = bodyOf<{ task_state?: { task?: { task_id?: string; unknowns?: unknown[] } } }>(o)?.task_state?.task;
  if (o.kind !== "http" || o.status !== 200) return { error: describeFailure(o) };
  // 会话当前任务已换成别的任务：不能拿它的状态当作深链里那个任务的核对结果。
  if (task?.task_id && task.task_id !== target.taskId) return { error: `这个会话当前的任务是 ${task.task_id}，不是要核对的 ${target.taskId}（可能已开始新任务）。` };
  return { result: (task?.unknowns?.length ?? 0) > 0 ? "still_unknown" : "reconciled", record: task ?? null };
}

/** 核对详情面板：回读 → 标记（依据 + RESOLVE <id>）→ 回读确认 → 续接（去工作台，由用户点续接）。没有重试。 */
export function ReviewDetail({ target, sessionId }: { target: UnknownTarget; sessionId: string | null }) {
  const [flow, setFlow] = useState<UnknownFlowState>(() => initialUnknownFlow(target));
  const [record, setRecord] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const step = (e: UnknownFlowEvent) => setFlow((s) => advanceUnknownFlow(s, e));

  const verify = useCallback(async (from: UnknownFlowState) => {
    setError(null);
    setFlow(advanceUnknownFlow(from, { type: "start_verify" }));
    const r = await readBack(target, sessionId);
    if ("error" in r) { setError(`回读失败：${r.error}`); setFlow(initialUnknownFlow(target)); return; }
    setRecord(r.record);
    setFlow((s) => advanceUnknownFlow(s, { type: "readback", result: r.result }));
  }, [target, sessionId]);

  useEffect(() => { setFlow(initialUnknownFlow(target)); setRecord(null); }, [target]);

  const submit = async () => {
    if (flow.step !== "marking" || !canSubmitMark(flow)) return;
    const resolution = flow.resolution as Resolution;
    const reason = flow.reason.trim();
    step({ type: "submit_mark" });
    let o;
    if (target.kind === "ledger") {
      o = await api.post(`/api/admin/operation-ledger/${enc(target.operationId)}/resolve`, { workspace_id: target.workspaceId, confirmation: expectedConfirmation(target), status: resolution, reason });
    } else if (target.kind === "review_item") {
      o = await api.put(`/api/review-items/${enc(target.itemId)}`, { status: resolution === "succeeded" ? "accepted" : "modified", user_note: reason }, { workspace_id: target.workspaceId, artifact_id: target.artifactId });
    } else {
      setError("任务级未知项没有单独的标记接口：请到写操作账本逐条标记后，再回到这里回读。");
      setFlow((s) => advanceUnknownFlow(s, { type: "mark_readback", confirmed: false }));
      return;
    }
    if (o.kind !== "http" || o.status >= 300) setError(`标记请求未被受理：${describeFailure(o)}`);
    const r = await readBack(target, sessionId);
    const confirmed = !("error" in r) && r.result === "reconciled";
    if (!("error" in r)) setRecord(r.record);
    if (!confirmed) setError((e) => e ?? "回读后仍是未知，标记未生效。");
    setFlow((s) => advanceUnknownFlow(s, { type: "mark_readback", confirmed }));
  };

  const resumeTaskId = target.taskId;
  return (
    <section className="card review-detail" data-testid="review-detail" data-step={flow.step} aria-label="核对详情">
      <h2>核对：{target.kind === "ledger" ? `写操作 ${target.operationId}` : target.kind === "review_item" ? `审阅项 ${target.itemId}` : `任务 ${target.taskId}`}</h2>
      <p className="status-chip" data-testid="flow-step">{UNKNOWN_FLOW_STEP_LABEL[flow.step]}</p>
      {error ? <p className="inline-alert tone-warn" role="alert" data-testid="review-error">{error}</p> : null}
      {flow.step === "needs_verification" || flow.step === "verified_still_unknown" ? (
        <Button onClick={() => void verify(flow)} data-testid="readback-btn">{flow.step === "needs_verification" ? "回读最新状态" : "再次回读"}</Button>
      ) : null}
      {flow.step === "verifying" ? <p role="status">回读中…</p> : null}
      {record ? <details open><summary>服务端记录</summary><JsonBlock value={record} /></details> : null}
      {flow.step === "verified_still_unknown" ? (
        target.kind === "task"
          ? <TaskUnknowns record={record} ws={target.workspaceId} taskId={target.taskId} sessionId={sessionId} />
          : <Button variant="primary" onClick={() => step({ type: "begin_mark" })} data-testid="begin-mark">人工标记结果</Button>
      ) : null}
      {flow.step === "marking" ? (
        <form className="mark-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <fieldset>
            <legend>实际结果</legend>
            <label><input type="radio" name="res" checked={flow.resolution === "succeeded"} onChange={() => step({ type: "edit_mark", resolution: "succeeded" })} /> 已确认写入生效</label>
            <label><input type="radio" name="res" checked={flow.resolution === "failed"} onChange={() => step({ type: "edit_mark", resolution: "failed" })} /> 已确认未生效</label>
          </fieldset>
          <label className="field"><span>依据（必填）</span><textarea value={flow.reason} onChange={(e) => step({ type: "edit_mark", reason: e.target.value })} data-testid="mark-reason" /></label>
          <label className="field"><span>输入 <code>{expectedConfirmation(target)}</code> 以确认</span><input value={flow.confirmation} onChange={(e) => step({ type: "edit_mark", confirmation: e.target.value })} data-testid="mark-confirm" autoComplete="off" /></label>
          <Button type="submit" variant="danger" disabled={!canSubmitMark(flow)} data-testid="submit-mark">提交标记</Button>
        </form>
      ) : null}
      {flow.step === "mark_submitted" ? <p role="status">标记已提交 · 等待回读确认…</p> : null}
      {flow.step === "marked" ? (
        <div className="inline-alert tone-info" role="status" data-testid="marked">
          <KeyValues items={[["标记", flow.resolution === "succeeded" ? "已确认写入生效" : "已确认未生效"], ["依据", flow.reason]]} />
          {resumeTaskId && sessionId ? (
            <Link className="btn" to={withWorkspace(`/workbench?session=${enc(sessionId)}&resume_task=${enc(resumeTaskId)}`, target.workspaceId)} data-testid="go-resume">去工作台续接</Link>
          ) : <p className="muted">没有关联任务，无需续接。</p>}
        </div>
      ) : null}
    </section>
  );
}

interface TaskUnknownFact { kind?: string; reason?: string; operation_id?: string; call_id?: string; tool_id?: string; error_code?: string }

/** 任务级未知项：逐条给出能定位的写操作（账本 operation_id）；定位不到的如实说明。 */
export function TaskUnknowns({ record, ws, taskId, sessionId }: { record: unknown; ws: string; taskId: string; sessionId: string | null }) {
  const unknowns = ((record as { unknowns?: TaskUnknownFact[] } | null)?.unknowns ?? []).filter((u) => u && typeof u === "object");
  if (!unknowns.length) return <p className="muted">任务级未知项需逐条核对对应的写操作。</p>;
  return (
    <div data-testid="task-unknowns">
      <p className="muted">这个任务有 {unknowns.length} 项结果未知，需逐条核对对应的写操作；全部标记后回到这里回读。</p>
      <ul className="nav-list">{unknowns.map((u, i) => (
        <li key={u.operation_id ?? u.call_id ?? i}>
          <span>{u.tool_id ? <code>{u.tool_id}</code> : null} {u.reason ?? u.error_code ?? u.kind ?? "结果未知"}</span>{" "}
          {u.operation_id
            ? <Link className="btn ghost sm" to={withWorkspace(`/review?source=ledger&id=${enc(u.operation_id)}&task=${enc(taskId)}${sessionId ? `&session=${enc(sessionId)}` : ""}`, ws)} data-testid="task-unknown-verify">核对写操作 {u.operation_id}</Link>
            : <span className="muted" data-testid="task-unknown-unlocatable">没有可定位的写操作编号{u.call_id ? `（调用 ${u.call_id}）` : ""}，请在写操作账本中按时间和工具查找。</span>}
        </li>
      ))}</ul>
    </div>
  );
}
