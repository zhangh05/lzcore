import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../api/client";
import { TaskResumeControl } from "../pages/AgentWorkbench/components/TaskResumeControl";

afterEach(() => vi.restoreAllMocks());

describe("explicit task resume", () => {
  it("loads server identity after refresh and passes it without language guessing", async () => {
    vi.spyOn(client, "apiRequest").mockResolvedValue({ task_state: { task: { task_id: "task-1", status: "partial" } } });
    const onResume = vi.fn();
    render(<TaskResumeControl workspaceId="ws" sessionId="s" running={false} onResume={onResume} />);
    fireEvent.click(await screen.findByTestId("resume-task-btn"));
    expect(onResume).toHaveBeenCalledWith(expect.any(String), { resume_task_id: "task-1" });
  });

  it("cannot dispatch an old session identity when a delayed fetch returns", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    vi.spyOn(client, "apiRequest")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ task_state: { task: { task_id: "task-2", status: "completed" } } });
    const onResume = vi.fn();
    const { rerender } = render(<TaskResumeControl workspaceId="ws" sessionId="old" running={false} onResume={onResume} />);
    rerender(<TaskResumeControl workspaceId="ws" sessionId="new" running={false} onResume={onResume} />);
    await screen.findByTestId("resume-task-btn");
    await act(async () => { resolveOld({ task_state: { task: { task_id: "task-old", status: "partial" } } }); });
    fireEvent.click(screen.getByTestId("resume-task-btn"));
    expect(onResume).toHaveBeenCalledWith(expect.any(String), { resume_task_id: "task-2" });
    rerender(<TaskResumeControl workspaceId="ws" sessionId="new" running onResume={onResume} />);
    await waitFor(() => expect(screen.queryByTestId("resume-task-btn")).not.toBeInTheDocument());
  });
});
