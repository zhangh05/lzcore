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
