import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL, cancelLabel, canOfferConfirmedJobRetry, canShowOneClickRetry, deriveGoalState, deriveJobGoalState,
  deriveToolAttemptState, GOAL_LABEL, goalLabel, jobOutcomeView, jobQueueLabel, outcomeView, RECEIPT_LABEL,
  receiptLabel, toolAttemptSummary, TOOL_ATTEMPT_LABEL, visibleActions, type GoalState, type JobFacts, type TurnFacts,
} from "./outcomeState";

const DONE_WORDS = /完成|成功/;
const RETRY_WORDS = /重试|重发|换方案/;

function allVisibleText(view: { goalLabel: string; actions: string[]; queueLabel?: string }): string {
  return [view.goalLabel, view.queueLabel ?? "", ...view.actions.map((a) => ACTION_LABEL[a as keyof typeof ACTION_LABEL])].join(" ");
}

describe("第 1 层：只有 complete 能写「完成」", () => {
  it("除 complete 外所有目标文案都不含「完成 / 成功」", () => {
    for (const [state, label] of Object.entries(GOAL_LABEL) as [GoalState, string][]) {
      if (state === "complete") expect(label).toContain("完成");
      else expect(label).not.toMatch(DONE_WORDS);
    }
  });
  it("第 2 / 3 层文案都不含「完成 / 成功」", () => {
    for (const l of Object.values(TOOL_ATTEMPT_LABEL)) expect(l).not.toMatch(DONE_WORDS);
    for (const l of Object.values(RECEIPT_LABEL)) expect(l).not.toMatch(DONE_WORDS);
    for (const s of ["queued", "running", "succeeded", "failed", "error", "cancel_requested", "cancelled", undefined]) {
      expect(jobQueueLabel(s)).not.toMatch(DONE_WORDS);
    }
  });
  it("没有 execution_outcome 时不由 ok 合成结论", () => {
    expect(deriveGoalState({ ok: true })).toBe("not_reported");
    expect(deriveGoalState({ ok: true, metadata: {} })).toBe("not_reported");
    expect(goalLabel("not_reported")).not.toMatch(DONE_WORDS);
  });
  it("running 时一律 pending，不被终态覆盖", () => {
    expect(deriveGoalState({ ok: true, metadata: { execution_outcome: "complete" } }, { running: true })).toBe("pending");
  });
});

describe("4.5 语义样例", () => {
  it("ok:true + partial：任何位置都不出现「完成 / 成功」", () => {
    const v = outcomeView({ ok: true, metadata: { execution_outcome: "partial", tool_execution_outcome: "complete" } });
    expect(v.goal).toBe("partial");
    expect(allVisibleText(v)).not.toMatch(DONE_WORDS);
  });

  it("ok:false + unknown：显示「结果未知 · 需核对」，没有一键重发 / 重试 / 换方案继续", () => {
    const facts: TurnFacts = { ok: false, metadata: { execution_outcome: "unknown", unknown_outcome: { tool_id: "x.write", call_id: "c1" } } };
    const v = outcomeView(facts);
    expect(v.goalLabel).toBe("结果未知 · 需核对");
    expect(v.persistentAlert).toBe(true);
    expect(v.actions).toEqual(["verify", "mark_result", "resume"]);
    expect(allVisibleText(v)).not.toMatch(RETRY_WORDS);
    expect(canShowOneClickRetry(facts)).toBe(false);
  });

  it("unknown + 已 reconciled：不再误报未知", () => {
    const facts: TurnFacts = { ok: true, metadata: { execution_outcome: "complete", unknown_outcome: { tool_id: "x.write", call_id: "c1", status: "reconciled" } } };
    expect(deriveGoalState(facts)).toBe("complete");
    expect(deriveToolAttemptState({ tool_id: "x.write", call_id: "c1", ok: false }, facts)).toBe("fail");
  });

  it("映射一：job.status==failed + active_turn.unknown_outcome（租约过期）→ 需核对，禁用一键重试", () => {
    const job: JobFacts = {
      job_id: "j1", status: "failed", error: "worker_lease_expired",
      metadata: { active_turn: { status: "failed", error: "worker_lease_expired",
        unknown_outcome: { tool_id: "jobs.worker", call_id: "lease-1", error_code: "WORKER_LEASE_EXPIRED", execution_may_continue: true } } },
    };
    const v = jobOutcomeView(job);
    expect(deriveJobGoalState(job)).toBe("unknown");
    expect(v.goalLabel).toBe("结果未知 · 需核对");
    expect(canOfferConfirmedJobRetry(job)).toBe(false);
    expect(canShowOneClickRetry(job)).toBe(false);
    expect(v.actions).not.toContain("confirmed_job_retry");
    expect(allVisibleText(v)).not.toMatch(RETRY_WORDS);
  });

  it("映射二：ok:true、无 errors、execution_outcome:unknown、作业未失败 → 结果未知，不写成功 / 本轮完成，无重试，动作是核对与续接", () => {
    const job: JobFacts = { job_id: "j2", status: "succeeded", result_summary: { ok: true, execution_outcome: "unknown", tool_execution_outcome: "unknown" } };
    const v = jobOutcomeView(job);
    expect(v.goal).toBe("unknown");
    expect(v.goalLabel).toBe("结果未知 · 需核对");
    expect(allVisibleText(v)).not.toMatch(DONE_WORDS);
    expect(allVisibleText(v)).not.toMatch(RETRY_WORDS);
    expect(canOfferConfirmedJobRetry(job)).toBe(false);
    expect(v.actions).toEqual(["verify", "mark_result", "resume"]);
    // 回合级同样成立（ok:true + errors 为空）
    expect(outcomeView({ ok: true, errors: [], metadata: { execution_outcome: "unknown" } }).goalLabel).toBe("结果未知 · 需核对");
  });

  it("存在未 reconcile 的 unknown_outcome 时，即使 execution_outcome 写着 complete 也显示未知", () => {
    expect(deriveGoalState({ ok: true, metadata: { execution_outcome: "complete", unknown_outcome: { tool_id: "w" } } })).toBe("unknown");
  });

  it("已提交 / 已入队 与 完成 分离；cancel_requested 不写成「已终止任务」", () => {
    expect(receiptLabel("submitted")).toBe("已提交");
    expect(receiptLabel("queued")).toBe("已入队");
    expect(cancelLabel("cancel_requested")).not.toContain("已终止");
    expect(cancelLabel(undefined)).not.toContain("已终止");
    expect(cancelLabel("running")).not.toContain("已终止");
    expect(cancelLabel("cancelled")).toBe("已终止任务");
    expect(jobQueueLabel("cancel_requested")).not.toContain("已终止");
  });
});

