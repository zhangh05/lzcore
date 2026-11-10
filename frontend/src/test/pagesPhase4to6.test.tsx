import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { CORE_FORBIDDEN_DOMAIN_WORDS } from "../contracts/naming";
import { ApprovalCard } from "../extension-modules/approval/ApprovalCard";
import { inspectionRetryGate } from "../extension-modules/network-operations/api";
import { userEditDraft } from "../pages/system/SystemPages";
import { BrowserRouter, useNavigationGuard, useNavigate } from "../router";
import { installApp, type AppFixtureOptions } from "./appFixture";

function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const backend = installApp(opts);
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}

describe("资料（阶段 4）", () => {
  it("tab 即路径；记忆冲突有提示与确认", async () => {
    renderAt("/library/memory?ws=ws-demo-1");
    expect(await screen.findByTestId("library-memory")).toBeInTheDocument();
    expect(await screen.findByTestId("memory-conflict-hint")).toHaveTextContent("mem-a");
  });

  it("记忆批量删除带 confirm:true", async () => {
    const { log } = renderAt("/library/memory?ws=ws-demo-1");
    await screen.findByTestId("memory-table");
    fireEvent.click(screen.getByLabelText("选择 mem-a"));
    fireEvent.click(screen.getByTestId("memory-batch-delete"));
    fireEvent.click(within(await screen.findByTestId("memory-batch-dialog")).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.find((l) => l.path.startsWith("/api/memory/batch-delete"))?.body).toMatchObject({ memory_ids: ["mem-a"], confirm: true }));
  });

  it("记忆写入 409 execution_unknown：专门的未知界面", async () => {
    renderAt("/library/memory?ws=ws-demo-1", { conflict: "memory" });
    await screen.findByTestId("memory-table");
    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "新规则" } });
    fireEvent.click(screen.getByTestId("memory-save"));
    expect(await screen.findByTestId("memory-unknown")).toBeInTheDocument();
    expect(screen.getByTestId("memory-save")).toBeDisabled();
  });
});

describe("系统（阶段 5）", () => {
  it("非管理员看到管理页原因，而不是 404；管理员子导航不渲染", async () => {
    renderAt("/system/backups?ws=ws-demo-1", { role: "viewer" });
    expect(await screen.findByTestId("admin-required")).toHaveTextContent("需要管理员权限");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByText("备份与生产")).toBeNull();
  });

  it("备份恢复：确认串 RESTORE", async () => {
    const { log } = renderAt("/system/backups?ws=ws-demo-1", { role: "admin" });
    fireEvent.click(await screen.findByTestId("backup-restore"));
    const dialog = await screen.findByTestId("restore-dialog");
    fireEvent.change(within(dialog).getByTestId("confirm-text"), { target: { value: "RESTORE" } });
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.find((l) => l.path.includes("/restore"))?.body).toEqual({ confirmation: "RESTORE" }));
  });

  it("保留策略：未预览不能应用；应用体为 dry_run:false, confirm:true", async () => {
    const { log } = renderAt("/system?ws=ws-demo-1&tab=retention", { role: "admin" });
    const box = await screen.findByTestId("retention");
    expect(within(box).getByTestId("apply-btn")).toBeDisabled();
    fireEvent.click(within(box).getByTestId("preview-btn"));
    await waitFor(() => expect(within(box).getByTestId("apply-btn")).not.toBeDisabled());
    fireEvent.click(within(box).getByTestId("apply-btn"));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.find((l) => l.path.includes("/retention/apply"))?.body).toEqual({ dry_run: false, confirm: true }));
  });

  it("用户编辑从回读开始：organization_id / workspace_ids 原样带回，不回落 default", async () => {
    expect(userEditDraft({ username: "a", role: "operator", organization_id: "org-x", workspace_ids: ["w1"] })).toMatchObject({ organization_id: "org-x", workspace_ids: ["w1"] });
    const { log } = renderAt("/system/users?ws=ws-demo-1", { role: "admin" });
    fireEvent.click(await screen.findByTestId("user-edit-alice"));
    fireEvent.click(within(await screen.findByTestId("user-edit-dialog")).getByTestId("user-save"));
    await waitFor(() => expect(log.find((l) => l.method === "PUT")?.body).toMatchObject({ organization_id: "org-x", workspace_ids: ["ws-demo-2", "ws-legacy"] }));
    expect(JSON.stringify(log)).not.toContain('"default"');
  });
});

