import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RuntimeEventTimeline } from "../components/RuntimeEventTimeline";
import { installMockApi, resetMocks } from "./mockServer";
import type { AgentResult } from "../types";
import type { ChatMsg } from "../stores/workbench";

/**
 * 时间线（落库卡片视图）是**第三处**把「写入结果未知」显示成「失败」的地方。
 *
 * 它此前的判定是 `tc.ok ? "完成" : "失败"` —— 与内联工具卡改造前完全同一个错误：
 * 「写入结果未知」在数据上同样是 `ok === false`，于是用户看到「失败」，
 * 以为没写进去而重发。现在两处共用 `deriveSettledCardState`，不可能再分叉。
 */

const unknownFact = {
  status: "unknown" as const,
  tool_id: "workspace.file",
  call_id: "call-write-1",
  error_code: "TOOL_TIMEOUT_UNCERTAIN",
  execution_may_continue: true,
};

function turnWith(metadata: AgentResult["metadata"], ok: boolean): AgentResult {
  return {
    ok,
    final_response: ok ? "配置已下发。" : "写操作等待核对。",
    events: [
      {
        event_id: "tool-start-call-write-1",
        event_type: "tool_call",
        node_id: "call-write-1",
        call_id: "call-write-1",
        tool_id: "workspace.file",
        summary: "下发配置",
      },
    ],
    trace_id: "trace-1",
    session_id: "sess-1",
    turn_id: "turn_unk",
    tool_calls: [
      {
        call_id: "call-write-1",
        tool_id: "workspace.file",
        ok,
        duration_ms: 30000,
        summary: ok ? "applied" : "remote write timed out",
      },
    ],
    warnings: [],
    errors: [],
    metadata,
  };
}

const unknownTurn = turnWith(
  { workspace_id: "default", execution_outcome: "unknown", unknown_outcome: unknownFact },
  false,
);

/** 回读已确认：触发事实仍在，但 status 已是 reconciled，回合 complete。 */
const reconciledTurn = turnWith(
  {
    workspace_id: "default",
    execution_outcome: "complete",
    unknown_outcome: { ...unknownFact, status: "reconciled" },
  },
  false,
);

/** 真正确定下来的失败：没有未知触发事实。 */
const confirmedFailureTurn = turnWith(
  { workspace_id: "default", execution_outcome: "failed" },
  false,
);

function messagesFor(result: AgentResult): ChatMsg[] {
  const runId = result.turn_id || "run-test";
  return [
    {
      id: `${runId}-user`,
      role: "user",
      text: "下发配置",
      created_at: "2026-06-28T10:00:00Z",
      status: "ready",
      run_id: runId,
    },
    {
      id: `${runId}-assistant`,
      role: "assistant",
      text: result.final_response,
      created_at: "2026-06-28T10:00:01Z",
      status: result.ok ? "ready" : "error",
      run_id: runId,
      result,
    },
  ];
}

function expandRunCard() {
  fireEvent.click(screen.getByText(/turn_unk/).closest(".rt-card-bar")!);
}

describe("时间线不把「写入结果未知」显示成「失败」", () => {
  beforeEach(() => { resetMocks(); installMockApi(); });

  it("未知写入的工具条目显示结果未知", () => {
    const { container } = render(<RuntimeEventTimeline messages={messagesFor(unknownTurn)} />);
    expandRunCard();

    expect(screen.getByText("结果未知")).toBeInTheDocument();
    expect(screen.queryByText("失败")).not.toBeInTheDocument();
    expect(container.querySelector(".rt-step-head.unknown")).not.toBeNull();
    expect(container.querySelector(".rt-tag.unknown")).not.toBeNull();
  });

  it("未知写入不再画成红色的失败图标", () => {
    const { container } = render(<RuntimeEventTimeline messages={messagesFor(unknownTurn)} />);
    expandRunCard();

    expect(container.querySelector(".rt-step-ok.unknown")).not.toBeNull();
    expect(container.querySelector(".rt-step-ok.fail")).toBeNull();
  });

  it("回合卡片圆点使用未知色，而不是错误色", () => {
    const { container } = render(<RuntimeEventTimeline messages={messagesFor(unknownTurn)} />);

    expect(container.querySelector(".rt-card-dot.unknown")).not.toBeNull();
    expect(container.querySelector(".rt-card-dot.err")).toBeNull();
  });

  it("回读已确认的回合不显示未知", () => {
    const { container } = render(<RuntimeEventTimeline messages={messagesFor(reconciledTurn)} />);
    expandRunCard();

    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
    expect(container.querySelector(".rt-card-dot.unknown")).toBeNull();
  });

  it("确定下来的失败仍然显示失败（没有把失败一并吞掉）", () => {
    const { container } = render(
      <RuntimeEventTimeline messages={messagesFor(confirmedFailureTurn)} />,
    );
    expandRunCard();

    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
    expect(container.querySelector(".rt-step-ok.fail")).not.toBeNull();
    expect(container.querySelector(".rt-card-dot.err")).not.toBeNull();
  });
});
