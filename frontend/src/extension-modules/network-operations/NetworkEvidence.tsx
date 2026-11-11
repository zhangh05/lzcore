/**
 * 网络扩展的领域证据（设备读取 / 配置 / 连接验证、巡检任务）。
 * 迁自 extensions/network_operations/frontend/components/{networkEvidence.ts, NetworkToolResult.tsx}：
 * - 工具信封 ok=true 不代表证据完整：connection_ok=false → 不可达；read_ok=false / partial → 证据不完整；
 *   execution_may_continue / unknown → 写入结果未知（只核对，不重放）。
 * - 配置动作只说明命令处理情况，业务是否达成以独立写后读取为准。
 */
import { useState } from "react";
import { api, describeFailure, enc } from "../../api/client";

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(object) : []);
const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export type EvidenceOutcome = "ok" | "fail" | "unknown" | "partial" | "unavailable" | "pending";
export const NETWORK_EVIDENCE_TOOLS = ["network.operations.device.manage", "network.operations.inspection"];

export function networkEvidence(tool: string, value: unknown) {
  if (!NETWORK_EVIDENCE_TOOLS.includes(tool)) return null;
  const root = object(value);
  if (!Object.keys(root).length) return null;
  const supplied = object(root.presentation);
  const inspection = tool === "network.operations.inspection";
  const task = object(root.task);
  // list/cancel 只确认操作，没有任务生命周期：交给普通工具卡。
  if (inspection && !text(supplied.task_id || task.task_id)) return null;
  const state = text(supplied.state) || text(inspection ? task.status : root.status);
  const pending = ["queued", "running", "pending"].includes(state);
  const outcome: EvidenceOutcome =
    state === "unknown" || root.execution_may_continue === true ? "unknown"
      : state === "unavailable" || root.connection_ok === false ? "unavailable"
        : state === "partial" || root.read_ok === false ? "partial"
          : pending ? "pending"
            : ["ok", "succeeded"].includes(state) || (root.ok === true && !inspection && state !== "failed") ? "ok"
              : "fail";
  const action = text(supplied.action || root.executed_action || root.requested_action) || (root.configuration_workflow ? "configure" : "read");
  const label = ["cancelled", "canceled"].includes(state) ? "巡检已取消"
    : outcome === "unknown" ? "写入结果未知"
      : outcome === "unavailable" ? "设备不可达"
        : outcome === "partial" ? "证据不完整"
          : outcome === "pending" ? "巡检进行中"
            : outcome === "fail" ? "本次执行未完成"
              : inspection ? "采集完成"
                : action === "configure" ? "命令已处理，待业务核验"
                  : action === "probe" ? "连接验证成功" : "读取完成";
  return {
    root, data: supplied, inspection, outcome, action, label,
    target: object(supplied.target || root.target || root.connection),
    commands: rows(root.command_results || supplied.command_results),
    devices: rows(supplied.devices || object(root.analysis_projection).devices),
    stages: rows(supplied.stages || root.stages),
    diagnostic: object(supplied.diagnostic || root.diagnostic),
    observedAt: text(supplied.observed_at || root.observed_at),
    artifactId: text(supplied.artifact_id || task.artifact_id),
    taskId: text(supplied.task_id || task.task_id),
  };
}

const STAGE: Record<string, string> = { target: "目标", tcp: "TCP", host_key: "主机指纹", auth: "认证", prompt: "终端", connection: "连接" };
const STATUS: Record<string, string> = {
  succeeded: "采集完成", partial: "证据不完整", failed: "未完成", pending: "待采集", not_collected: "未采集", cancelled: "已取消",
  sent: "已发送", uncertain: "发送结果未知", not_sent: "未发送", ok: "通过", blocked: "待处理",
};
const TONE: Record<EvidenceOutcome, string> = { ok: "ok", fail: "danger", unknown: "unknown", partial: "warn", unavailable: "danger", pending: "info" };

/** 证据 key：工具 id + 调用 id，供注册表按调用定位原始结果。 */
export function matchNetworkEvidence(call: { tool_id: string; call_id?: string; result?: Obj }): string | null {
  return networkEvidence(call.tool_id, call.result) ? `${call.tool_id}#${call.call_id ?? ""}` : null;
}