describe("扩展（阶段 6）", () => {
  it("审批卡：确认框列出设备 / 连接 / 命令；409 invalidated 显示原因与「重新加载最新版本」", async () => {
    window.history.replaceState({}, "", "/");
    installApp({ conflict: "approval" });
    render(<BrowserRouter><ApprovalCard ws="ws-demo-1" operationId="appr1" /></BrowserRouter>);
    fireEvent.click(await screen.findByTestId("approval-approve"));
    const list = await screen.findByTestId("approval-confirm-list");
    expect(list).toHaveTextContent("core-sw-01");
    expect(list).toHaveTextContent("conn-1");
    expect(list).toHaveTextContent("interface Gi0/1");
    fireEvent.click(within(screen.getByTestId("confirm-dialog")).getByTestId("confirm-submit"));
    const conflict = await screen.findByTestId("conflict-panel");
    expect(conflict).toHaveTextContent("设备配置已被修改");
    expect(within(conflict).getByTestId("reload-latest")).toHaveTextContent("重新加载最新版本");
  });

  it("扩展卸载后：导航与空态没有网络词", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1", { extensions: "none" });
    expect(await screen.findByTestId("ext-not-installed")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const w of CORE_FORBIDDEN_DOMAIN_WORDS) expect(nav.textContent).not.toContain(w);
  });

  it("巡检重试门控：未知态禁用；只重试未成功目标", () => {
    expect(inspectionRetryGate({ task_id: "a", status: "unknown" }, []).allowed).toBe(false);
    const g = inspectionRetryGate({ task_id: "a", status: "partial" }, [{ connection_id: "c1", status: "succeeded" }, { connection_id: "c2", status: "failed" }]);
    expect(g).toEqual({ allowed: true, targets: ["c2"] });
    expect(inspectionRetryGate({ task_id: "a", status: "succeeded" }, []).allowed).toBe(false);
  });

  it("导航守卫：拒绝时不跳转", () => {
    window.history.replaceState({}, "", "/a");
    let go: (t: string) => void = () => {};
    function Probe() { useNavigationGuard(true, "未保存", () => true, () => false); go = useNavigate(); return null; }
    render(<BrowserRouter><Probe /></BrowserRouter>);
    go("/b");
    expect(window.location.pathname).toBe("/a");
  });

  it("审批卡：批准时网络中断 → 进入「核对中」并回读，回读前不能再点", async () => {
    window.history.replaceState({}, "", "/");
    const { calls } = installApp({ conflict: "approval_network" });
    render(<BrowserRouter><ApprovalCard ws="ws-demo-1" operationId="appr1" /></BrowserRouter>);
    fireEvent.click(await screen.findByTestId("approval-approve"));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByTestId("confirm-submit"));
    await waitFor(() => expect(screen.getByText(/响应丢失，批准可能已经执行/)).toBeInTheDocument());
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/extensions/approval/operations/appr1")).length).toBeGreaterThanOrEqual(2));
  });

  it("巡检：partial 只重试未成功目标并打开新任务；unknown 禁用重试", async () => {
    const { log } = renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=inspections&id=insp-partial", { extensions: "network_ready" });
    const detail = await screen.findByTestId("inspection-detail", {}, { timeout: 3000 });
    const retry = await within(detail).findByTestId("inspection-retry");
    await waitFor(() => expect(retry).not.toBeDisabled());
    fireEvent.click(retry);
    const dialog = await screen.findByTestId("inspection-retry-dialog");
    expect(dialog).toHaveTextContent("c-bad");
    expect(dialog).not.toHaveTextContent("c-ok");
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.some((l) => l.path.includes("/inspections/insp-partial/retry"))).toBe(true));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("id")).toBe("insp-retry-1"));
  });

  it("巡检 unknown：显示结果未知，重试禁用并说明", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=inspections&id=insp-unknown", { extensions: "network_ready" });
    const detail = await screen.findByTestId("inspection-detail", {}, { timeout: 3000 });
    expect(await within(detail).findByTestId("inspection-unknown")).toHaveTextContent("结果未知 · 需核对");
    expect(within(detail).getByTestId("inspection-retry")).toBeDisabled();
  });
});

describe("资料 / 工作流补充", () => {
  it("知识库重建：受理 ≠ 成功，回读 source.status", async () => {
    renderAt("/library/knowledge?ws=ws-demo-1");
    const table = await screen.findByTestId("knowledge-table");
    fireEvent.click(await within(table).findByText("重建索引"));
    expect(await screen.findByTestId("reindex-readback")).toHaveTextContent("回读状态");
    expect(screen.getByTestId("reindex-readback").textContent).not.toMatch(/成功|完成/);
  });

  it("工作流运行详情链接到任务中心；运行一律入队", async () => {
    const { log } = renderAt("/workflows?ws=ws-demo-1&tab=runs&run=run1");
    const link = await screen.findByTestId("run-task-link");
    expect(link.getAttribute("href")).toContain("/tasks?");
    expect(link.getAttribute("href")).toContain("task=t-partial");
    expect(log.length).toBe(0);
  });
});
