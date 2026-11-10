import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { BrowserRouter } from "../router";
import { installApp } from "./appFixture";

function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  const backend = installApp();
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}
const isPostOnlyGet = (c: { method: string; path: string }) => c.method === "GET" && /\/runs\/[^/]+\/report(\?|$)/.test(c.path);

describe("报告完整可查（A7）", () => {
  it("报告列表来自 GET /api/workspaces/<ws>/reports；正文来自 …/reports/<id>/content", async () => {
    const { calls } = renderAt("/tasks?ws=ws-demo-1&tab=reports");
    const table = await screen.findByTestId("reports-table");
    expect(await within(table).findByText("周报运行报告")).toBeInTheDocument();
    fireEvent.click(within(table).getByTestId("report-open-rep-1"));
    const reader = await screen.findByTestId("report-reader");
    expect(await within(reader).findByTestId("report-content")).toHaveTextContent("已汇总两份");
    expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/api/workspaces/ws-demo-1/reports/rep-1/content"))).toBe(true);
    expect(new URLSearchParams(window.location.search).get("report")).toBe("rep-1");
  });

  it("敏感报告：403 说明原因，可显式声明读取敏感内容（allow_sensitive=1）", async () => {
    const { calls } = renderAt("/tasks?ws=ws-demo-1&tab=reports&report=rep-s");
    const reader = await screen.findByTestId("report-reader");
    expect(await within(reader).findByTestId("report-forbidden")).toHaveTextContent("content not accessible");
    fireEvent.click(within(reader).getByTestId("report-allow-sensitive"));
    expect(await within(reader).findByTestId("report-content")).toHaveTextContent("敏感正文");
    expect(calls.some((c) => c.path.includes("/reports/rep-s/content") && c.path.includes("allow_sensitive=1"))).toBe(true);
  });

  it("运行详情「报告」页：按 run_id 列出并可读正文，不 GET POST-only 的 /runs/<id>/report", async () => {
    const { calls } = renderAt("/tasks?ws=ws-demo-1&tab=runs&run=run-a");
    const detail = await screen.findByTestId("run-detail");
    fireEvent.click(within(detail).getByRole("tab", { name: "报告" }));
    const list = await within(detail).findByTestId("run-reports-table");
    expect(await within(list).findByText("周报运行报告")).toBeInTheDocument();
    expect(within(list).queryByText("机密报告")).toBeNull();
    fireEvent.click(within(list).getByTestId("report-open-rep-1"));
    expect(await screen.findByTestId("report-content")).toHaveTextContent("已汇总两份");
    expect(calls.filter(isPostOnlyGet)).toEqual([]);
  });

  it("请求生成报告：POST 受理后回读列表，写「已受理」而不是「已生成」", async () => {
    const { calls, log } = renderAt("/tasks?ws=ws-demo-1&tab=runs&run=run-a");
    const detail = await screen.findByTestId("run-detail");
    fireEvent.click(within(detail).getByRole("tab", { name: "报告" }));
    await within(detail).findByTestId("run-reports-table");
    fireEvent.click(within(detail).getByTestId("run-report-create"));
    await waitFor(() => expect(log.some((l) => l.method === "POST" && l.path.startsWith("/api/workspaces/ws-demo-1/runs/run-a/report"))).toBe(true));
    expect(await within(detail).findByTestId("run-report-readback")).toHaveTextContent("回读：列表中出现新报告");
    expect(detail.textContent).toContain("不代表报告已生成");
    expect(detail.textContent).not.toMatch(/报告已生成成功|生成成功/);
    expect(calls.filter(isPostOnlyGet)).toEqual([]);
  });
});
