/**
 * 三层状态契约（阶段 0 冻结）。
 *
 * 第 1 层 —— 用户目标结论：`execution_outcome`（complete / partial / unknown / failed）
 *            + 目标列表。**只有这一层可以写「完成」。**
 * 第 2 层 —— 工具尝试：`tool_execution_outcome` 与各次调用（pending → unknown → ok → fail）。
 * 第 3 层 —— 传输 / 命令回执：HTTP ok、已入队、已提交、取消请求已受理。
 *            只能写「已提交 / 已入队 / 已发送 / 已请求取消」。
 *
 * 判定只读服务端字段，从不由 `ok` / HTTP 状态 / job.status 合成业务结论。
 * 起点：旧 `frontend/src/components/toolCallState.ts` 的两道门（迁入后去掉了
 * 对 `extensions/**` 的引用，核心不再识别任何扩展证据格式）。
 */

export type ExecutionOutcome = "complete" | "partial" | "unknown" | "failed";

/** 服务端 `unknown_outcome` 触发事实（回合 metadata 或 job.metadata.active_turn）。 */
export interface UnknownOutcomeFact {
  tool_id?: string;
  call_id?: string;
  error_code?: string;
  execution_may_continue?: boolean;
  /** 回读确认后后端会把它改成 "reconciled"。 */
  status?: string;
}

export interface GoalItem {
  goal_id?: string;
  title?: string;
  status?: string;
}

/** 回合 / 任务的服务端事实。字段名与后端一致，全部可缺省。 */
export interface TurnFacts {
  ok?: boolean;
  errors?: unknown[];
  metadata?: {
    execution_outcome?: string;
    tool_execution_outcome?: string;
    unknown_outcome?: UnknownOutcomeFact | null;
    goals?: GoalItem[];
  } | null;
}

/** jobs 记录（只当队列 / 传输层）。见 jobs/runner.py:83-105、jobs/store.py:135-160。 */
export interface JobFacts {
  job_id?: string;
  job_type?: string;
  status?: string;
  error?: string;
  result_summary?: {
    ok?: boolean;
    execution_outcome?: string;
    tool_execution_outcome?: string;
  } | null;
  metadata?: {
    active_turn?: {
      status?: string;
      error?: string;
      unknown_outcome?: UnknownOutcomeFact | null;
    } | null;
  } | null;
}

/** 第 1 层呈现状态。`not_reported` = 服务端没有给出结论，前端不替它补。 */
export type GoalState = "pending" | "unknown" | "complete" | "partial" | "failed" | "not_reported";

const OUTCOMES: ReadonlySet<string> = new Set(["complete", "partial", "unknown", "failed"]);

function asOutcome(value: unknown): ExecutionOutcome | undefined {
  return typeof value === "string" && OUTCOMES.has(value) ? (value as ExecutionOutcome) : undefined;
}

/** 门二：触发事实仍未被回读关闭。 */
export function isUnresolvedFact(fact?: UnknownOutcomeFact | null): fact is UnknownOutcomeFact {
  return !!fact && fact.status !== "reconciled";
}

/**
 * 旧两道门原样迁入：只有 `execution_outcome === "unknown"` 且事实未 reconciled
 * 才返回能指向具体调用的事实。用于第 2 层（工具卡）定位是哪一次调用。
 */
export function unresolvedUnknownOutcome(facts?: TurnFacts | null): UnknownOutcomeFact | undefined {
  if (facts?.metadata?.execution_outcome !== "unknown") return undefined;
  const fact = facts.metadata.unknown_outcome;
  return isUnresolvedFact(fact) ? fact : undefined;
}

/**
 * 第 1 层判定。顺序不可调换：pending → unknown → 服务端结论 → not_reported。
 *
 * unknown 的条件（方案 1.1 / 3.3）：`execution_outcome === "unknown"`，
 * **或**存在未 reconcile 的 `unknown_outcome`。与 `ok` / `errors` 无关 ——
 * `ok:true` + 无 errors + unknown 仍是 unknown（映射二）。
 */
export function deriveGoalState(facts?: TurnFacts | null, opts: { running?: boolean } = {}): GoalState {
  if (opts.running) return "pending";
  const meta = facts?.metadata ?? undefined;
  const outcome = asOutcome(meta?.execution_outcome);
  if (outcome === "unknown" || isUnresolvedFact(meta?.unknown_outcome)) return "unknown";
  return outcome ?? "not_reported";
}

