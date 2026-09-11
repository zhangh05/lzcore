import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineToolCallCard } from "../pages/AgentWorkbench/components/InlineToolCallCard";
import { ResultInline } from "../pages/AgentWorkbench/components/ResultInline";
import type { AgentResult, InlineToolCall } from "../types";

/**
 * 这一组测试守的是「结果未知」这条语义，而不是某个组件的长相。
 *
 * 背景：改造前内联工具卡只有 pending/ok/fail 三态，而「写入结果未知」在数据上
 * 同样是 `ok === false`，于是被渲染成红色「工具失败」。用户据此会以为配置没下发成功
 * 而重发，实际可能是「写进去了但回显丢失」——重复下发配置会产生真实副作用。
 *
 * 判定依据是**回合级** `metadata.execution_outcome === "unknown"`，
 * 触发事实 `unknown_outcome` 只回答「是哪一次调用」。两者会分叉，两个方向都测：
 *   - `execution_outcome: "unknown"` 而触发事实缺失（后端契约允许）
 *   - 触发事实还在、但 `status` 已被回读改成 `"reconciled"` 且回合已 complete
 *
 * 注意：卡片对 ok/fail 两种终态本来就没有文字标签（只有左边框颜色与图标），
 * 所以终态断言落在类名上，而不是编造一个并不存在的文案。
 */
const unknownFact = {
  status: "unknown" as const,
  tool_id: "workspace.file",
  call_id: "call-write-1",
  error_code: "TOOL_TIMEOUT_UNCERTAIN",
  execution_may_continue: true,
};

/** 那条未知写入：底层 `ok` 为 false，正是会被误判成「工具失败」的数据。 */
const unknownWriteCall = {
  call_id: "call-write-1",
  tool_id: "workspace.file",
  tool_name: "workspace.file",
  ok: false,
  status: "done",
  summary: "remote write timed out",
} as unknown as InlineToolCall;

/** 同一轮里另一次成功的调用，用于确认未知标记不会扩散。 */
const succeededCall = {
  call_id: "call-read-1",
  tool_id: "workspace.read",
  tool_name: "workspace.read",
  ok: true,
  status: "done",
} as unknown as InlineToolCall;

/** 正常路径：耐久运行时终态投影为 unknown，且触发事实指向这次写入。 */
const turnUnknown = {
  metadata: {
    workspace_id: "default",
    execution_outcome: "unknown" as const,
    unknown_outcome: unknownFact,
  },
};

/** 后端契约允许：`execution_outcome` 为 unknown，但没有触发事实可定位。 */
const turnUnknownWithoutPointer = {
  metadata: { workspace_id: "default", execution_outcome: "unknown" as const },
};

/** 回读确认后：触发事实仍在（status 已改成 reconciled），但回合已是 complete。 */
const turnReconciled = {
  metadata: {
    workspace_id: "default",
    execution_outcome: "complete" as const,
    unknown_outcome: { ...unknownFact, status: "reconciled" as const },
  },
};

/** 供 ResultInline 做跨组件文案比对用的完整 result。 */
const unknownResult = {
  ok: false,
  final_response: "写操作等待核对。",
  events: [],
  trace_id: "t",
  session_id: "s",
  turn_id: "u",
  tool_calls: [],
  warnings: [],
  errors: [],
  metadata: turnUnknown.metadata,
} as unknown as AgentResult;

/** 卡片根节点的状态类，例如 `unknown` / `fail` / `ok` / `pending`。 */
function cardState(container: HTMLElement): string | undefined {
  const card = container.querySelector(".tool-call-card");
  return card?.className.split(/\s+/).find((c) => c !== "tool-call-card" && c !== "is-open");
}

