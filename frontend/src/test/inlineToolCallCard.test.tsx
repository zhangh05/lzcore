import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineToolCallCard } from "../pages/AgentWorkbench/components/InlineToolCallCard";
import type { InlineToolCall } from "../types";


describe("InlineToolCallCard orchestration metadata", () => {
  it("ignores malformed persisted types instead of crashing or showing false parallel state", () => {
    const toolCall = {
      call_id: "call-1",
      tool_name: "data.manage",
      ok: true,
      orchestration: {
        step_id: "parse",
        layer: "1",
        parallel: "False",
        depends_on: "[]",
      },
    } as unknown as InlineToolCall;

    render(<InlineToolCallCard toolCall={toolCall} seq={1} />);
    fireEvent.click(screen.getByText("data.manage"));

    expect(screen.getByText("步骤：parse")).toBeInTheDocument();
    expect(screen.queryByText("并行执行")).not.toBeInTheDocument();
    expect(screen.queryByText(/依赖：/)).not.toBeInTheDocument();
    expect(screen.queryByText("第 1 组")).not.toBeInTheDocument();
  });

  it("shows valid parallel dependency metadata", () => {
    const toolCall = {
      call_id: "call-2",
      tool_id: "text.analyze",
      tool_name: "text.analyze",
      ok: true,
      orchestration: {
        step_id: "analyse",
        layer: 2,
        parallel: true,
        depends_on: ["parse"],
      },
    } as InlineToolCall;

    render(<InlineToolCallCard toolCall={toolCall} seq={2} />);
    fireEvent.click(screen.getByText("text.analyze"));

    expect(screen.getByText("第 2 组")).toBeInTheDocument();
    expect(screen.getByText("并行执行")).toBeInTheDocument();
    expect(screen.getByText("依赖：parse")).toBeInTheDocument();
  });
});

import { SubagentTaskCard } from "../components/SubagentTaskCard";
import { partitionSubagentCalls } from "../utils/subagentTracking";

it("groups real observations by child identity and keeps lifecycle separate from successful reads", () => {
  const calls = [1,2,1].map((revision): InlineToolCall => ({call_id:`read-${revision}`,tool_id:"agent.manage",tool_name:"多 Agent",ok:true,status:"done",duration_ms:2,
    result:{subtask_id:"sub-a",task_status:"running",observation_revision:revision,profile_id:"data_agent",instruction:"统计订单",started_at:"2026-10-13T00:00:00Z",
      progress:{event:revision===2?"tool_result":"model_started",tool:"data.manage",tool_results:revision===2?1:0}}}));
  const grouped=partitionSubagentCalls(calls);
  expect(grouped.tasks).toHaveLength(1);
  expect(grouped.ordinary).toHaveLength(0);
  expect(grouped.tasks[0].latest.revision).toBe(2);
  render(<SubagentTaskCard group={grouped.tasks[0]}/>);
  expect(screen.getByText("运行中")).toBeInTheDocument();
  expect(screen.queryByText("子任务已完成")).not.toBeInTheDocument();
  expect(screen.getByText("工具结果 1 项")).toBeInTheDocument();
  expect(screen.getByText("观察记录 · 3 次")).toBeInTheDocument();
});

it("shows partial device evidence independently of a successful tool envelope and preserves raw output", () => {
  const { container } = render(<InlineToolCallCard seq={1} toolCall={{
    tool_id: "network.operations.device.manage", tool_name: "设备读取", call_id: "read-device", status: "done", ok: true,
    result: { ok: true, status: "partial", connection_ok: true, read_ok: false,
      target: { connection_id: "conn-a", name: "核心交换机" },
      command_results: [{ command: "display version", dispatch_status: "sent", complete: false, output: "完整保留的部分回显", error_code: "prompt_timeout" }] },
  }} />);
  expect(container.querySelector(".tool-call-card")).toHaveClass("partial");
  fireEvent.click(screen.getByText("设备读取"));
  expect(screen.getByText("display version")).toBeInTheDocument();
  fireEvent.click(screen.getByText("原始回显"));
  expect(screen.getByText("完整保留的部分回显")).toBeVisible();
});

it("keeps an unknown device write visible when turn-level uncertainty metadata is absent", () => {
  const { container } = render(<InlineToolCallCard seq={1} toolCall={{
    tool_id: "network.operations.device.manage", tool_name: "设备配置", call_id: "write-device", status: "done", ok: false,
    result: { status: "unknown", execution_may_continue: true, requested_action: "configure" },
  }} />);
  expect(container.querySelector(".tool-call-card")).toHaveClass("unknown");
});
