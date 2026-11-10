/**
 * Diagnostics → 写操作账本: the two-step resolve (reason → confirmation → resolve
 * → list) belongs to the workspace and page lifecycle it was opened in. A
 * workspace switch or leaving the page cancels an open step and nothing is sent;
 * an already-sent resolve is never replayed and its late response / follow-up
 * list never lands in the new scope. Same contract as 3420acf.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "../router";
import { Diagnostics } from "../pages/Diagnostics/Diagnostics";
import { ConfirmHost } from "../components/ConfirmDialog";
import { FormDialogHost } from "../components/FormDialog";
import { operationLedgerApi } from "../api";
import { scopedLocalStorageKey, setActiveUserScope } from "../utils/userScope";
import { useSessionStore } from "../stores/session";

const OP_ID = "op_scope_0000000000000000001";

function seedCache(scope: string) {
  useSessionStore.setState({ currentWorkspaceId: "ws-a" });
  setActiveUserScope(scope, "ws-a");
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

/** Hosts stay mounted (they live in App); only the page comes and goes. */
function Tree({ page = true }: { page?: boolean }) {
  return (
    <MemoryRouter>
      {page && <Diagnostics />}
      <ConfirmHost />
      <FormDialogHost />
    </MemoryRouter>
  );
}

let resolveSpy: ReturnType<typeof vi.spyOn>;
let listSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resolveSpy = vi.spyOn(operationLedgerApi, "resolve").mockResolvedValue({ ok: true, operation_id: OP_ID, status: "succeeded", resolved_by: "admin" });
  listSpy = vi.spyOn(operationLedgerApi, "list").mockResolvedValue({ ok: true, operations: [], count: 0, counts: { unknown: 0, running: 0, failed: 0 } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openReason(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "核对为成功" }));
  await user.type(await screen.findByLabelText("核对依据"), "已登录设备核对配置");
}

async function toConfirmStep(user: ReturnType<typeof userEvent.setup>) {
  await openReason(user);
  await user.keyboard("{Enter}");
  await screen.findByTestId("confirm-dialog");
}

function switchWorkspace() {
  act(() => { useSessionStore.setState({ currentWorkspaceId: "ws-b" }); });
}

describe("Diagnostics resolve flow is bound to its workspace and page lifecycle", () => {
  it("workspace switch during the reason step closes it and sends nothing", async () => {
    const user = userEvent.setup();
    seedCache("ScopeStep1");
    render(<Tree />);
    await openReason(user);

    switchWorkspace();

    await waitFor(() => expect(screen.queryByTestId("form-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("无待核对项")).not.toBeInTheDocument();
  });

  it("workspace switch during the confirmation step closes it and sends nothing", async () => {
    const user = userEvent.setup();
    seedCache("ScopeStep2");
    render(<Tree />);
    await toConfirmStep(user);

    switchWorkspace();

    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("无待核对项")).not.toBeInTheDocument();
  });

  it("leaving the page during the reason step closes it and sends nothing", async () => {
    const user = userEvent.setup();
    seedCache("UnmountStep1");
    const view = render(<Tree />);
    await openReason(user);

    view.rerender(<Tree page={false} />);

    await waitFor(() => expect(screen.queryByTestId("form-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("leaving the page during the confirmation step closes it and sends nothing", async () => {
    const user = userEvent.setup();
    seedCache("UnmountStep2");
    const view = render(<Tree />);
    await toConfirmStep(user);

    view.rerender(<Tree page={false} />);

    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument());
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("an in-flight resolve is not replayed, and its late response / list(A) never lands in B", async () => {
    const user = userEvent.setup();
    seedCache("InFlight");
    let finishResolve: (value: Awaited<ReturnType<typeof operationLedgerApi.resolve>>) => void = () => {};
    resolveSpy.mockImplementation(() => new Promise((done) => { finishResolve = done; }));
    render(<Tree />);
    await toConfirmStep(user);
    await user.click(screen.getByRole("button", { name: "标记为成功" }));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    expect(resolveSpy).toHaveBeenCalledWith("ws-a", OP_ID, "succeeded", "已登录设备核对配置");

    switchWorkspace();
    await act(async () => {
      finishResolve({ ok: true, operation_id: OP_ID, status: "succeeded", resolved_by: "admin" });
    });

    // The sent write is reconciled by the server, never resent; no list(A) and
    // no A data committed into the page that is now showing B.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("无待核对项")).not.toBeInTheDocument();
    // The page is usable in B: the resolve buttons are not left locked by A's cycle.
    expect(screen.getByRole("button", { name: "核对为成功" })).toBeEnabled();
  });

  it("an in-flight list(A) that resolves after the switch is not committed", async () => {
    const user = userEvent.setup();
    seedCache("InFlightList");
    let finishList: (value: Awaited<ReturnType<typeof operationLedgerApi.list>>) => void = () => {};
    listSpy.mockImplementation(() => new Promise((done) => { finishList = done; }));
    render(<Tree />);
    await toConfirmStep(user);
    await user.click(screen.getByRole("button", { name: "标记为成功" }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith("ws-a"));

    switchWorkspace();
    await act(async () => {
      finishList({ ok: true, operations: [], count: 0, counts: { unknown: 0, running: 0, failed: 0 } });
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("无待核对项")).not.toBeInTheDocument();
  });
});
