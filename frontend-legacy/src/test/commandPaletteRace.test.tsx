import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "../components/CommandPalette";
import { MemoryRouter } from "../router";
import { NAV_ITEMS } from "../config/nav";
import { sessionsApi } from "../api";
import { useSessionStore, useUIStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";
import type { Session } from "../types";

/**
 * Regression for the quick-jump session race: results belong only to the
 * current open cycle and the current workspace. Each sessionsApi.list call
 * gets a manually controlled promise so the tests decide the exact order in
 * which requests settle; the mocked API ignores the abort signal on purpose,
 * so a late callback really does fire and must be ignored by the component.
 */
type ListResult = Awaited<ReturnType<typeof sessionsApi.list>>;
interface Deferred { workspaceId: string; signal?: AbortSignal; resolve: (v: ListResult) => void; reject: (e: unknown) => void }

const session = (id: string, title: string, workspace: string): Session =>
  ({ session_id: id, workspace_id: workspace, title, status: "active", created_at: "", updated_at: "", message_count: 0 } as Session);
const sessionsOf = (workspace: string, title: string) => ({ sessions: [session(`${workspace}-1`, title, workspace)] } as unknown as ListResult);

let calls: Deferred[] = [];

function Palette({ open }: { open: boolean }) {
  return <MemoryRouter initialEntries={["/workbench"]}><CommandPalette open={open} onClose={() => {}} items={NAV_ITEMS} /></MemoryRouter>;
}
const sessionOption = (name: string) => screen.queryByRole("option", { name: new RegExp(name) });
const setWorkspace = (id: string) => act(() => { useSessionStore.setState({ currentWorkspaceId: id, currentSessionId: null }); });

describe("command palette session isolation", () => {
  beforeEach(() => {
    calls = [];
    useSessionStore.getState().reset();
    useSessionStore.setState({ currentWorkspaceId: "ws-a", currentSessionId: null });
    useWorkbenchStore.setState({ bySession: {}, currentSessionId: null });
    useUIStore.setState({ theme: "light" });
    vi.spyOn(sessionsApi, "list").mockImplementation(((workspaceId: string, _status?: string, signal?: AbortSignal) =>
      new Promise<ListResult>((resolve, reject) => { calls.push({ workspaceId, signal, resolve, reject }); })) as typeof sessionsApi.list);
  });
  afterEach(() => vi.restoreAllMocks());

  it("hides and refuses workspace A sessions while workspace B is still loading", async () => {
    render(<Palette open />);
    await act(async () => calls[0].resolve(sessionsOf("ws-a", "A 区核心排查")));
    const staleOption = screen.getByRole("option", { name: /A 区核心排查/ });

    // Switch the store without flushing React first, then click the row that is
    // still in the DOM: the selection guard must reject the stale tag.
    useSessionStore.setState({ currentWorkspaceId: "ws-b", currentSessionId: null });
    fireEvent.click(staleOption);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useWorkbenchStore.getState().currentSessionId).toBeNull();

    await act(async () => {});
    expect(calls).toHaveLength(2);
    expect(calls[1].workspaceId).toBe("ws-b");
    expect(calls[0].signal?.aborted).toBe(true);
    // B pending: nothing from A is displayed or reachable with the keyboard.
    expect(sessionOption("A 区核心排查")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "A 区" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it("ignores a late success from workspace A after B has loaded", async () => {
    render(<Palette open />);
    setWorkspace("ws-b");
    await act(async () => calls[1].resolve(sessionsOf("ws-b", "B 区防火墙评审")));
    expect(sessionOption("B 区防火墙评审")).not.toBeNull();
    await act(async () => calls[0].resolve(sessionsOf("ws-a", "A 区核心排查")));
    expect(sessionOption("A 区核心排查")).toBeNull();
    expect(sessionOption("B 区防火墙评审")).not.toBeNull();
  });

  it("ignores a late cancel or failure from workspace A after B has loaded", async () => {
    render(<Palette open />);
    setWorkspace("ws-b");
    await act(async () => calls[1].resolve(sessionsOf("ws-b", "B 区防火墙评审")));
    await act(async () => calls[0].reject(new DOMException("aborted", "AbortError")));
    expect(sessionOption("B 区防火墙评审")).not.toBeNull();
  });

  it("ignores A's failure while B is still pending, then shows B", async () => {
    render(<Palette open />);
    setWorkspace("ws-b");
    await act(async () => calls[0].reject(new Error("network")));
    await act(async () => calls[1].resolve(sessionsOf("ws-b", "B 区防火墙评审")));
    expect(sessionOption("B 区防火墙评审")).not.toBeNull();
  });

  it("does not resurrect the previous list on close and reopen", async () => {
    const { rerender } = render(<Palette open />);
    await act(async () => calls[0].resolve(sessionsOf("ws-a", "A 区核心排查")));
    expect(sessionOption("A 区核心排查")).not.toBeNull();
    rerender(<Palette open={false} />);
    setWorkspace("ws-b");
    rerender(<Palette open />);
    expect(calls.at(-1)?.workspaceId).toBe("ws-b");
    expect(sessionOption("A 区核心排查")).toBeNull();

    // Same workspace, closed and reopened again: the earlier cycle's rows stay gone
    // until this cycle's own request answers.
    await act(async () => calls.at(-1)!.resolve(sessionsOf("ws-b", "B 区防火墙评审")));
    rerender(<Palette open={false} />);
    rerender(<Palette open />);
    expect(sessionOption("B 区防火墙评审")).toBeNull();
    const pendingReopen = calls.at(-1)!;
    await act(async () => calls[1].resolve(sessionsOf("ws-b", "B 区旧周期")));
    expect(sessionOption("B 区旧周期")).toBeNull();
    await act(async () => pendingReopen.resolve(sessionsOf("ws-b", "B 区防火墙评审")));
    expect(sessionOption("B 区防火墙评审")).not.toBeNull();
  });

  it("shows no sessions and sends no request without a workspace", async () => {
    render(<Palette open />);
    await act(async () => calls[0].resolve(sessionsOf("ws-a", "A 区核心排查")));
    expect(sessionOption("A 区核心排查")).not.toBeNull();
    setWorkspace("");
    expect(sessionOption("A 区核心排查")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(screen.getAllByRole("option").every((el) => !el.textContent?.includes("条消息"))).toBe(true);
  });
});
