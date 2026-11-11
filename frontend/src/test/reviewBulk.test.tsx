import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { BrowserRouter } from "../router";
import { appHandler, type Logged } from "./appFixture";
import { installFixture } from "./backendFixture";
import type { FakeHandler } from "./fakeBackend";
import { ledgerEntries } from "../contracts/reviewInbox";

/** 待核对页：应用夹具（写操作 op1/op2、审阅项 r1/r2、两个未知任务），审阅项 r2 的标记接口返回 404。 */
function renderReview() {
  window.history.replaceState({}, "", "/review?ws=ws-demo-1");
  const log: Logged[] = [];
  const app = appHandler({}, log);
  const extra: FakeHandler = (method, path, body) => {
    const p = path.split("?")[0];
    if (method === "PUT" && p.startsWith("/api/review-items/")) {
      log.push({ method, path, body });
      return p.endsWith("/r2") ? { status: 404, body: { ok: false, errors: ["item_not_found"] } } : { status: 200, body: { ok: true } };
    }
    return app(method, path, body);
  };
  installFixture({}, extra);
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return { log };
}

describe("待核对：批量管理", () => {
  it("按来源筛选、全选后批量标记；任务不在批量范围内，失败逐条列出", async () => {
    const { log } = renderReview();
    const bulk = await screen.findByTestId("review-bulk", {}, { timeout: 4000 });
    await waitFor(() => expect(within(bulk).getAllByRole("row").length).toBeGreaterThan(4));
    expect(within(bulk).getByRole("button", { name: /写操作/ })).toBeInTheDocument();

    fireEvent.click(within(bulk).getByRole("checkbox", { name: "全选" }));
    const bar = screen.getByTestId("bulk-bar");
    expect(bar).toHaveTextContent("已选 6 项");
    expect(bar).toHaveTextContent("其中 2 项不能批量标记");

    fireEvent.click(within(bar).getByTestId("bulk-failed"));
    const dialog = await screen.findByTestId("bulk-dialog");
    expect(dialog).toHaveTextContent("把 4 项标记为「未生效」");
    const submit = within(dialog).getByTestId("bulk-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId("bulk-reason"), { target: { value: "已登录设备核对，未见变更" } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId("bulk-confirm-text"), { target: { value: "标记 4 项" } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    const result = await screen.findByTestId("bulk-result", {}, { timeout: 4000 });
    expect(result).toHaveTextContent("已标记 3 项，1 项未成功");
    expect(result).toHaveTextContent("跳过 2 项");
    expect(result).toHaveTextContent("item_not_found");

    const resolves = log.filter((l) => l.path.includes("/operation-ledger/") && l.path.endsWith("/resolve"));
    expect(resolves).toHaveLength(2);
    expect(resolves.map((l) => l.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: "ws-demo-1", status: "failed", confirmation: "RESOLVE op1", reason: "已登录设备核对，未见变更" }),
      expect.objectContaining({ status: "failed", confirmation: "RESOLVE op2" }),
    ]));
    const reviews = log.filter((l) => l.method === "PUT" && l.path.startsWith("/api/review-items/"));
    expect(reviews).toHaveLength(2);
    expect(reviews[0].path).toMatch(/workspace_id=ws-demo-1/);
    expect(reviews[0].path).toMatch(/artifact_id=a\d/);
    expect(reviews[0].body).toEqual({ status: "modified", user_note: "已登录设备核对，未见变更" });
    // 没有任何重试或任务写入
    expect(log.some((l) => /retry|resume/.test(l.path))).toBe(false);
  });

  it("只选任务时不能批量标记", async () => {
    renderReview();
    const bulk = await screen.findByTestId("review-bulk", {}, { timeout: 4000 });
    fireEvent.click(within(bulk).getByRole("button", { name: /任务/ }));
    await waitFor(() => expect(within(bulk).getAllByRole("row")).toHaveLength(3));
    fireEvent.click(within(bulk).getByRole("checkbox", { name: "全选" }));
    expect(screen.getByTestId("bulk-failed")).toBeDisabled();
    expect(screen.getByTestId("bulk-succeeded")).toBeDisabled();
  });

  it("已阻断的写操作不能批量标记，无法判定的可以", () => {
    const rows = ledgerEntries([
      { operation_id: "a", status: "indeterminate" },
      { operation_id: "b", status: "blocked" },
    ] as never, "ws");
    expect(rows.map((r) => r.markable)).toEqual([true, false]);
  });
});
