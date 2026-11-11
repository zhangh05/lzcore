import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { cancelLabel, jobQueueLabel } from "../contracts/outcomeState";
import { runtimeActionGate } from "../pages/tasks/model";
import { BrowserRouter } from "../router";
import { installApp, type AppFixtureOptions } from "./appFixture";

function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const backend = installApp(opts);
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}

describe("任务中心（阶段 3）", () => {
  it("主视图来自 runtime tasks；说明该接口不含 execution_outcome（数据源问题）", async () => {
    renderAt("/tasks?ws=ws-demo-1");
    expect(await screen.findByTestId("outcome-missing-note")).toHaveTextContent("执行结束不代表目标完成");
    const table = await screen.findByTestId("runtime-tasks");
    expect(within(table).getAllByText("结论未上报（该接口不含 execution_outcome）").length).toBe(2);
    expect(table.textContent).not.toMatch(/完成|成功/);
  });

  it("详情从会话 task-state 读未知项：结果未知 · 需核对，续接与步骤重试被门控", async () => {
    renderAt("/tasks?ws=ws-demo-1&task=t-unknown");
    expect(await screen.findByTestId("task-unknown")).toHaveTextContent("结果未知 · 需核对");
    expect(screen.getByTestId("task-resume")).toBeDisabled();
    fireEvent.click(within(screen.getByTestId("task-detail")).getByText("步骤"));
    expect(await screen.findByTestId("step-retry")).toBeDisabled();
  });

  it("无未知项的失败任务：可以续接 / 重试步骤", async () => {
    renderAt("/tasks?ws=ws-demo-1&task=t-partial");
    await screen.findByTestId("task-detail");
    await waitFor(() => expect(screen.getByTestId("task-resume")).not.toBeDisabled());
  });

  it("映射一：job failed + active_turn.unknown_outcome → 需核对、重试禁用", async () => {
    renderAt("/tasks?ws=ws-demo-1", { jobs: "mapping1" });
    const col = await screen.findByTestId("jobs-column");
    const item = await within(col).findByText("job-lease");
    const li = item.closest("li")!;
    expect(within(li).getByTestId("job-goal")).toHaveTextContent("结果未知 · 需核对");
    expect(within(li).getByTestId("job-retry")).toBeDisabled();
    expect(within(li).getByTestId("job-unknown")).toBeInTheDocument();
  });

  it("明确失败的作业：重试经确认框，列出将重放的内容", async () => {
    const { log } = renderAt("/tasks?ws=ws-demo-1");
    const li = (await screen.findByText("job-plain")).closest("li")!;
    fireEvent.click(within(li).getByTestId("job-retry"));
    const dialog = await screen.findByTestId("job-retry-dialog");
    expect(dialog).toHaveTextContent("weekly");
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.some((l) => l.path.startsWith("/api/jobs/job-plain/retry"))).toBe(true));
  });

  it("删除作业：DELETE <job_id>；批量：DELETE JOBS a,b", async () => {
    const { log } = renderAt("/tasks?ws=ws-demo-1");
    const li = (await screen.findByText("job-plain")).closest("li")!;
    fireEvent.click(within(li).getByTestId("job-delete"));
    let dialog = await screen.findByTestId("job-delete-dialog");
    expect(dialog).toHaveTextContent("DELETE job-plain");
    fireEvent.change(within(dialog).getByTestId("confirm-text"), { target: { value: "DELETE job-plain" } });
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.find((l) => l.method === "DELETE" && l.path.startsWith("/api/jobs/job-plain"))?.body).toMatchObject({ confirmation: "DELETE job-plain" }));
    fireEvent.click(screen.getByLabelText("选择 job-plain"));
    fireEvent.click(screen.getByLabelText("选择 job-ok"));
    fireEvent.click(screen.getByTestId("jobs-batch-delete"));
    dialog = await screen.findByTestId("job-delete-dialog");
    fireEvent.change(within(dialog).getByTestId("confirm-text"), { target: { value: "DELETE JOBS job-ok,job-plain" } });
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.find((l) => l.path.startsWith("/api/jobs/batch-delete"))?.body).toMatchObject({ confirmation: "DELETE JOBS job-ok,job-plain", job_ids: ["job-ok", "job-plain"] }));
  });

  it("受理 / 入队文案与「完成」分开；cancel_requested 不是「已终止任务」", () => {
    expect(jobQueueLabel("queued")).toBe("已入队");
    expect(jobQueueLabel("succeeded")).not.toMatch(/完成|成功/);
    expect(cancelLabel("cancel_requested")).not.toBe("已终止任务");
    expect(jobQueueLabel("cancel_requested")).not.toBe("已终止任务");
  });

  it("runtimeActionGate：task-state 不可读也禁用", () => {
    expect(runtimeActionGate("resume", { task_id: "x", status: "failed" }, "unreadable").allowed).toBe(false);
    expect(runtimeActionGate("resume", { task_id: "x", status: "running" }, null).allowed).toBe(false);
    expect(runtimeActionGate("resume", { task_id: "x", status: "failed" }, { unknowns: [] }).allowed).toBe(true);
  });
});

describe("核对详情面板（阶段 3）", () => {
  it("账本：先回读，仍未知才可标记；依据 + RESOLVE <id> 双重确认；回读确认后可续接", async () => {
    const { log } = renderAt("/review?ws=ws-demo-1&source=ledger&id=op1&task=t-unknown&session=s-unknown");
    const panel = await screen.findByTestId("review-detail");
    expect(screen.queryByTestId("begin-mark")).toBeNull();
    fireEvent.click(within(panel).getByTestId("readback-btn"));
    fireEvent.click(await within(panel).findByTestId("begin-mark"));
    fireEvent.click(within(panel).getByLabelText(/已确认写入生效/));
    fireEvent.change(within(panel).getByTestId("mark-reason"), { target: { value: "已在目标目录看到文件" } });
    expect(within(panel).getByTestId("submit-mark")).toBeDisabled();
    fireEvent.change(within(panel).getByTestId("mark-confirm"), { target: { value: "RESOLVE op1" } });
    fireEvent.click(within(panel).getByTestId("submit-mark"));
    expect(await within(panel).findByTestId("marked")).toBeInTheDocument();
    expect(log.find((l) => l.path.includes("/resolve"))?.body).toMatchObject({ confirmation: "RESOLVE op1", status: "succeeded", reason: "已在目标目录看到文件" });
    expect(within(panel).getByTestId("go-resume").getAttribute("href")).toContain("resume_task=t-unknown");
    expect(panel.textContent).not.toMatch(/重试|重发/);
  });

  it("任务来源：回读 task-state，仍有 unknowns 时不提供假的标记接口", async () => {
    renderAt("/review?ws=ws-demo-1&source=task&id=t-unknown&session=s-unknown");
    const panel = await screen.findByTestId("review-detail");
    fireEvent.click(within(panel).getByTestId("readback-btn"));
    await waitFor(() => expect(panel.getAttribute("data-step")).toBe("verified_still_unknown"));
    expect(within(panel).queryByTestId("begin-mark")).toBeNull();
    expect(panel).toHaveTextContent("逐条核对");
  });
});