export function NetworkEvidence({ ws, toolId, result }: { ws: string; toolId: string; result: unknown }) {
  const view = networkEvidence(toolId, result);
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [full, setFull] = useState<{ state: "idle" | "loading" | "ok" | "error"; content?: string; error?: string }>({ state: "idle" });
  if (!view) return null;
  const loadArtifact = async () => {
    setFull({ state: "loading" });
    const o = await api.get(`/api/workspaces/${enc(ws)}/artifacts/${enc(view.artifactId)}/content`);
    if (o.kind === "http" && o.status < 300) {
      const b = o.body as { content?: unknown } | string | null;
      const content = typeof b === "string" ? b : typeof b?.content === "string" ? b.content : JSON.stringify(b, null, 2);
      setFull({ state: "ok", content });
    } else setFull({ state: "error", error: `证据原件暂不可用：${describeFailure(o)}` });
  };
  const verb = view.action === "configure" ? "配置" : view.action === "probe" ? "连接验证" : "读取";
  const devices = view.devices.filter((d) => !exceptionsOnly || d.status !== "succeeded");
  return (
    <section className="network-evidence" aria-label={view.inspection ? "巡检执行证据" : "设备执行证据"} data-testid="network-evidence" data-outcome={view.outcome}>
      <header className="network-evidence-head">
        <strong>{view.inspection ? `巡检 ${view.taskId}` : `${text(view.target.name) || text(view.target.connection_id) || "设备"} · ${verb}`}</strong>
        <span className={`status-chip tone-${TONE[view.outcome]}`} data-testid="network-evidence-label">{view.label}</span>
      </header>
      {view.observedAt ? <p className="muted">观察时间：<time dateTime={view.observedAt}>{view.observedAt}</time></p> : null}
      {view.target.connection_id ? (
        <p className="muted">{[text(view.target.host), text(view.target.protocol).toUpperCase(), text(view.target.connection_id)].filter(Boolean).join(" · ")}</p>
      ) : null}
      {view.diagnostic.summary ? <p>{text(view.diagnostic.summary)}</p> : null}
      {view.diagnostic.next_step ? <p className="muted">下一步：{text(view.diagnostic.next_step)}</p> : null}
      {view.action === "configure" ? <p className="inline-alert tone-info">本次结果描述命令处理情况。业务是否达到目标，以独立写后读取和任务核验为准。</p> : null}
      {view.stages.length ? (
        <div className="network-evidence-stages">
          {view.stages.map((s, i) => <span key={i}>{STAGE[text(s.name)] || text(s.name)}：{STATUS[text(s.status)] || text(s.status)}</span>)}
        </div>
      ) : null}
      {view.inspection ? (
        <>
          <button type="button" className="btn ghost sm" aria-pressed={exceptionsOnly} onClick={() => setExceptionsOnly(!exceptionsOnly)}>
            {exceptionsOnly ? "显示全部设备" : "仅显示需处理设备"}
          </button>
          <ul className="network-evidence-devices">
            {devices.map((d, i) => (
              <li key={text(d.connection_id) || i}>
                <strong>{text(d.name)}</strong> · {STATUS[text(d.status)] || text(d.status)} <code>{text(d.connection_id)}</code>
                {d.error ? <p>{text(object(d.diagnostic).summary) || text(d.error)}</p> : null}
                {object(d.diagnostic).next_step ? <p className="muted">{text(object(d.diagnostic).next_step)}</p> : null}
              </li>
            ))}
          </ul>
          <p className="muted">采集完成表示命令取得完整回显；协议健康与业务连通性需要相应证据。</p>
        </>
      ) : null}
      {view.commands.length ? (
        <ol className="network-commands">
          {view.commands.map((c, i) => {
            const complete = !!c.complete && !c.error_code && !c.truncated;
            return (
              <li key={i} data-complete={complete}>
                <code>{text(c.command)}</code>
                <span className={`status-chip tone-${complete ? "ok" : "warn"}`}>{STATUS[text(c.dispatch_status)] || "发送状态未记录"} · {complete ? "回显完整" : "需核对回显"}</span>
                {c.error_code ? <p className="muted">{text(c.error_code)} {text(c.device_error)}</p> : null}
                {typeof c.output === "string" ? (
                  <details><summary>原始回显</summary><pre className="json-block">{c.output}</pre></details>
                ) : <p className="muted">本次实时记录只提供执行索引；读取完整证据后可查看回显。</p>}
              </li>
            );
          })}
        </ol>
      ) : null}
      {view.artifactId ? (
        <div className="network-evidence-artifact">
          <code>{view.artifactId}</code>
          <button type="button" className="btn sm" disabled={full.state === "loading"} onClick={() => void loadArtifact()}>
            {full.state === "loading" ? "读取中…" : "读取完整证据"}
          </button>
          {full.state === "error" ? <p className="inline-alert tone-warn" role="alert">{full.error}</p> : null}
          {full.state === "ok" ? <details open><summary>完整证据</summary><pre className="json-block">{full.content}</pre></details> : null}
        </div>
      ) : null}
    </section>
  );
}
