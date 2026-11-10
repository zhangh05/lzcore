import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { RuntimeEventTimeline, runCardStatus } from "../components/RuntimeEventTimeline";
import { installMockApi, resetMocks } from "./mockServer";
import type { AgentResult } from "../types";
import type { ChatMsg } from "../stores/workbench";

/** The run card must project lifecycle + result facts; "not an error" is never "completed". */
function result(ok: boolean, outcome: string): AgentResult {
  return { ok, final_response: "x", events: [], trace_id: "t", session_id: "s", turn_id: "turn-1", tool_calls: [], warnings: [], errors: [],
    metadata: { workspace_id: "default", execution_outcome: outcome, ...(outcome === "unknown" ? { unknown_outcome: { status: "unknown", tool_id: "workspace.file", call_id: "c1" } } : {}) } } as AgentResult;
}
const user: ChatMsg = { id: "u", role: "user", text: "下发配置", created_at: "2026-10-08T10:00:00Z", status: "ready", run_id: "run-1" };
const assistant = (patch: Partial<ChatMsg>): ChatMsg => ({ id: "a", role: "assistant", text: "处理中", created_at: "2026-10-08T10:00:01Z", status: "ready", run_id: "run-1", ...patch });

function card(messages: ChatMsg[]) {
  const { container } = render(<RuntimeEventTimeline messages={messages} />);
  const el = container.querySelector(".rt-card")!;
  return { status: el.getAttribute("data-status"), label: el.querySelector(".rt-card-status")?.textContent, dot: el.querySelector(".rt-card-dot")?.className };
}

describe("timeline run card status", () => {
  beforeEach(() => { resetMocks(); installMockApi(); });

  it("a streaming turn is in progress, never completed", () => {
    const c = card([user, assistant({ status: "streaming" })]);
    expect(c).toEqual({ status: "running", label: "本轮进行中", dot: "rt-card-dot running" });
  });

  it("a streaming turn stays in progress even if a provisional result is attached", () => {
    expect(runCardStatus({ assistantMsg: assistant({ status: "streaming" }), result: result(true, "complete") }).status).toBe("running");
  });

  it("a user message with no reply is not completed", () => {
    const c = card([user]);
    expect(c.status).toBe("none");
    expect(c.label).toBe("尚无回复");
  });

  it("a settled reply without a result is not reported as success", () => {
    const c = card([user, assistant({ status: "ready" })]);
    expect(c.status).toBe("none");
    expect(c.label).toBe("结果未载入");
    expect(c.label).not.toBe("本轮完成");
  });

  it("completed only when the backend result says ok", () => {
    expect(card([user, assistant({ result: result(true, "complete") })])).toMatchObject({ status: "ok", label: "本轮完成" });
  });

  it("failed from the result, or from an errored message without a result", () => {
    expect(card([user, assistant({ status: "error", result: result(false, "failed") })])).toMatchObject({ status: "err", label: "本轮失败" });
    expect(runCardStatus({ assistantMsg: assistant({ status: "error" }) })).toEqual({ status: "err", statusLabel: "本轮失败" });
  });

  it("unknown outcome reads unknown", () => {
    expect(card([user, assistant({ status: "error", result: result(false, "unknown") })])).toMatchObject({ status: "unknown", label: "本轮结果未知" });
  });
});
