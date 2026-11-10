/**
 * 未知态流程契约：核对 → 标记结果（填依据 + 二次确认）→ 续接。
 *
 * 状态机里**没有** retry / resend / replan 事件；类型层面就无法表达「一键重试」。
 * 账本标记沿用后端确认串 `RESOLVE <operation_id>`（backend/api/admin_routes.py:94-130）。
 * review-item 标记走 `PUT /api/review-items/<id>`，同样要求填依据。
 * 标记请求被受理只是第 3 层回执（mark_submitted），必须回读确认后才进入 marked。
 */

export type UnknownTarget =
  | { kind: "ledger"; operationId: string; workspaceId: string; taskId?: string }
  | { kind: "review_item"; itemId: string; artifactId: string; workspaceId: string; taskId?: string }
  | { kind: "task"; taskId: string; workspaceId: string };

export type Resolution = "succeeded" | "failed";

export type UnknownFlowState =
  | { step: "needs_verification"; target: UnknownTarget }
  | { step: "verifying"; target: UnknownTarget }
  | { step: "verified_still_unknown"; target: UnknownTarget }
  | { step: "marking"; target: UnknownTarget; resolution?: Resolution; reason: string; confirmation: string }
  | { step: "mark_submitted"; target: UnknownTarget; resolution: Resolution; reason: string }
  | { step: "marked"; target: UnknownTarget; resolution: Resolution; reason: string }
  | { step: "resume_requested"; target: UnknownTarget; resumeTaskId: string };

export type UnknownFlowEvent =
  | { type: "start_verify" }
  | { type: "readback"; result: "still_unknown" | "reconciled" }
  | { type: "begin_mark" }
  | { type: "edit_mark"; resolution?: Resolution; reason?: string; confirmation?: string }
  | { type: "submit_mark" }
  | { type: "mark_readback"; confirmed: boolean }
  | { type: "request_resume" };

export class UnknownFlowError extends Error {}

export function initialUnknownFlow(target: UnknownTarget): UnknownFlowState {
  return { step: "needs_verification", target };
}

/** 后端要求的确认串。review-item 没有后端确认串，前端用同一格式做二次确认。 */
export function expectedConfirmation(target: UnknownTarget): string {
  switch (target.kind) {
    case "ledger": return `RESOLVE ${target.operationId}`;
    case "review_item": return `RESOLVE ${target.itemId}`;
    case "task": return `RESOLVE ${target.taskId}`;
  }
}

export function canSubmitMark(state: UnknownFlowState): boolean {
  return state.step === "marking"
    && !!state.resolution
    && state.reason.trim().length > 0
    && state.confirmation === expectedConfirmation(state.target);
}

export function resumeTaskIdOf(target: UnknownTarget): string | undefined {
  return target.taskId;
}

function fail(state: UnknownFlowState, event: UnknownFlowEvent): never {
  throw new UnknownFlowError(`非法转换：${state.step} --${event.type}-->`);
}

export function advanceUnknownFlow(state: UnknownFlowState, event: UnknownFlowEvent): UnknownFlowState {
  switch (event.type) {
    case "start_verify":
      if (state.step === "needs_verification" || state.step === "verified_still_unknown") return { step: "verifying", target: state.target };
      return fail(state, event);
    case "readback":
      if (state.step !== "verifying") return fail(state, event);
      // 回读已 reconciled：不再是未知，直接进入可续接的「已标记」等价态（由服务端给出依据）。
      return event.result === "reconciled"
        ? { step: "marked", target: state.target, resolution: "succeeded", reason: "服务端回读已确认（reconciled）" }
        : { step: "verified_still_unknown", target: state.target };
    case "begin_mark":
      // 必须先核对（至少回读一次）才能标记。
      if (state.step !== "verified_still_unknown") return fail(state, event);
      return { step: "marking", target: state.target, reason: "", confirmation: "" };
    case "edit_mark":
      if (state.step !== "marking") return fail(state, event);
      return {
        ...state,
        resolution: event.resolution ?? state.resolution,
        reason: event.reason ?? state.reason,
        confirmation: event.confirmation ?? state.confirmation,
      };
    case "submit_mark":
      if (state.step !== "marking" || !canSubmitMark(state)) return fail(state, event);
      return { step: "mark_submitted", target: state.target, resolution: state.resolution!, reason: state.reason.trim() };
    case "mark_readback":
      if (state.step !== "mark_submitted") return fail(state, event);
      return event.confirmed
        ? { step: "marked", target: state.target, resolution: state.resolution, reason: state.reason }
        : { step: "verified_still_unknown", target: state.target };
    case "request_resume": {
      if (state.step !== "marked") return fail(state, event);
      const resumeTaskId = resumeTaskIdOf(state.target);
      if (!resumeTaskId) return fail(state, event);
      return { step: "resume_requested", target: state.target, resumeTaskId };
    }
    default:
      // 运行时兜底：任何未声明事件（例如 retry / resend）都被拒绝。
      throw new UnknownFlowError(`不支持的事件：${String((event as { type?: unknown }).type)}`);
  }
}

/** 续接请求的元数据：只带 `resume_task_id`，由服务端只重放传输日志，未知写入只回查。 */
export function resumeMetadata(resumeTaskId: string): { resume_task_id: string } {
  return { resume_task_id: resumeTaskId };
}

/** 续接白名单（迁自 TaskResumeControl.tsx:9）。 */
export const RESUMABLE_TASK_STATUSES: ReadonlySet<string> = new Set([
  "partial", "replan_required", "waiting_user", "interrupted", "cancelled", "failed",
]);

export const UNKNOWN_FLOW_STEP_LABEL: Readonly<Record<UnknownFlowState["step"], string>> = {
  needs_verification: "待核对",
  verifying: "回读中",
  verified_still_unknown: "回读后仍未知 · 需人工标记",
  marking: "填写依据并二次确认",
  mark_submitted: "标记已提交 · 等待回读确认",
  marked: "已标记 · 可续接",
  resume_requested: "已请求续接",
};

export const UNKNOWN_FLOW_COPY = {
  rule: "未知写入只回查、不重放：先核对，再标记结果（填依据 + 二次确认），最后续接。",
} as const;
