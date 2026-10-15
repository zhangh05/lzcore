import { useEffect, useRef, useState } from "react";
import { artifactsApi } from "../../../../frontend/src/api";
import { useSessionStore } from "../../../../frontend/src/stores/session";
import { networkEvidence, object, rows, text } from "./networkEvidence";
import "./NetworkEvidence.css";

const stageNames: Record<string, string> = {
  target: "目标",
  tcp: "TCP",
  host_key: "主机指纹",
  auth: "认证",
  prompt: "终端",
  connection: "连接",
};
const statuses: Record<string, string> = {
  succeeded: "采集完成",
  partial: "证据不完整",
  failed: "未完成",
  pending: "待采集",
  not_collected: "未采集",
  cancelled: "已取消",
  sent: "已发送",
  uncertain: "发送结果未知",
  not_sent: "未发送",
  ok: "通过",
  blocked: "待处理",
};
export function NetworkToolResult({
  toolId,
  result,
  reconciled = false,
}: {
  toolId: string;
  result: unknown;
  reconciled?: boolean;
}) {
  const evidence = networkEvidence(toolId, result);
  const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort();
    setContent(null);
    setError("");
    setLoading(false);
    return () => pending.current?.abort();
  }, [workspaceId, evidence?.artifactId]);
  if (!evidence) return null;
  const view = evidence;
  const loadArtifact = async () => {
    if (!workspaceId || !view.artifactId) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await artifactsApi.content(
        workspaceId,
        view.artifactId,
        controller.signal,
      );
      if (!controller.signal.aborted) setContent(response.content);
    } catch {
      if (!controller.signal.aborted)
        setError("证据原件暂不可用，请重试读取。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return (
    <section
      className="network-evidence"
      aria-label={view.inspection ? "巡检执行证据" : "设备执行证据"}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="network-evidence-heading">
        <strong>
          {view.inspection
            ? `巡检 ${view.taskId}`
            : `${text(view.target.name) || text(view.target.connection_id)} · ${view.action === "configure" ? "配置" : view.action === "probe" ? "连接验证" : "读取"}`}
        </strong>
        <span>{reconciled ? "该次结果已在后续核对" : view.label}</span>
      </div>
      {view.observedAt && (
        <p>
          观察时间：<time dateTime={view.observedAt}>{view.observedAt}</time>
        </p>
      )}
      {view.target.connection_id ? (
        <p>
          {text(view.target.host)} · {text(view.target.protocol).toUpperCase()}{" "}
          · {text(view.target.connection_id)}
        </p>
      ) : null}
      {view.diagnostic.summary ? <p>{text(view.diagnostic.summary)}</p> : null}
      {view.diagnostic.next_step && !reconciled ? (
        <p>{text(view.diagnostic.next_step)}</p>
      ) : null}
      {view.action === "configure" && (
        <p className="network-evidence-note">
          本次结果描述命令处理情况。业务是否达到目标，以独立写后读取和任务核验为准。
        </p>
      )}
      <div className="network-evidence-stages">
        {rows(view.data.stages || view.root.stages).map((row, index) => (
          <span key={index}>
            {stageNames[text(row.name)] || text(row.name)}：
            {statuses[text(row.status)] || text(row.status)}
          </span>
        ))}
      </div>
      {view.inspection && (
        <>
          <div className="network-evidence-actions">
            <button
              type="button"
              aria-pressed={exceptionsOnly}
              onClick={() => setExceptionsOnly(!exceptionsOnly)}
            >
              {exceptionsOnly ? "显示全部设备" : "仅显示需处理设备"}
            </button>
          </div>
          <ul>
            {view.devices
              .filter((row) => !exceptionsOnly || row.status !== "succeeded")
              .map((row) => (
                <li key={text(row.connection_id)}>
                  <strong>{text(row.name)}</strong> ·{" "}
                  {statuses[text(row.status)] || text(row.status)}
                  <code>{text(row.connection_id)}</code>
                  {row.error ? (
                    <p>
                      {text(object(row.diagnostic).summary) || text(row.error)}
                    </p>
                  ) : null}
                  {object(row.diagnostic).next_step ? (
                    <p>{text(object(row.diagnostic).next_step)}</p>
                  ) : null}
                </li>
              ))}
          </ul>
          <p>
            采集完成表示命令取得完整回显；协议健康与业务连通性需要相应证据。
          </p>
        </>
      )}
      {view.commands.length > 0 && (
        <ol className="network-command-evidence">
          {view.commands.map((row, index) => (
            <li key={index}>
              <code>{text(row.command)}</code>
              <span>
                {statuses[text(row.dispatch_status)] || "发送状态未记录"} ·{" "}
                {row.complete && !row.error_code && !row.truncated
                  ? "回显完整"
                  : "需核对回显"}
              </span>
              {row.error_code ? (
                <p>
                  {text(row.error_code)} {text(row.device_error)}
                </p>
              ) : null}
              {typeof row.output === "string" ? (
                <details>
                  <summary>原始回显</summary>
                  <pre>{row.output}</pre>
                </details>
              ) : (
                <p>本次实时记录提供执行索引；完整结果加载后可展开回显。</p>
              )}
            </li>
          ))}
        </ol>
      )}
      {view.artifactId && (
        <div className="network-evidence-artifact">
          <code>{view.artifactId}</code>
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadArtifact()}
          >
            {loading ? "读取中…" : "读取完整证据"}
          </button>
          {error && <p role="alert">{error}</p>}
          {content !== null && (
            <details open>
              <summary>完整证据</summary>
              <pre>{content}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
