import { describe, expect, it } from "vitest";
import type { ChatMsg } from "../stores/workbench";
import { buildTaskProgress, formatRunSummaryMarkdown, resolveStageIndex } from "../utils/taskProgress";

function assistant(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "a-1",
    role: "assistant",
    text: "",
    status: "streaming",
    created_at: "2026-08-14T10:00:00Z",
    ...overrides,
  };
}

describe("task progress projection", () => {
  it("keeps pending calls running and never turns a failed done call into success", () => {
    const model = buildTaskProgress(assistant({ toolCalls: [
      { tool_id: "workspace.file", tool_name: "文件", ok: false, status: "pending" },
      { tool_id: "workspace.file", tool_name: "文件", ok: false, status: "done" },
    ] }));
    expect(model.evidence.map(item => item.status)).toEqual(["running", "failed"]);
  });

  it("does not mark later phases complete after an evidence-stage failure", () => {
    const model = buildTaskProgress(assistant({ status: "error", result: {
      ok: false, final_response: "采集失败", events: [], trace_id: "trace", session_id: "s", turn_id: "t",
      tool_calls: [], warnings: [], errors: ["collection_failed"], metadata: {},
    } }), {
      status: "failed", stage: "tool_result",
    });
    expect(model.status).toBe("failed");
    expect(model.phases.map(phase => phase.state)).toEqual(["done", "failed", "idle", "idle"]);
  });

  it("uses the shared call identity and reconciliation rules for unknown writes", () => {
    const message = assistant({ status: "error", result: {
      ok: false, final_response: "", events: [], trace_id: "trace", session_id: "s", turn_id: "t",
      warnings: [], errors: [],
      tool_calls: [
        { call_id: "write-1", tool_id: "workspace.file", ok: true },
        { call_id: "write-2", tool_id: "workspace.file", ok: false },
      ],
      metadata: { execution_outcome: "unknown", unknown_outcome: {
        status: "unknown", tool_id: "workspace.file", call_id: "write-2",
      } },
    } });
    expect(buildTaskProgress(message).evidence.map(item => item.status)).toEqual(["done", "unknown"]);
    message.result!.metadata.execution_outcome = "complete";
    message.result!.metadata.unknown_outcome!.status = "reconciled";
    expect(buildTaskProgress(message).evidence.map(item => item.status)).toEqual(["done", "failed"]);
  });

  it("maps granular runtime stages into four user-facing phases", () => {
    const model = buildTaskProgress(assistant({
      runtimeEvents: [
        { event_id: "1", event_type: "planner_completed" },
        { event_id: "2", event_type: "tool_call", tool_id: "web.search" },
      ],
    }));

    expect(model.activeIndex).toBe(1);
    expect(model.phases.map((phase) => phase.state)).toEqual(["done", "active", "idle", "idle"]);
  });

  it("shows only real tool calls as evidence entries", () => {
    const model = buildTaskProgress(assistant({
      toolCalls: [
        { tool_id: "web.search", tool_name: "搜索", ok: true, status: "done", summary: "3 个来源" },
        { tool_id: "device.inspect", tool_name: "检查", ok: false, status: "running" },
      ],
    }));

    expect(model.evidence).toHaveLength(2);
    expect(model.evidence[0]).toMatchObject({ source: "网络检索", status: "done" });
    expect(model.evidence[1]).toMatchObject({ source: "网络设备", status: "running" });
  });

  it("restores a completed durable snapshot without a streaming placeholder", () => {
    const model = buildTaskProgress(undefined, {
      session_id: "s-1",
      status: "succeeded",
      stage: "turn_completed",
      tool_calls: [{ tool_id: "knowledge.manage", status: "done", ok: true }],
    });

    expect(model.status).toBe("succeeded");
    expect(model.phases.every((phase) => phase.state === "done")).toBe(true);
    expect(model.evidence[0].source).toBe("知识库");
  });

  it("never marks the final answer complete while the current turn is still active", () => {
    const model = buildTaskProgress(assistant({
      // This is the race observed in the workbench: a cached/intermediate
      // result and terminal event are visible before the live turn has ended.
      status: "ready",
      result: {
        ok: true,
        final_response: "",
        events: [],
        trace_id: "trace-1",
        session_id: "s-1",
        turn_id: "turn-1",
        tool_calls: [],
        warnings: [],
        errors: [],
        metadata: {},
      },
      runtimeEvents: [{ event_id: "1", event_type: "turn_completed" }],
    }), {
      status: "succeeded",
      stage: "turn_completed",
    }, { turnRunning: true });

    expect(model.status).toBe("running");
    expect(model.phases.map((phase) => phase.state)).toEqual(["done", "done", "done", "active"]);
  });

  it("reports observed stage durations and turn cost, never estimates", () => {
    const model = buildTaskProgress(undefined, {
      status: "running",
      started_at: "2026-09-15T10:00:00.000Z",
      updated_at: "2026-09-15T10:00:12.000Z",
      run_id: "run_abc123def456",
      events: [
        { event_id: "1", event_type: "turn_started", occurred_at: "2026-09-15T10:00:00.000Z" },
        { event_id: "2", event_type: "planner_completed", occurred_at: "2026-09-15T10:00:03.000Z" },
        { event_id: "3", event_type: "execution_started", occurred_at: "2026-09-15T10:00:04.000Z" },
      ],
      tool_calls: [{ tool_id: "device.inspect", status: "done", ok: true }],
    }, { turnRunning: true });

    expect(model.runId).toBe("run_abc123def456");
    expect(model.elapsedMs).toBe(12000);
    expect(model.toolCount).toBe(1);
    // Understanding spans turn_started -> planner_completed: three real seconds.
    expect(model.phases[0].durationMs).toBe(3000);
    // The next stage has a single event, so it has a start but no span to report.
    expect(model.phases[1].durationMs).toBeUndefined();
  });

  it("omits durations the runtime never timestamped instead of inventing them", () => {
    const model = buildTaskProgress(undefined, {
      status: "succeeded",
      stage: "turn_completed",
      tool_calls: [],
    });

    expect(model.phases.every((phase) => phase.durationMs === undefined)).toBe(true);
    expect(model.elapsedMs).toBeUndefined();
    expect(model.runId).toBeUndefined();
    expect(model.toolCount).toBe(0);
  });

  it("identifies active in-flight tool and calculates duration totals", () => {
    const model = buildTaskProgress(assistant({
      toolCalls: [
        { tool_id: "device.inspect", tool_name: "检查设备", ok: true, status: "done" },
        { tool_id: "web.search", tool_name: "搜索", ok: false, status: "running", summary: "查询端口状态" },
      ],
    }), {
      status: "running",
      events: [
        { event_id: "1", event_type: "turn_started", occurred_at: "2026-09-15T10:00:00.000Z" },
        { event_id: "2", event_type: "planner_completed", occurred_at: "2026-09-15T10:00:02.000Z" },
        { event_id: "3", event_type: "execution_started", occurred_at: "2026-09-15T10:00:03.000Z" },
        { event_id: "4", event_type: "execution_completed", occurred_at: "2026-09-15T10:00:08.000Z" },
      ],
    }, { turnRunning: true });

    expect(model.completedToolCount).toBe(1);
    expect(model.activeTool?.title).toBe("信息检索");
    expect(model.activeTool?.summary).toBe("查询端口状态");
    expect(model.totalPhaseDurationMs).toBe(7000); // 2000ms + 5000ms
  });

  it("formats structured markdown report for one-click copy", () => {
    const model = buildTaskProgress(assistant({
      toolCalls: [
        { tool_id: "device.inspect", tool_name: "设备检查", ok: true, status: "done", summary: "采集到 3 台交换机" },
      ],
    }), {
      status: "succeeded",
      run_id: "run_test999",
      started_at: "2026-09-15T10:00:00.000Z",
      finished_at: "2026-09-15T10:00:15.000Z",
      stage: "turn_completed",
    });

    const markdown = formatRunSummaryMarkdown(model);
    expect(markdown).toContain("### 任务执行报告");
    expect(markdown).toContain("run_test999");
    expect(markdown).toContain("实测总耗时");
    expect(markdown).toContain("网络状态检查");
    expect(markdown).toContain("采集到 3 台交换机");
  });

  it("resolves model_started to proper phases according to stream_scope", () => {
    expect(resolveStageIndex({ event_id: "1", event_type: "model_started", stream_scope: "planner" } as any)).toBe(0);
    expect(resolveStageIndex({ event_id: "2", event_type: "model_started", stream_scope: "response" } as any)).toBe(3);
    expect(resolveStageIndex({ event_id: "3", event_type: "model_started", stream_scope: "continuation" } as any)).toBe(2);
    // Fallback without scope: no tools -> 0 (understand), with tools -> 2 (analysis)
    expect(resolveStageIndex({ event_id: "4", event_type: "model_started" } as any, false)).toBe(0);
    expect(resolveStageIndex({ event_id: "5", event_type: "model_started" } as any, true)).toBe(2);
    expect(resolveStageIndex("provider_retrying")).toBe(0);
  });

  it("attributes planner model time to Phase 1 and avoids Phase 3 premature duration and regression", () => {
    // Exact scenario from user's bug report:
    // A turn begins, runs planner model for 6s, and finishes planner.
    // Must NOT attribute 6s to Phase 3 or leave Phase 3 waiting with 6s while Phase 1 is active.
    const model = buildTaskProgress(assistant({
      status: "streaming",
      runtimeEvents: [
        { event_id: "e1", event_type: "turn_started", occurred_at: "2026-09-26T10:00:00.000Z" },
        { event_id: "e2", event_type: "planner_started", occurred_at: "2026-09-26T10:00:00.000Z" },
        { event_id: "e3", event_type: "model_started", occurred_at: "2026-09-26T10:00:00.000Z", stream_scope: "planner" } as any,
        { event_id: "e4", event_type: "model_completed", occurred_at: "2026-09-26T10:00:06.000Z", stream_scope: "planner" } as any,
        { event_id: "e5", event_type: "planner_completed", occurred_at: "2026-09-26T10:00:06.000Z" },
      ],
    }), {
      status: "running",
      stage: "planner_completed",
    }, { turnRunning: true });

    expect(model.activeIndex).toBe(0);
    // Phase 1 (understand) has the 6s duration
    expect(model.phases[0].durationMs).toBe(6000);
    expect(model.phases[0].state).toBe("active");
    // Phase 3 (analysis) must NOT have 6s duration or be active
    expect(model.phases[2].durationMs).toBeUndefined();
    expect(model.phases[2].state).toBe("idle");
  });

  it("enforces monotonic phase progression preventing backwards stage jumps", () => {
    // If a tool has already run (Phase 2 evidence), an incoming late stage event
    // with index 0 (e.g. planner_completed or turn_started) cannot jump activeIndex back to 0.
    const model = buildTaskProgress(assistant({
      status: "streaming",
      runtimeEvents: [
        { event_id: "e1", event_type: "turn_started" },
        { event_id: "e2", event_type: "tool_call", tool_id: "web.search" },
      ],
    }), {
      status: "running",
      stage: "turn_started", // Stale polled snapshot stage
    }, { turnRunning: true });

    expect(model.activeIndex).toBe(1);
    expect(model.phases[0].state).toBe("done");
    expect(model.phases[1].state).toBe("active");
  });
});