/**
 * job 的第 1 层判定。job.status 是队列态，不是目标结论：
 * - `result_summary.execution_outcome`（runner 写入）
 * - `metadata.active_turn.unknown_outcome`（租约过期等路径写入，映射一）
 */
export function deriveJobGoalState(job?: JobFacts | null): GoalState {
  if (!job) return "not_reported";
  const turnFact = job.metadata?.active_turn?.unknown_outcome;
  const summary = job.result_summary ?? undefined;
  const status = String(job.status ?? "");
  if (asOutcome(summary?.execution_outcome) === "unknown" || isUnresolvedFact(turnFact)) return "unknown";
  if (status === "queued" || status === "running" || status === "cancel_requested") return "pending";
  return asOutcome(summary?.execution_outcome) ?? "not_reported";
}

/** 第 1 层文案。只有 complete 可以出现「完成」；partial / failed / unknown 都不出现「完成 / 成功」。 */
export const GOAL_LABEL: Readonly<Record<GoalState, string>> = {
  pending: "进行中",
  unknown: "结果未知 · 需核对",
  complete: "已完成",
  partial: "部分达成 · 有目标待处理",
  failed: "失败",
  not_reported: "结论未上报",
};

export type Tone = "neutral" | "ok" | "warn" | "danger" | "unknown" | "info";

export const GOAL_TONE: Readonly<Record<GoalState, Tone>> = {
  pending: "info",
  unknown: "unknown",
  complete: "ok",
  partial: "warn",
  failed: "danger",
  not_reported: "neutral",
};

export function goalLabel(state: GoalState): string {
  return GOAL_LABEL[state];
}

/** 未知态（以及 not_reported）只能核对，不能当终态展示成「完成」。 */
export function requiresVerification(state: GoalState): boolean {
  return state === "unknown";
}

// ── 第 2 层：工具尝试 ─────────────────────────────────────────────

export type ToolAttemptState = "pending" | "unknown" | "ok" | "fail";

export interface ToolCallFacts {
  call_id?: string;
  tool_id: string;
  status?: string;
  ok?: boolean;
}

function pointsAtCall(ref: ToolCallFacts, fact?: UnknownOutcomeFact): boolean {
  if (!fact) return false;
  const byCall = !!fact.call_id && fact.call_id === ref.call_id;
  const byTool = !fact.call_id && !!fact.tool_id && fact.tool_id === ref.tool_id;
  return byCall || byTool;
}

/** 工具卡判定：pending → unknown → ok → fail（旧两道门）。`ok` 只代表这一次尝试。 */
export function deriveToolAttemptState(call: ToolCallFacts, turn?: TurnFacts | null): ToolAttemptState {
  if (call.status === "pending" || call.status === "running") return "pending";
  if (pointsAtCall(call, unresolvedUnknownOutcome(turn))) return "unknown";
  return call.ok ? "ok" : "fail";
}

/** 第 2 层文案：工具尝试不等于目标完成，因此不用「完成 / 成功」。 */
export const TOOL_ATTEMPT_LABEL: Readonly<Record<ToolAttemptState, string>> = {
  pending: "调用中",
  unknown: "结果未知",
  ok: "调用已返回",
  fail: "调用报错",
};

/** 「已调用 N 次工具」—— 只计数，不宣称处理完成（W-10）。 */
export function toolAttemptSummary(calls: ToolCallFacts[], turn?: TurnFacts | null): string {
  const states = calls.map((call) => deriveToolAttemptState(call, turn));
  const count = (s: ToolAttemptState) => states.filter((x) => x === s).length;
  const parts = [`已调用 ${calls.length} 次工具`];
  if (count("unknown")) parts.push(`${count("unknown")} 次结果未知`);
  if (count("fail")) parts.push(`${count("fail")} 次报错`);
  if (count("pending")) parts.push(`${count("pending")} 次调用中`);
  return parts.join(" · ");
}

// ── 第 3 层：传输 / 命令回执 ──────────────────────────────────────

export type ReceiptKind = "submitted" | "queued" | "sent" | "cancel_requested" | "rejected";

