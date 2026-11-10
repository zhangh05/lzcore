import { RESUMABLE_TASK_STATUSES } from "../../contracts/unknownFlow";

/** durable TaskState（agent/runtime/durable/models.py:53-62）。注意：没有 execution_outcome / unknown_outcome。 */
export interface RuntimeTask {
  task_id: string;
  workspace_id?: string;
  session_id?: string;
  run_id?: string;
  job_id?: string;
  trace_id?: string;
  user_goal?: string;
  status?: string;
  current_step_id?: string;
  steps?: RuntimeStep[];
  pending_action_id?: string;
  warnings?: unknown[];
  errors?: unknown[];
  created_at?: string;
  updated_at?: string;
}

export interface RuntimeStep { step_id: string; title?: string; name?: string; status?: string; tool_id?: string; error?: string }

export interface SessionTaskView { task_id?: string; status?: string; unknowns?: { kind?: string; reason?: string; operation_id?: string }[] }

/** durable 任务状态文案：只描述运行时状态机，不代表目标是否达成。 */
export const RUNTIME_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: "排队中",
  running: "运行中",
  interrupting: "中断中 · 等待终态",
  succeeded: "运行时已结束",
  failed: "运行时报错",
  cancelled: "已取消",
};

export function runtimeStatusLabel(s?: string): string {
  return s ? RUNTIME_STATUS_LABEL[s] ?? `状态：${s}` : "状态未上报";
}

/** 该接口不含目标层结论；未知项只能从会话 task-state 读。 */
export const OUTCOME_FIELD_MISSING = "结论未上报（该接口不含 execution_outcome）";

export type Gate = { allowed: true } | { allowed: false; reason: string };

/** 续接 / 步骤重试门控：会话 task-state 有未知项 → 禁用；task-state 不可读 → 也禁用（不能确认没有未知项）。 */
export function runtimeActionGate(kind: "resume" | "step_retry", task: RuntimeTask, sessionTask: SessionTaskView | null | "unreadable"): Gate {
  if (sessionTask === "unreadable") return { allowed: false, reason: "会话任务状态不可读，无法确认是否存在结果未知的写入；先核对。" };
  if (sessionTask && (sessionTask.unknowns?.length ?? 0) > 0) return { allowed: false, reason: `存在 ${sessionTask.unknowns!.length} 项结果未知 · 需核对，核对并标记后才能${kind === "resume" ? "续接" : "重试步骤"}。` };
  if (kind === "resume") {
    const st = String(task.status ?? "");
    if (!["failed", "cancelled", ...RESUMABLE_TASK_STATUSES].includes(st)) return { allowed: false, reason: `当前状态（${runtimeStatusLabel(task.status)}）不可续接。` };
  }
  return { allowed: true };
}