describe("一键重试门禁", () => {
  it("任何状态都没有一键重试", () => {
    const samples: (TurnFacts | JobFacts | null)[] = [null, { ok: false }, { status: "failed" }, { ok: true, metadata: { execution_outcome: "failed" } }];
    for (const s of samples) expect(canShowOneClickRetry(s)).toBe(false);
  });
  it("明确 failed 且非未知：只给「需确认」的作业重试", () => {
    const job: JobFacts = { status: "failed", result_summary: { ok: false, execution_outcome: "failed" } };
    expect(canOfferConfirmedJobRetry(job)).toBe(true);
    expect(visibleActions(deriveJobGoalState(job), job)).toContain("confirmed_job_retry");
    expect(ACTION_LABEL.confirmed_job_retry).toContain("需确认");
  });
  it("非 failed 状态不提供作业重试", () => {
    for (const status of ["queued", "running", "succeeded", "cancel_requested", "cancelled"]) {
      expect(canOfferConfirmedJobRetry({ status })).toBe(false);
    }
  });
  it("unknown 态动作集合永远只有核对 → 标记 → 续接", () => {
    expect(visibleActions("unknown", { status: "failed" })).toEqual(["verify", "mark_result", "resume"]);
  });
});

describe("第 2 层：旧两道门 pending → unknown → ok → fail", () => {
  const turn: TurnFacts = { metadata: { execution_outcome: "unknown", unknown_outcome: { tool_id: "f.write", call_id: "c2" } } };
  it("pending 优先", () => {
    expect(deriveToolAttemptState({ tool_id: "f.write", call_id: "c2", status: "running" }, turn)).toBe("pending");
  });
  it("按 call_id 精确命中未知，同 tool_id 的另一次调用不受影响", () => {
    expect(deriveToolAttemptState({ tool_id: "f.write", call_id: "c2", ok: false }, turn)).toBe("unknown");
    expect(deriveToolAttemptState({ tool_id: "f.write", call_id: "c1", ok: true }, turn)).toBe("ok");
  });
  it("门一：execution_outcome 不是 unknown 时不标未知", () => {
    const t2: TurnFacts = { metadata: { execution_outcome: "failed", unknown_outcome: { tool_id: "f.write", call_id: "c2" } } };
    expect(deriveToolAttemptState({ tool_id: "f.write", call_id: "c2", ok: false }, t2)).toBe("fail");
  });
  it("工具计数不宣称处理完成（W-10）", () => {
    const s = toolAttemptSummary([{ tool_id: "f.write", call_id: "c2", ok: false }, { tool_id: "a", call_id: "c3", ok: true }], turn);
    expect(s).toBe("已调用 2 次工具 · 1 次结果未知");
    expect(s).not.toMatch(DONE_WORDS);
  });
});