export const RECEIPT_LABEL: Readonly<Record<ReceiptKind, string>> = {
  submitted: "已提交",
  queued: "已入队",
  sent: "已发送",
  cancel_requested: "已请求取消 · 等待终态确认",
  rejected: "未受理",
};

export function receiptLabel(kind: ReceiptKind): string {
  return RECEIPT_LABEL[kind];
}

/** job 队列态文案（第 3 层）。`succeeded` 只说明队列走完，不说明目标完成。 */
export function jobQueueLabel(status?: string): string {
  switch (status) {
    case "queued": return "已入队";
    case "running": return "运行中";
    case "cancel_requested": return RECEIPT_LABEL.cancel_requested;
    case "cancelled": return "已终止";
    case "succeeded": return "作业已结束";
    case "failed":
    case "error": return "作业报错";
    default: return status ? `状态：${status}` : "状态未上报";
  }
}

/**
 * 取消的文案：只有服务端确认终态 cancelled 才能写「已终止任务」（W-4）。
 * 取消请求被受理（HTTP ok / cancel_requested）只能写「已请求取消」。
 */
export function cancelLabel(confirmedStatus?: string): string {
  return confirmedStatus === "cancelled" ? "已终止任务" : RECEIPT_LABEL.cancel_requested;
}

// ── 可见动作 ──────────────────────────────────────────────────────

/**
 * 一键重试 / 重发 / 换方案继续：**任何状态都不提供**。
 * - 未知态：只能核对 → 标记 → 续接（见 unknownFlow.ts）。
 * - 明确失败：只能经确认框（列出将重放的内容）的 `canOfferConfirmedJobRetry`。
 * 保留函数是为了让调用方显式表达意图，并被单测锁死为 false。
 */
export function canShowOneClickRetry(_facts?: TurnFacts | JobFacts | null): false {
  return false;
}

/**
 * jobs `/retry` 门禁（映射一）：只有 status 明确是 failed / error，且第 1 层不是 unknown，
 * 才可在**确认框**里提供重试。后端 `retry_job` 本身不看 unknown（jobs/manager.py:121-135），
 * 所以门禁必须在前端。
 */
export function canOfferConfirmedJobRetry(job?: JobFacts | null): boolean {
  if (!job) return false;
  const status = String(job.status ?? "");
  if (status !== "failed" && status !== "error") return false;
  return deriveJobGoalState(job) !== "unknown";
}

export type OutcomeAction = "verify" | "mark_result" | "resume" | "view_detail" | "confirmed_job_retry";

/** 第 1 层状态下可见的动作。unknown 永远只有核对 → 标记 → 续接。 */
export function visibleActions(state: GoalState, job?: JobFacts | null): OutcomeAction[] {
  if (state === "unknown") return ["verify", "mark_result", "resume"];
  const actions: OutcomeAction[] = ["view_detail"];
  if (job && canOfferConfirmedJobRetry(job)) actions.push("confirmed_job_retry");
  return actions;
}

export const ACTION_LABEL: Readonly<Record<OutcomeAction, string>> = {
  verify: "去核对",
  mark_result: "标记结果",
  resume: "续接任务",
  view_detail: "查看详情",
  confirmed_job_retry: "重试作业（需确认）",
};

/** 结论条 / 进度 / 任务中心 / 时间线共用的一次性投影。 */
export interface OutcomeView {
  goal: GoalState;
  goalLabel: string;
  tone: Tone;
  actions: OutcomeAction[];
  /** 未知态用常驻 alert 语义。 */
  persistentAlert: boolean;
}

export function outcomeView(facts?: TurnFacts | null, opts: { running?: boolean } = {}): OutcomeView {
  const goal = deriveGoalState(facts, opts);
  return { goal, goalLabel: GOAL_LABEL[goal], tone: GOAL_TONE[goal], actions: visibleActions(goal), persistentAlert: goal === "unknown" };
}

export function jobOutcomeView(job?: JobFacts | null): OutcomeView & { queueLabel: string } {
  const goal = deriveJobGoalState(job);
  return {
    goal,
    goalLabel: GOAL_LABEL[goal],
    tone: GOAL_TONE[goal],
    actions: visibleActions(goal, job),
    persistentAlert: goal === "unknown",
    queueLabel: jobQueueLabel(job?.status),
  };
}