describe("内联工具卡区分「已确认的失败」与「写入结果未知」", () => {
  it("回合判定为 unknown 且触发事实指向该调用时显示结果未知，而不是按失败处理", () => {
    const { container } = render(
      <InlineToolCallCard toolCall={unknownWriteCall} seq={1} turnResult={turnUnknown} />,
    );

    expect(cardState(container)).toBe("unknown");
    expect(screen.getByText("结果未知")).toBeInTheDocument();
  });

  it("不传 turnResult 时行为与改造前完全一致（三态）", () => {
    const { container } = render(<InlineToolCallCard toolCall={unknownWriteCall} seq={1} />);

    expect(cardState(container)).toBe("fail");
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });

  it("同一轮里成功的调用不会被标成未知", () => {
    const { container } = render(
      <InlineToolCallCard toolCall={succeededCall} seq={2} turnResult={turnUnknown} />,
    );

    expect(cardState(container)).toBe("ok");
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });

  it("call_id 不一致时不回落到 tool_id（同一轮可重复出现同一工具）", () => {
    const secondWriteOfSameTool = {
      ...unknownWriteCall,
      call_id: "call-write-2",
    } as InlineToolCall;

    const { container } = render(
      <InlineToolCallCard toolCall={secondWriteOfSameTool} seq={2} turnResult={turnUnknown} />,
    );

    expect(cardState(container)).toBe("fail");
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });

  it("未结束的调用优先显示为执行中，不被未知态覆盖", () => {
    const stillRunning = { ...unknownWriteCall, status: "pending" } as InlineToolCall;

    const { container } = render(
      <InlineToolCallCard toolCall={stillRunning} seq={1} turnResult={turnUnknown} />,
    );

    expect(cardState(container)).toBe("pending");
    expect(screen.getByText("已提交，等待设备结果")).toBeInTheDocument();
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });

  it("展开后给出事实字段，且不把模型的可选动作说成系统强制流程", () => {
    const { container } = render(
      <InlineToolCallCard toolCall={unknownWriteCall} seq={1} turnResult={turnUnknown} />,
    );
    fireEvent.click(screen.getByText("workspace.file"));

    const facts = container.querySelector(".tc-unknown-facts");
    expect(facts).toHaveTextContent("工具：workspace.file");
    expect(facts).toHaveTextContent("调用：call-write-1");
    expect(facts).toHaveTextContent("代码：TOOL_TIMEOUT_UNCERTAIN");

    // 过度断言守卫：未知结果时完整工具结果已返回模型，后续动作由模型自行决定。
    const text = container.textContent || "";
    expect(text).not.toMatch(/系统.*自动重放/);
    expect(text).not.toMatch(/必须.*回读/);
    expect(text).not.toMatch(/已冻结|禁止重试/);
  });
});

/**
 * 反向分叉：不能只看 `unknown_outcome` 对象在不在。
 * 这两条曾经会把「已经确认过的写入」重新渲染成不确定，用户同样会重发。
 */
describe("内联工具卡不把已解决的不确定性重新渲染成未知", () => {
  it("触发事实被回读改成 reconciled、回合已 complete 时按终态渲染", () => {
    const { container } = render(
      <InlineToolCallCard toolCall={unknownWriteCall} seq={1} turnResult={turnReconciled} />,
    );

    // 注意：这里落回 fail 是**调用级**事实（这次调用没有回报成功），
    // 与回合级 execution_outcome === "complete" 并不矛盾 —— 二者本就被
    // 刻意分开（见 types/index.ts 对 execution_outcome / tool_execution_outcome 的说明）。
    expect(cardState(container)).toBe("fail");
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });

  it("回合判定为 unknown 但触发事实缺失时不猜是哪一次调用", () => {
    const { container } = render(
      <InlineToolCallCard
        toolCall={unknownWriteCall}
        seq={1}
        turnResult={turnUnknownWithoutPointer}
      />,
    );

    expect(cardState(container)).toBe("fail");
    expect(screen.queryByText("结果未知")).not.toBeInTheDocument();
  });
});

describe("未知结果文案在卡片与回合告警之间必须逐字一致", () => {
  it("两处渲染出的说明段落完全相同", () => {
    const inline = render(
      <InlineToolCallCard toolCall={unknownWriteCall} seq={1} turnResult={turnUnknown} />,
    );
    fireEvent.click(screen.getByText("workspace.file"));

    const alert = render(<ResultInline result={unknownResult} fallbackText="" />);

    const inlineParagraph = inline.container.querySelector(".tc-unknown p");
    const alertParagraph = alert.container.querySelector(".unknown-outcome-alert p");

    expect(inlineParagraph).not.toBeNull();
    expect(alertParagraph).not.toBeNull();
    // 文案一旦分叉，这条断言就会失败。
    expect(inlineParagraph?.textContent).toBe(alertParagraph?.textContent);
  });

  it("卡片与回合告警共用同一个结论句与短标签", () => {
    const inline = render(
      <InlineToolCallCard toolCall={unknownWriteCall} seq={1} turnResult={turnUnknown} />,
    );
    fireEvent.click(screen.getByText("workspace.file"));

    const alert = render(<ResultInline result={unknownResult} fallbackText="" />);

    const headline = "执行结果尚未确定，完整结果已返回模型";
    expect(inline.container).toHaveTextContent(headline);
    expect(alert.container).toHaveTextContent(headline);
    expect(inline.container).toHaveTextContent("结果未知");
    expect(alert.container).toHaveTextContent("结果未知");
  });
});
