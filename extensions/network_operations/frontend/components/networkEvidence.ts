export type EvidenceState =
  | "ok"
  | "fail"
  | "unknown"
  | "partial"
  | "unavailable"
  | "pending";
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
export const text = (value: unknown) =>
  typeof value === "string" ? value : "";

export function networkEvidence(tool: string, value: unknown) {
  if (
    ![
      "network.operations.device.manage",
      "network.operations.inspection",
    ].includes(tool)
  )
    return null;
  const root = object(value);
  if (!Object.keys(root).length) return null;
  const supplied = object(root.presentation);
  const inspection = tool === "network.operations.inspection";
  const task = object(root.task);
  const state =
    text(supplied.state) || text(inspection ? task.status : root.status);
  const pending = ["queued", "running", "pending"].includes(state);
  const outcome: EvidenceState =
    state === "unknown" || root.execution_may_continue === true
      ? "unknown"
      : state === "unavailable" || root.connection_ok === false
        ? "unavailable"
        : state === "partial" || root.read_ok === false
          ? "partial"
          : pending
            ? "pending"
            : ["ok", "succeeded"].includes(state) ||
                (root.ok === true && !inspection && state !== "failed")
              ? "ok"
              : "fail";
  const action =
    text(supplied.action || root.executed_action || root.requested_action) ||
    (root.configuration_workflow ? "configure" : "read");
  const label = ["cancelled", "canceled"].includes(state)
    ? "巡检已取消"
    : outcome === "unknown"
      ? "写入结果未知"
      : outcome === "unavailable"
        ? "设备不可达"
        : outcome === "partial"
          ? "证据不完整"
          : outcome === "pending"
            ? "巡检进行中"
            : outcome === "fail"
              ? "本次执行未完成"
              : inspection
                ? "采集完成"
                : action === "configure"
                  ? "命令已处理，待业务核验"
                  : action === "probe"
                    ? "连接验证成功"
                    : "读取完成";
  return {
    root,
    data: supplied,
    inspection,
    outcome,
    action,
    label,
    target: object(supplied.target || root.target || root.connection),
    commands: rows(root.command_results || supplied.command_results),
    devices: rows(supplied.devices || object(root.analysis_projection).devices),
    diagnostic: object(supplied.diagnostic || root.diagnostic),
    observedAt: text(supplied.observed_at || root.observed_at),
    artifactId: text(supplied.artifact_id || task.artifact_id),
    taskId: text(supplied.task_id || task.task_id),
  };
}
