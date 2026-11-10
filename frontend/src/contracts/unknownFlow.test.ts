import { describe, expect, it } from "vitest";
import {
  advanceUnknownFlow, canSubmitMark, expectedConfirmation, initialUnknownFlow, resumeMetadata,
  UnknownFlowError, type UnknownFlowEvent, type UnknownFlowState, type UnknownTarget,
} from "./unknownFlow";

const target: UnknownTarget = { kind: "ledger", operationId: "op1", workspaceId: "ws-demo-1", taskId: "task-1" };

function run(events: UnknownFlowEvent[], start: UnknownFlowState = initialUnknownFlow(target)) {
  return events.reduce(advanceUnknownFlow, start);
}

describe("未知态流程：核对 → 标记（依据 + 二次确认）→ 续接", () => {
  it("完整路径", () => {
    const s = run([
      { type: "start_verify" },
      { type: "readback", result: "still_unknown" },
      { type: "begin_mark" },
      { type: "edit_mark", resolution: "succeeded", reason: "设备上已看到配置", confirmation: "RESOLVE op1" },
      { type: "submit_mark" },
      { type: "mark_readback", confirmed: true },
      { type: "request_resume" },
    ]);
    expect(s).toEqual({ step: "resume_requested", target, resumeTaskId: "task-1" });
    expect(resumeMetadata("task-1")).toEqual({ resume_task_id: "task-1" });
  });

  it("不核对不能直接标记", () => {
    expect(() => run([{ type: "begin_mark" }])).toThrow(UnknownFlowError);
  });

  it("不能跳过标记直接续接", () => {
    expect(() => run([{ type: "start_verify" }, { type: "readback", result: "still_unknown" }, { type: "request_resume" }])).toThrow(UnknownFlowError);
  });

  it("依据为空或确认串不符时不能提交", () => {
    const base = run([{ type: "start_verify" }, { type: "readback", result: "still_unknown" }, { type: "begin_mark" }]);
    const noReason = advanceUnknownFlow(base, { type: "edit_mark", resolution: "failed", reason: "  ", confirmation: "RESOLVE op1" });
    expect(canSubmitMark(noReason)).toBe(false);
    expect(() => advanceUnknownFlow(noReason, { type: "submit_mark" })).toThrow(UnknownFlowError);
    const badConfirm = advanceUnknownFlow(base, { type: "edit_mark", resolution: "failed", reason: "看过", confirmation: "resolve op1" });
    expect(canSubmitMark(badConfirm)).toBe(false);
    expect(expectedConfirmation(target)).toBe("RESOLVE op1");
  });

  it("标记被受理只是回执：回读未确认则回到需人工标记", () => {
    const s = run([
      { type: "start_verify" }, { type: "readback", result: "still_unknown" }, { type: "begin_mark" },
      { type: "edit_mark", resolution: "failed", reason: "无变化", confirmation: "RESOLVE op1" }, { type: "submit_mark" },
    ]);
    expect(s.step).toBe("mark_submitted");
    expect(advanceUnknownFlow(s, { type: "mark_readback", confirmed: false }).step).toBe("verified_still_unknown");
  });

  it("回读已 reconciled：直接进入已标记", () => {
    expect(run([{ type: "start_verify" }, { type: "readback", result: "reconciled" }]).step).toBe("marked");
  });

  it("事件类型里不存在 retry / resend / replan", () => {
    // @ts-expect-error —— 类型层面不允许一键重试
    const bad: UnknownFlowEvent = { type: "retry" };
    expect(() => advanceUnknownFlow(initialUnknownFlow(target), bad)).toThrow();
  });
});
