import { MemoryRouter } from "../router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgeLibrary } from "../pages/KnowledgeLibrary/KnowledgeLibrary";
import { ConfirmHost } from "../components/ConfirmDialog";
import { knowledgeApi } from "../api";
import { enqueue, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore } from "../stores/session";

const SOURCE = { source_id: "ks-1", title: "交换机手册", enabled: true, chunk_count: 3, created_at: "2026-10-01T00:00:00Z" };

function seed() {
  enqueue("/knowledge/sources", { status: 200, data: { ok: true, sources: [SOURCE], counts: {} } });
  enqueue("/knowledge/search", { status: 200, data: { ok: true, query: "", results: [], count: 0 } });
  enqueue("/workspaces/default/artifacts", { status: 200, data: { artifacts: [] } });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgeLibrary />
      <ConfirmHost />
    </MemoryRouter>,
  );
}

describe("KnowledgeLibrary delete uses the in-app ConfirmDialog", () => {
  const native = vi.fn(() => true);
  beforeEach(() => {
    resetMocks();
    installMockApi();
    useSessionStore.setState({ currentWorkspaceId: "default" });
    seed();
    native.mockClear();
    vi.stubGlobal("confirm", native);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes only after the dialog is confirmed and never calls the native confirm", async () => {
    const remove = vi.spyOn(knowledgeApi, "delete").mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByTestId("btn-delete-ks-1"));
    const dialog = await screen.findByRole("dialog", { name: "删除知识源「交换机手册」？" });
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "删除")!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("ks-1", "default"));
    expect(native).not.toHaveBeenCalled();
  });

  it("cancelling sends no delete request", async () => {
    const remove = vi.spyOn(knowledgeApi, "delete").mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByTestId("btn-delete-ks-1"));
    await screen.findByRole("dialog", { name: "删除知识源「交换机手册」？" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });

  it("a workspace change while the dialog is open cancels it and deletes nothing", async () => {
    const remove = vi.spyOn(knowledgeApi, "delete").mockResolvedValue({ ok: true } as never);
    renderPage();
    fireEvent.click(await screen.findByTestId("btn-delete-ks-1"));
    await screen.findByRole("dialog", { name: "删除知识源「交换机手册」？" });
    enqueue("/knowledge/sources", { status: 200, data: { ok: true, sources: [], counts: {} } });
    act(() => { useSessionStore.setState({ currentWorkspaceId: "ws-b" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});

