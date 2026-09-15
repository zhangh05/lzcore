import { describe, expect, it } from "vitest";
import type { ChatMsg } from "../stores/workbench";
import { buildTaskProgress } from "../utils/taskProgress";

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
});
