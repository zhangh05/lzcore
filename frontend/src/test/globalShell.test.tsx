import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../layouts/Sidebar";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmHost } from "../components/ConfirmDialog";
import { ToastHost } from "../components/ToastHost";
import { Button } from "../components/ui/Button";
import { DetailPanel } from "../components/ui/DetailPanel";
import { MemoryRouter } from "../router";
import { NAV_ITEMS } from "../config/nav";
import { enqueue, getRequests, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore, useUIStore } from "../stores/session";
import { useToastStore } from "../stores/toast";
import { useWorkbenchStore } from "../stores/workbench";

const session = (id: string, title: string) => ({ session_id: id, workspace_id: "default", title, status: "active", created_at: "", updated_at: "", message_count: 0 });
const sessions = [session("s-1", "园区核心 OSPF 排查"), session("s-2", "防火墙策略评审"), session("s-3", "UPS 告警复盘"), session("s-4", "STP 根桥调整"), session("s-5", "资产清单核对")];
const workspaces = { status: 200, data: { workspaces: [{ workspace_id: "default", name: "default", is_default: true, created_at: "", stats: { session_count: 5, artifact_count: 0, knowledge_source_count: 0 } }] } };

describe("global shell", () => {
  beforeEach(() => {
    resetMocks();
    installMockApi();
    useSessionStore.getState().reset();
    useSessionStore.setState({ currentWorkspaceId: "default" });
    useWorkbenchStore.setState({ bySession: {}, currentSessionId: null });
    useUIStore.setState({ sidebarOpen: true, theme: "light", density: "comfortable" });
  });

  it("filters recent sessions locally and clears the filter with Escape", async () => {
    enqueue("/workspaces", workspaces);
    enqueue("/sessions", { status: 200, data: { sessions } });
    enqueue("/runs/recent", { status: 200, data: { runs: [] } });
    render(<Sidebar />);
    const filter = await screen.findByTestId("sidebar-session-filter");
    await screen.findByTestId("sess-s-1");
    fireEvent.change(filter, { target: { value: "ups" } });
    expect(screen.getByTestId("sess-s-3")).toBeInTheDocument();
    expect(screen.queryByTestId("sess-s-1")).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "不存在" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配");
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(screen.getByTestId("sess-s-1")).toBeInTheDocument();
    // Filtering is a view concern only: no extra list requests were made.
    expect(getRequests().filter((r) => r.url === "/sessions")).toHaveLength(1);
  });

  it("confirms permanent session deletion in the product dialog and does nothing on cancel", async () => {
    const native = vi.fn(() => true);
    vi.stubGlobal("confirm", native);
    enqueue("/workspaces", workspaces);
    enqueue("/sessions", { status: 200, data: { sessions } });
    enqueue("/runs/recent", { status: 200, data: { runs: [] } });
    render(<><Sidebar /><ConfirmHost /></>);
    const trigger = await screen.findByTestId("session-menu-trigger-s-2");
    fireEvent.click(trigger);
    fireEvent.click(within(trigger.closest("details")!).getByRole("menuitem", { name: "永久删除" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("永久删除会话");
    expect(dialog).toHaveTextContent("防火墙策略评审");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
    expect(native).not.toHaveBeenCalled();
    expect(getRequests().some((r) => r.method?.toUpperCase() === "DELETE")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("opens a keyboard jump list that navigates without writing", async () => {
    enqueue("/sessions", { status: 200, data: { sessions } });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={["/workbench"]}><CommandPalette open onClose={onClose} items={NAV_ITEMS} /></MemoryRouter>);
    const input = screen.getByRole("combobox", { name: "搜索页面、会话或偏好" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "快速跳转" })).toBeInTheDocument();
    await screen.findByRole("option", { name: /园区核心 OSPF 排查/ });
    await user.type(input, "防火墙");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(useSessionStore.getState().currentSessionId).toBe("s-2");
    expect(onClose).toHaveBeenCalled();
    expect(getRequests().every((r) => (r.method ?? "GET").toUpperCase() === "GET")).toBe(true);
  });

  it("closes the jump list with Escape", async () => {
    enqueue("/sessions", { status: 200, data: { sessions: [] } });
    const onClose = vi.fn();
    render(<MemoryRouter><CommandPalette open onClose={onClose} items={NAV_ITEMS} /></MemoryRouter>);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("announces failures assertively and confirmations politely", () => {
    render(<ToastHost />);
    act(() => {
      useToastStore.getState().show({ kind: "error", title: "保存失败" });
      useToastStore.getState().show({ kind: "success", title: "已保存" });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("marks loading buttons busy and blocks repeat clicks", () => {
    const click = vi.fn();
    render(<Button variant="primary" loading onClick={click}>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveClass("btn", "primary", "is-loading");
    fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });

  it("renders detail panel titles as second-level headings under the page title", () => {
    render(<DetailPanel title="设备资产清单.csv">内容</DetailPanel>);
    expect(screen.getByRole("heading", { level: 2, name: "设备资产清单.csv" })).toBeInTheDocument();
  });

  it("keeps display density a UI-only preference, separate from session and workspace state", () => {
    useSessionStore.setState({ currentWorkspaceId: "ws-a" });
    useSessionStore.getState().setCurrentSession("s-1");
    const before = { ...useSessionStore.getState() };
    useUIStore.getState().setDensity("compact");
    expect(useUIStore.getState().density).toBe("compact");
    expect(useSessionStore.getState().currentSessionId).toBe(before.currentSessionId);
    expect(useSessionStore.getState().currentWorkspaceId).toBe("ws-a");
    const persisted = JSON.parse(localStorage.getItem("lzcore_ui") || "{}").state ?? {};
    expect(persisted.density).toBe("compact");
    expect(persisted).not.toHaveProperty("currentSessionId");
    expect(persisted).not.toHaveProperty("currentWorkspaceId");
    useUIStore.getState().setDensity("comfortable");
  });
});
