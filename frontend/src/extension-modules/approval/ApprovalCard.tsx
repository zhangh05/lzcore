/**
 * 审批卡（approval 扩展的证据渲染器）。迁自旧 ApprovalActions 的交互，补齐：
 * - catch：网络中断进入「核对中」并回读 GET operation，不允许在未回读前再点
 * - 409 operation_invalidated：显示原因 + 重新加载最新版本
 * - 批准并执行：确认框列出设备、连接、命令
 * - 状态用中文显示，服务端状态优先
 */
import { useCallback, useEffect, useState } from "react";
import { api, bodyOf, describeFailure, enc } from "../../api/client";
import { Button } from "../../components/Button";
import { ConfirmDialog, ConflictPanel } from "../../kit/ui";
import { announceSessionContinuation, type SessionContinuation } from "../../contracts/workbench";

export interface ApprovalOperation {
  operation_id: string;
  status?: string;
  tool_id?: string;
  action?: string;
  commands?: string[];
  target?: { device?: { name?: string; device_id?: string; host?: string }; connection?: { connection_id?: string; name?: string } };
  digest?: string;
  invalidated_reason?: string;
  result?: { ok?: boolean; execution_may_continue?: boolean; error?: string } | null;
}

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: "待审批",
  approved: "已批准 · 待执行",
  rejected: "已拒绝",
  executing: "执行中",
  succeeded: "执行已返回",
  failed: "执行报错",
  invalidated: "已失效",
  expired: "已过期",
  unknown: "结果未知 · 需核对",
};

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "load_failed"; reason: string } | { kind: "submitting" } | { kind: "verifying" } | { kind: "invalidated"; reason: string };

export function ApprovalCard({ ws, operationId }: { ws: string; operationId: string }) {
  const [op, setOp] = useState<ApprovalOperation | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    const o = await api.get(`/api/extensions/approval/operations/${enc(operationId)}`, { workspace_id: ws });
    const b = bodyOf<{ operation?: ApprovalOperation }>(o);
    if (o.kind === "http" && o.status === 200 && b?.operation) { setOp(b.operation); setPhase({ kind: "ready" }); }
    else setPhase({ kind: "load_failed", reason: describeFailure(o) });
  }, [ws, operationId]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (decision: "approve" | "reject") => {
    setPhase({ kind: "submitting" });
    setNote(null);
    const o = await api.post(`/api/extensions/approval/operations/${enc(operationId)}/decision`, { decision }, { workspace_id: ws });
    if (o.kind === "network_error") {
      // 响应丢失：批准可能已同步执行。先回读，不允许再点。
      setPhase({ kind: "verifying" });
      setNote("响应丢失，批准可能已经执行。正在回读审批状态，回读完成前不能再次操作。");
      await load();
      return;
    }
    const b = bodyOf<{ operation?: ApprovalOperation; error?: string; continuation?: SessionContinuation & { status?: string } }>(o);
    if (o.status === 409) {
      if (b?.operation) setOp(b.operation);
      setPhase({ kind: "invalidated", reason: b?.operation?.invalidated_reason || b?.error || "审批已失效（operation_invalidated）" });
      return;
    }
    if (b?.operation) setOp(b.operation);
    if (o.status >= 400) setNote(describeFailure(o));
    else if (b?.continuation?.status === "resuming") {
      // 服务端在后台接着执行原任务：通知工作台去接上那一轮（只续传），而不是让用户以为已经结束。
      setNote("已批准。助手正在接着执行原任务，进度会出现在对话里。");
      const { session_id, client_request_id, job_id } = b.continuation;
      announceSessionContinuation({ session_id, client_request_id, job_id });
    }
    setPhase({ kind: "ready" });
  };

  if (phase.kind === "loading" && !op) return <div className="card approval-card" role="status">正在读取审批 {operationId}…</div>;
  if (phase.kind === "load_failed") return <div className="card approval-card" role="alert" data-testid="approval-load-failed">审批读取失败：{phase.reason} <Button onClick={() => void load()}>重新读取</Button></div>;
  const status = op?.status ?? "";
  const pending = status === "pending";
  const busy = phase.kind === "submitting" || phase.kind === "verifying" || phase.kind === "loading";
  return (
    <div className="card approval-card" data-testid="approval-card" data-status={status}>
      <div className="row-actions"><strong>需要审批</strong><span className="status-chip">{APPROVAL_STATUS_LABEL[status] ?? `状态：${status}`}</span></div>
      <dl className="kv">
        <div className="kv-row"><dt>设备</dt><dd>{op?.target?.device?.name ?? op?.target?.device?.device_id ?? "—"}</dd></div>
        <div className="kv-row"><dt>连接</dt><dd>{op?.target?.connection?.name ?? op?.target?.connection?.connection_id ?? "—"}</dd></div>
        <div className="kv-row"><dt>命令</dt><dd><pre className="json-block">{(op?.commands ?? []).join("\n") || "—"}</pre></dd></div>
      </dl>
      {phase.kind === "verifying" || note ? <p className="inline-alert tone-unknown" role="status" data-testid="approval-verifying">{phase.kind === "verifying" ? "核对中：" : ""}{note}</p> : null}
      {phase.kind === "invalidated" ? <ConflictPanel title="审批已失效" reason={phase.reason} onReload={() => void load()} /> : null}
      {pending && phase.kind !== "invalidated" ? (
        <div className="row-actions">
          <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)} data-testid="approval-approve">批准并执行</Button>
          <Button disabled={busy} onClick={() => void decide("reject")}>拒绝</Button>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog title="批准并执行？" confirmLabel="批准并执行" onCancel={() => setConfirming(false)}
          onConfirm={async () => { setConfirming(false); await decide("approve"); }}
          details={<>
            <p>批准后服务端会在同一请求里执行下列命令。</p>
            <ul data-testid="approval-confirm-list">
              <li>设备：{op?.target?.device?.name ?? op?.target?.device?.device_id ?? "未提供"}</li>
              <li>连接：{op?.target?.connection?.name ?? op?.target?.connection?.connection_id ?? "未提供"}</li>
              {(op?.commands ?? []).map((c) => <li key={c}>命令：<code>{c}</code></li>)}
            </ul>
          </>} />
      ) : null}
    </div>
  );
}
