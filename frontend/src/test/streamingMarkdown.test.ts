import { describe, expect, it } from "vitest";
import remend from "remend";
import { renderMarkdown } from "../utils/markdown";
import { liveAsMessage } from "../pages/workbench/Thread";
import { applyLiveEvent } from "../pages/workbench/Workbench";

describe("流式 Markdown", () => {
  it("未闭合的语法先补齐再排版，和终态排版一致", () => {
    expect(renderMarkdown(remend("结论：**重要"))).toContain("<strong>重要</strong>");
    expect(renderMarkdown(remend("```python\nprint(1)"))).toMatch(/<pre[\s\S]*print\(1\)/);
    const done = "结论：**重要**。";
    expect(renderMarkdown(remend(done))).toBe(renderMarkdown(done));
  });

  it("实时回合投影成一条进行中的助手消息，工具步骤即最终卡片的字段", () => {
    const m = liveAsMessage({ clientRequestId: "cr_1", text: "hi", events: [], status: "", steps: [
      { callId: "c1", toolId: "files.read", state: "running" },
      { callId: "c2", toolId: "files.write", state: "fail", summary: "denied" },
    ] });
    expect(m.role).toBe("assistant");
    expect(m.metadata?.client_request_id).toBe("cr_1");
    expect(m.metadata?.tool_calls).toEqual([
      { call_id: "c1", tool_id: "files.read", status: "running", ok: false, summary: undefined },
      { call_id: "c2", tool_id: "files.write", status: undefined, ok: false, summary: "denied" },
    ]);
  });

  it("模型连接重试时状态如实说在重试，下一次 model_started 不会盖回「模型处理中」", () => {
    let l = applyLiveEvent({ clientRequestId: "cr", text: "", events: [], status: "" }, "model_started", {});
    expect(l.status).toBe("模型处理中");
    l = applyLiveEvent(l, "provider_retrying", { attempt: 2, error: "http_502" });
    expect(l.status).toBe("模型连接失败，正在第 2 次重试 · 可以停止本轮");
    l = applyLiveEvent(l, "model_started", {});
    expect(l.status).toContain("第 2 次重试");
  });
});
