/**
 * Diagnostics → 写操作账本: resolving an unknown-outcome operation goes through
 * the in-app form dialog (reason) and then the in-app confirm dialog. The API
 * receives exactly the same arguments as before; cancelling at either step
 * sends nothing, and the native window.prompt / window.confirm are never used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "../router";
import { Diagnostics } from "../pages/Diagnostics/Diagnostics";
import { ConfirmHost } from "../components/ConfirmDialog";
import { FormDialogHost, promptForm } from "../components/FormDialog";
import { operationLedgerApi } from "../api";
import { scopedLocalStorageKey, setActiveUserScope } from "../utils/userScope";
import { useSessionStore } from "../stores/session";

const OP_ID = "op_1234567890abcdef12345678";

function seedCache(scope: string) {
  useSessionStore.setState({ currentWorkspaceId: "default" });
  setActiveUserScope(scope, "default");
  localStorage.setItem(scopedLocalStorageKey("diagnostics_v1"), JSON.stringify({
    ts: "2026-08-23T00:00:00.000Z",
    health: { summary: { ok: 1, warning: 0, error: 0 }, components: [{ name: "agent", status: "ok" }] },
    selfcheck: { status: "healthy", issues: [] },
    usage: { call_count: 1, total_tokens: 10, input_tokens: 6, output_tokens: 4, estimated_cost: 0, last_updated: "2026-08-23T00:00:00.000Z" },
    contextOk: true,
    prompts: [], retention: {}, archive: {},
    operations: {
      counts: { unknown: 1, running: 0, failed: 0 },
      operations: [{ operation_id: OP_ID, canonical_tool: "agent.manage", status: "unknown", error_code: "TOOL_TIMEOUT_UNCERTAIN", planned_at: "2026-08-15T18:02:19Z" }],
    },
  }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Diagnostics />
      <ConfirmHost />
      <FormDialogHost />
    </MemoryRouter>,
  );
}

let promptSpy: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.fn>;
let resolveSpy: ReturnType<typeof vi.spyOn>;
let listSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  promptSpy = vi.fn(() => "native reason");
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal("prompt", promptSpy);
  vi.stubGlobal("confirm", confirmSpy);
  resolveSpy = vi.spyOn(operationLedgerApi, "resolve").mockResolvedValue({ ok: true, operation_id: OP_ID, status: "succeeded", resolved_by: "admin" });
  listSpy = vi.spyOn(operationLedgerApi, "list").mockResolvedValue({ ok: true, operations: [], count: 0, counts: { unknown: 0, running: 0, failed: 0 } });
});

afterEach(() => {
  expect(promptSpy).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Diagnostics unknown-operation resolution dialogs", () => {
  it("sends the same resolve arguments, then refreshes the ledger, only after reason + confirmation", async () => {
    const user = userEvent.setup();
    seedCache("ResolveConfirm");
    renderPage();

    await user.click(screen.getByRole("button", { name: "核对为成功" }));
    const dialog = await screen.findByRole("dialog", { name: "核对为成功" });
    const field = screen.getByLabelText("核对依据");
    expect(field).toHaveFocus();
    expect(dialog).toHaveTextContent(OP_ID);

    await user.type(field, "  已登录设备核对配置  ");
    await user.keyboard("{Enter}");

    const confirmDialog = await screen.findByTestId("confirm-dialog");
    expect(confirmDialog).toHaveTextContent("确认已核对外部事实，并将该操作标记为“已成功完成”？");
    expect(confirmDialog).toHaveTextContent("核对依据：已登录设备核对配置");
    expect(resolveSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "标记为成功" }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith("default"));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith("default", OP_ID, "succeeded", "已登录设备核对配置");
    expect(resolveSpy.mock.invocationCallOrder[0]).toBeLessThan(listSpy.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.getByText("无待核对项")).toBeInTheDocument());
  });

  it("passes the failed status through unchanged", async () => {
    const user = userEvent.setup();
    seedCache("ResolveFailed");
    renderPage();

    await user.click(screen.getByRole("button", { name: "核对为失败" }));
    await user.type(await screen.findByLabelText("核对依据"), "设备拒绝了变更");
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByTestId("confirm-dialog")).toHaveTextContent("标记为“执行失败”");
    await user.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledWith("default", OP_ID, "failed", "设备拒绝了变更"));
  });

  it("sends nothing when the reason dialog is cancelled with Escape, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    seedCache("ResolveEscape");
    renderPage();

    const trigger = screen.getByRole("button", { name: "核对为成功" });
    await user.click(trigger);
    await user.type(await screen.findByLabelText("核对依据"), "写了一半");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("form-dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the reason dialog is cancelled with its button", async () => {
    const user = userEvent.setup();
    seedCache("ResolveCancelButton");
    renderPage();

    await user.click(screen.getByRole("button", { name: "核对为失败" }));
    await user.type(await screen.findByLabelText("核对依据"), "不确定");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("form-dialog")).not.toBeInTheDocument());
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the confirmation step is cancelled", async () => {
    const user = userEvent.setup();
    seedCache("ResolveConfirmCancel");
    renderPage();

    await user.click(screen.getByRole("button", { name: "核对为成功" }));
    await user.type(await screen.findByLabelText("核对依据"), "已核对");
    await user.keyboard("{Enter}");
    await screen.findByTestId("confirm-dialog");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with an inline error for an empty or whitespace reason", async () => {
    const user = userEvent.setup();
    seedCache("ResolveValidation");
    renderPage();

    await user.click(screen.getByRole("button", { name: "核对为成功" }));
    const field = await screen.findByLabelText("核对依据");
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写核对依据后再继续。");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();

    await user.type(field, "   ");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("form-dialog")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(resolveSpy).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
  });
});

describe("FormDialog primitive", () => {
  it("Shift+Enter inserts a newline, Enter submits, and Tab stays inside the dialog", async () => {
    const user = userEvent.setup();
    render(<FormDialogHost />);
    let result: Promise<string | null> = Promise.resolve(null);
    act(() => { result = promptForm({ title: "说明", label: "原因", multiline: true }); });
    const field = await screen.findByLabelText("原因");
    await user.type(field, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(field, "第二行");
    expect(screen.getByTestId("form-dialog")).toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "确定" })).toHaveFocus();
    await user.tab();
    expect(field).toHaveFocus();

    await user.keyboard("{Enter}");
    await expect(result).resolves.toBe("第一行\n第二行");
  });

  it("resolves null on Escape", async () => {
    const user = userEvent.setup();
    render(<FormDialogHost />);
    let result: Promise<string | null> = Promise.resolve("x");
    act(() => { result = promptForm({ title: "说明", label: "原因" }); });
    await user.type(await screen.findByLabelText("原因"), "abc");
    await user.keyboard("{Escape}");
    await expect(result).resolves.toBeNull();
  });
});
