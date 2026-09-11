import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StageOutputs } from "../pages/AgentWorkbench/components/StageOutputs";
import { useChatStream } from "../hooks/useChatStream";
import { useWorkbenchStore } from "../stores/workbench";
import { precedingStageOutputs } from "../utils/stageOutputs";
import { installMockApi, resetMocks } from "./mockServer";

beforeEach(() => {
  installMockApi();
  useWorkbenchStore.setState({ bySession: {}, currentSessionId: "stages", sending: false });
});
afterEach(() => { vi.unstubAllGlobals(); resetMocks(); });

it("preserves queued text across tool and model boundaries, then restores it from server history", async () => {
  let socket: FakeSocket;
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() { this.onclose?.(); }
    frame(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const hook = renderHook(() => useChatStream(
    { workspaceId: "default", sessionId: "stages", llmHealth: {} },
    { onSessionResolved: vi.fn() },
  ));
  let pending: Promise<void>;
  act(() => { pending = hook.result.current.send({ text: "检查", attachments: [], effectiveSessionId: "stages" }); });
  await waitFor(() => expect(socket!.onmessage).toBeTypeOf("function"));
  act(() => {
    socket.frame({ type: "event", name: "model_started", data: {} });
    socket.frame({ type: "token", content: "先检查第一项。" });
    socket.frame({ type: "event", name: "tool_call", data: { tool_id: "web.manage", call_id: "one" } });
    socket.frame({ type: "event", name: "model_started", data: {} });
    socket.frame({ type: "token", content: "再检查第二项。" });
    socket.frame({ type: "event", name: "model_started", data: {} });
  });
  const stages = useWorkbenchStore.getState().bySession.stages.at(-1)!.stageOutputs!;
  expect(stages.map(item => item.text)).toEqual(["先检查第一项。", "再检查第二项。"]);
  await act(async () => {
    socket.frame({ type: "done", session_id: "stages", turn_id: "run-stages", final_response: "检查完成。", metadata: { stage_outputs: stages } });
    await pending;
  });
  expect(useWorkbenchStore.getState().bySession.stages.at(-1)!.text).toBe("检查完成。");
  useWorkbenchStore.setState({ bySession: {} });
  act(() => useWorkbenchStore.getState().mergeFromBackend("stages", [{
    message_id: "run-stages:assistant", role: "assistant", content: "检查完成。",
    session_id: "stages", run_id: "run-stages", created_at: "2026-09-12T00:00:00Z",
    metadata: { stage_outputs: stages },
  }]));
  expect(useWorkbenchStore.getState().bySession.stages[0].stageOutputs).toEqual(stages);
  hook.unmount();
});

it("keeps earlier outputs collapsible and removes only the duplicate final stage", () => {
  const stages = [
    { id: "1", label: "模型输出 1", text: "第一阶段" },
    { id: "2", label: "模型输出 2", text: "最终答复" },
  ];
  render(<StageOutputs stages={precedingStageOutputs(stages, "最终答复")} />);
  const summary = screen.getByText("模型输出 1");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByText("第一阶段")).toBeVisible();
  expect(screen.queryByText("最终答复")).not.toBeInTheDocument();
});
