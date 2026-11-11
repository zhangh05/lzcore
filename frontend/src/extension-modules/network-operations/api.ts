import { api, enc, type Query } from "../../api/client";

export const NET_BASE = "/api/extensions/network.operations";
export const net = {
  get: (p: string, ws: string, q?: Query) => api.get(`${NET_BASE}${p}`, { workspace_id: ws, ...q }),
  post: (p: string, ws: string, body: Record<string, unknown> = {}) => api.post(`${NET_BASE}${p}`, { workspace_id: ws, ...body }, { workspace_id: ws }),
  put: (p: string, ws: string, body: Record<string, unknown> = {}) => api.put(`${NET_BASE}${p}`, { workspace_id: ws, ...body }, { workspace_id: ws }),
  del: (p: string, ws: string, body: Record<string, unknown> = {}) => api.del(`${NET_BASE}${p}`, { workspace_id: ws, ...body }, { workspace_id: ws }),
};
export { enc };


export interface InspectionDevice { connection_id: string; name?: string; status?: string; error?: string; retryable?: boolean; failed_commands?: { command: string; error_code?: string }[] }
export interface Inspection { task_id: string; status?: string; connection_ids?: string[]; results?: Record<string, { status?: string; name?: string }>; retry_of_task_id?: string; created_at?: string; updated_at?: string; unknown_outcome?: unknown; execution_outcome?: string }

/** 巡检重试门控：未知态禁用；只重试未成功目标；全成功则无可重试。 */
export function inspectionRetryGate(task: Inspection, devices: InspectionDevice[]): { allowed: boolean; reason?: string; targets: string[] } {
  const status = String(task.status ?? "");
  if (status === "unknown" || task.execution_outcome === "unknown" || (task.unknown_outcome && typeof task.unknown_outcome === "object" && (task.unknown_outcome as { status?: string }).status !== "reconciled")) {
    return { allowed: false, reason: "巡检结果未知 · 需核对，不能重试。", targets: [] };
  }
  if (!["failed", "partial", "cancelled"].includes(status)) return { allowed: false, reason: "巡检未结束或已全部成功，无需重试。", targets: [] };
  const targets = devices.filter((d) => d.status !== "succeeded" && d.retryable !== false).map((d) => d.connection_id);
  if (!targets.length) return { allowed: false, reason: "没有未成功的目标。", targets };
  return { allowed: true, targets };
}
