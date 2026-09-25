import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TaskProgressPanel } from "../pages/AgentWorkbench/components/TaskProgressPanel";
import type { ChatMsg } from "../stores/workbench";
import type { ActiveTurnSnapshot } from "../types";

function mockAssistant(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "msg-1",
    role: "assistant",
    text: "分析完成",
    status: "ready",
    created_at: "2026-09-25T10:00:00Z",
    result: {
      ok: true,
      final_response: "分析完成",
      events: [],
      trace_id: "trace-1",
      session_id: "sess-1",
      turn_id: "turn-1",
      tool_calls: [],
      warnings: [],
      errors: [],
      metadata: {},
    },
    toolCalls: [
      {
        tool_id: "device.inspect",
        tool_name: "网络状态检查",
        ok: true,
        status: "done",
        summary: "获取到核心网关 10.1.0.1 端口列表",
        call_id: "call-net-1",
      },
      {
        tool_id: "data.manage",
        tool_name: "数据分析",
        ok: true,
        status: "done",
        summary: "分析流量统计数据",
        call_id: "call-data-2",
      },
    ],
    run_id: "run-b2d721eb",
    ...overrides,
  };
}

describe("TaskProgressPanel Component", () => {
  beforeEach(() => {
    // Mock navigator.clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockImplementation(() => Promise.resolve()),
      },
      configurable: true,
      writable: true,
    });
  });

  it("renders 4 phases and execution footprint cards in succeeded state", () => {
    const onShowTimeline = vi.fn();
    const onToggleCollapsed = vi.fn();

    render(
      <TaskProgressPanel
        latestAssistant={mockAssistant()}
        turnRunning={false}
        onShowTimeline={onShowTimeline}
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
      />
    );

    // 1. Verifies 4 phases
    expect(screen.getByText("理解问题")).toBeInTheDocument();
    expect(screen.getByText("收集证据")).toBeInTheDocument();
    expect(screen.getByText("分析判断")).toBeInTheDocument();
    expect(screen.getByText("形成建议")).toBeInTheDocument();

    // 2. Verifies header pills and status
    expect(screen.getByText("执行完成")).toBeInTheDocument();
    expect(screen.getByText("run-b2d7")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1); // 2 tools

    // 3. Verifies post-run tool footprint cards (filling the empty void)
    const footprintSection = screen.getByTestId("task-footprint-section");
    expect(footprintSection).toBeInTheDocument();
    expect(within(footprintSection).getByText("获取到核心网关 10.1.0.1 端口列表")).toBeInTheDocument();
    expect(within(footprintSection).getByText("分析流量统计数据")).toBeInTheDocument();
  });

  it("renders live in-flight feedback when turn is running", () => {
    const snapshot: ActiveTurnSnapshot = {
      session_id: "sess-1",
      status: "running",
      stage: "execution_started",
      run_id: "run-live-123",
      tool_calls: [
        {
          tool_id: "device.inspect",
          status: "running",
          summary: "正在读取交换机配置...",
          call_id: "call-live-1",
        },
      ],
    };

    render(
      <TaskProgressPanel
        latestAssistant={mockAssistant({ status: "streaming", toolCalls: [], result: undefined })}
        snapshot={snapshot}
        turnRunning={true}
        onShowTimeline={vi.fn()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );

    const inFlight = screen.getByTestId("task-in-flight");
    expect(inFlight).toBeInTheDocument();
    expect(within(inFlight).getByText(/正在读取交换机配置/)).toBeInTheDocument();
    expect(screen.getByText("正在处理")).toBeInTheDocument();
  });

  it("supports copying run ID and copying full markdown report", async () => {
    const { act } = await import("@testing-library/react");
    render(
      <TaskProgressPanel
        latestAssistant={mockAssistant()}
        turnRunning={false}
        onShowTimeline={vi.fn()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );

    // Click copy Run ID
    const runIdBtn = screen.getByTitle(/点击复制完整 Run ID/);
    await act(async () => {
      fireEvent.click(runIdBtn);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("run-b2d721eb");

    // Click copy execution summary
    const copySummaryBtn = screen.getByText("复制摘要");
    await act(async () => {
      fireEvent.click(copySummaryBtn);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("### 任务执行报告")
    );
  });

  it("links cross-panel navigation when clicking footprint card", () => {
    // Setup target mock element in document body
    const targetElement = document.createElement("div");
    targetElement.id = "tool-call-call-net-1";
    targetElement.scrollIntoView = vi.fn();
    document.body.appendChild(targetElement);

    render(
      <TaskProgressPanel
        latestAssistant={mockAssistant()}
        turnRunning={false}
        onShowTimeline={vi.fn()}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    );

    // Click the tool footprint card
    const footprintSection = screen.getByTestId("task-footprint-section");
    const summaryEl = within(footprintSection).getByText("获取到核心网关 10.1.0.1 端口列表");
    const card = summaryEl.closest(".task-footprint-card");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    // Target element should be scrolled into view
    expect(targetElement.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(targetElement.classList.contains("highlight-flash")).toBe(true);

    document.body.removeChild(targetElement);
  });
});
