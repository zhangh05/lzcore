import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../app/App";
import { enqueue, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore, useUIStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";

describe("Unified Clean Layout & Sidebar Control", () => {
  beforeEach(() => {
    resetMocks();
    installMockApi();
    useSessionStore.getState().reset();
    useWorkbenchStore.setState({ bySession: {}, currentSessionId: null });
    useUIStore.setState({
      sidebarOpen: true,
      taskProgressOpen: true,
      theme: "light",
    });
  });

  it("manages sidebarOpen and taskProgressOpen in useUIStore", () => {
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().taskProgressOpen).toBe(true);

    act(() => {
      useUIStore.getState().toggleSidebar();
    });
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    act(() => {
      useUIStore.getState().toggleTaskProgress();
    });
    expect(useUIStore.getState().taskProgressOpen).toBe(false);

    act(() => {
      useUIStore.getState().setTaskProgressOpen(true);
    });
    expect(useUIStore.getState().taskProgressOpen).toBe(true);
  });

  it("places sidebar toggle at top-left brand zone and keeps top-right header clean & invariant", async () => {
    enqueue("/workspaces", {
      status: 200,
      data: {
        workspaces: [
          { workspace_id: "default", name: "default", is_default: true, created_at: "", stats: { session_count: 0, artifact_count: 0, knowledge_source_count: 0 } },
        ],
      },
    });
    enqueue("/version", { status: 200, data: { version: "3.1.0" } });
    enqueue("/runtime/summary", {
      status: 200,
      data: {
        capabilities: { total: 5, enabled: 5, planned: 0 },
        tools: { registered: 40, model_visible: 40 },
      },
    });
    enqueue("/sessions", { status: 200, data: { sessions: [] } });
    enqueue("/runs/recent", { status: 200, data: { runs: [] } });

    render(<App />);

    // Wait for App to mount and load
    await waitFor(() => {
      expect(useSessionStore.getState().currentWorkspaceId).toBe("default");
    });

    // 1. Sidebar toggle is in top-left brand-zone
    const leftToggle = screen.getByTestId("btn-toggle-sidebar");
    expect(leftToggle).toBeInTheDocument();
    expect(leftToggle.closest(".brand-zone")).not.toBeNull();

    // 2. Top-right actions container does NOT contain sidebar toggle (no jumping/disappearing buttons)
    const appActions = screen.getByLabelText("页面操作");
    expect(appActions).toBeInTheDocument();
    expect(appActions.querySelector('[data-testid="btn-toggle-sidebar"]')).toBeNull();
    expect(appActions.querySelector('[data-testid="btn-toggle-progress-panel"]')).toBeNull();

    // 3. Left toggle is active when sidebar is open
    expect(leftToggle.classList.contains("is-active")).toBe(true);

    // 4. Click left toggle: collapses left sidebar and updates active class
    act(() => {
      fireEvent.click(leftToggle);
    });
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    await waitFor(() => {
      expect(leftToggle.classList.contains("is-active")).toBe(false);
    });

    // 5. Click again: reopens left sidebar
    act(() => {
      fireEvent.click(leftToggle);
    });
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    await waitFor(() => {
      expect(leftToggle.classList.contains("is-active")).toBe(true);
    });
  });
});
