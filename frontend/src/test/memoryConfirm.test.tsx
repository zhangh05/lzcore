import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryPage } from "../pages/MemoryPage/MemoryPage";
import { ConfirmHost } from "../components/ConfirmDialog";
import { enqueue, getRequests, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore } from "../stores/session";

const records = [
  { memory_id: "mem-a", title: "变更窗口", content: "周二、周四 22:00 后执行", status: "active", memory_type: "core_rule", scope: "workspace" },
  { memory_id: "mem-b", title: "回答风格", content: "先给结论", status: "active", memory_type: "semantic_fact", scope: "global" },
];
const list = () => ({ status: 200, data: { ok: true, records, total: 2 } });
const deletes = () => getRequests().filter((request) => request.method === "DELETE" || request.url === "/memory/batch-delete");

describe("memory destructive actions", () => {
  beforeEach(() => {
    resetMocks(); installMockApi();
    useSessionStore.setState({ currentWorkspaceId: "default" });
    enqueue("/memory/list", list()); enqueue("/memory/list", list());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("asks through the accessible dialog before a batch delete, never window.confirm", async () => {
    // A native confirm that would approve everything: the page must not use it.
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    const user = userEvent.setup();
    render(<><MemoryPage /><ConfirmHost /></>);
    await user.click(await screen.findByRole("checkbox", { name: "选择记忆：变更窗口" }));
    expect(screen.getByRole("group", { name: "批量操作" })).toHaveTextContent("已选 1 条");

    await user.click(screen.getByRole("button", { name: "删除 1 条" }));
    const dialog = await screen.findByRole("dialog", { name: "永久删除选中的 1 条记忆？" });
    expect(dialog).toHaveAccessibleDescription("此操作不可逆，删除后无法从历史中找回。");
    // Focus starts on Cancel so a stray Enter cannot delete.
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(deletes()).toHaveLength(0);

    enqueue("/memory/batch-delete", { status: 200, data: { ok: true, deleted_count: 1, requested: 1 } });
    await user.click(screen.getByRole("button", { name: "删除 1 条" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
    await screen.findByText("已删除 1 条");
    expect(deletes()).toEqual([expect.objectContaining({ url: "/memory/batch-delete", data: expect.objectContaining({ memory_ids: ["mem-a"] }) })]);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("confirms a single delete in the dialog and Escape cancels it", async () => {
    const user = userEvent.setup();
    render(<><MemoryPage /><ConfirmHost /></>);
    await user.click(await screen.findByRole("button", { name: "永久删除：回答风格" }));
    expect(await screen.findByRole("dialog", { name: "永久删除这条记忆？" })).toHaveTextContent("「回答风格」将被永久删除");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "永久删除：回答风格" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
    await screen.findByText("已永久删除");
    expect(deletes()).toEqual([expect.objectContaining({ method: "DELETE", url: "/memory/mem-b" })]);
  });
});
