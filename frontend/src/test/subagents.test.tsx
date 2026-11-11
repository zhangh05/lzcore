import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubagentCard } from "../pages/workbench/SubagentCard";
import { partitionSubagentCalls, subagentState, type SubagentCall } from "../pages/workbench/subagents";
import { applyLiveEvent, type LiveTurn } from "../pages/workbench/Workbench";

const obs = (revision: number, extra: Record<string, unknown> = {}): SubagentCall => ({
  call_id: `read-${revision}`, tool_id: "agent.manage", ok: true,
  result: { subtask_id: "sub-a", task_status: "running", observation_revision: revision, profile_id: "data_agent", instruction: "统计订单", started_at: "2026-10-13T00:00:00Z",
    progress: { event: revision === 2 ? "tool_result" : "model_started", tool: "data.manage", tool_results: revision === 2 ? 1 : 0 }, ...extra },
});

describe("子 Agent 观察分组", () => {
  it("按子任务分组，迟到的旧 revision 不覆盖新状态；读取成功不等于子任务完成", () => {
    const g = partitionSubagentCalls([obs(1), obs(2), obs(1), { tool_id: "web.manage", ok: true }]);
    expect(g.tasks).toHaveLength(1);
    expect(g.ordinary.map((c) => c.tool_id)).toEqual(["web.manage"]);
    expect(g.tasks[0].latest.revision).toBe(2);
    render(<SubagentCard group={g.tasks[0]} />);
    expect(screen.getByTestId("subagent-status")).toHaveTextContent("运行中");
    expect(screen.getByText("数据分析")).toBeInTheDocument();
    expect(screen.getByText("工具结果 1 项")).toBeInTheDocument();
    expect(screen.getByText("观察记录 · 3 次")).toBeInTheDocument();
  });

  it("content_complete=false 或执行未知 → 待核对，不显示完成", () => {
    const incomplete = partitionSubagentCalls([obs(3, { task_status: "succeeded", content_complete: false })]).tasks[0];
    expect(subagentState(incomplete.latest)).toBe("unknown");
    const unknown = partitionSubagentCalls([obs(3, { task_status: "succeeded", progress: { state: "execution_unknown" } })]).tasks[0];
    expect(subagentState(unknown.latest)).toBe("unknown");
    render(<SubagentCard group={unknown} />);
    expect(screen.getByTestId("subagent-status")).toHaveTextContent("执行结果待核对");
  });

  it("observations 批量结果展开为各自子任务", () => {
    const g = partitionSubagentCalls([{ tool_id: "agent.manage", ok: true, result: { observations: [
      { result: { subtask_id: "a", task_status: "succeeded" } }, { result: { subtask_id: "b", task_status: "failed" } },
    ] } }]);
    expect(g.tasks.map((t) => [t.id, subagentState(t.latest)])).toEqual([["a", "done"], ["b", "failed"]]);
  });
});

describe("实时事件投影", () => {
  const base: LiveTurn = { clientRequestId: "cr", text: "", events: [], status: "" };
  it("tool_call → 进行中，tool_result 按 call_id 更新为结果；子任务观察累积", () => {
    let l = applyLiveEvent(base, "tool_call", { tool_id: "web.manage", call_id: "n1" });
    expect(l.steps).toEqual([{ callId: "n1", toolId: "web.manage", state: "running" }]);
    l = applyLiveEvent(l, "tool_result", { tool_id: "web.manage", call_id: "n1", ok: false, summary: "超时", duration_ms: 12 });
    expect(l.steps).toEqual([{ callId: "n1", toolId: "web.manage", state: "fail", summary: "超时", durationMs: 12 }]);
    l = applyLiveEvent(l, "subagent_observation", { tool_id: "agent.manage", call_id: "spawn", result: { subtask_id: "sub-a", task_status: "running", observation_revision: 2 } });
    l = applyLiveEvent(l, "subagent_observation", { tool_id: "agent.manage", call_id: "spawn", result: { subtask_id: "sub-a", task_status: "running", observation_revision: 1 } });
    const g = partitionSubagentCalls(l.subagentCalls ?? []);
    expect(g.tasks).toHaveLength(1);
    expect(g.tasks[0].latest.revision).toBe(2);
    expect(l.events).toHaveLength(4);
  });
});
