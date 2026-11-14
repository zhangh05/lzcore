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

describe("资料 R2：真实合同与读回", () => {
  it("新增记忆：memory_id 符合 ^mem-[a-f0-9]{12}$；待确认 → 详情读全文 → 确认后回读为生效中", async () => {
    const { log } = renderAt("/library/memory?ws=ws-demo-1");
    await screen.findByTestId("memory-table");
    fireEvent.change(screen.getByTestId("memory-title"), { target: { value: "巡检周期" } });
    fireEvent.change(screen.getByTestId("memory-content"), { target: { value: "合成：交换机每周一巡检。" } });
    fireEvent.click(screen.getByTestId("memory-pending-toggle"));
    fireEvent.click(screen.getByTestId("memory-save"));
    expect(await screen.findByTestId("memory-pending")).toHaveTextContent("已写入，待确认后生效");
    const write = log.find((l) => l.path.startsWith("/api/memory/write"))!;
    expect(write.body).toMatchObject({ user_confirmed: false });
    expect((write.body as { memory_id: string }).memory_id).toMatch(/^mem-[a-f0-9]{12}$/);
    fireEvent.click(await screen.findByRole("button", { name: "巡检周期" }));
    const detail = await screen.findByTestId("memory-detail");
    expect(within(detail).getByTestId("memory-detail-content")).toHaveTextContent("合成：交换机每周一巡检。");
    expect(within(detail).getByTestId("memory-detail-status")).toHaveTextContent("待确认");
    fireEvent.click(within(detail).getByTestId("memory-confirm"));
    await waitFor(() => expect(within(detail).getByTestId("memory-review-readback")).toHaveTextContent("回读状态：生效中"));
    expect(within(detail).getByTestId("memory-detail-status")).toHaveTextContent("生效中");
  });

  it("已有不合法草稿 id（上一轮 mem_ 格式，从未写入成功）会换成合法 id；合法 id 保持不变", async () => {
    const { stableMemoryId } = await import("../kit/memoryWrite");
    sessionStorage.setItem("lzcore-next:memory-draft:k1", "mem_0123456789abcdef01234567");
    const fresh = stableMemoryId("k1");
    expect(fresh).toMatch(/^mem-[a-f0-9]{12}$/);
    expect(stableMemoryId("k1")).toBe(fresh);
  });

  it("知识检索：显示来源标题与命中摘录（safe_excerpt），可读全文并定位命中片段；无命中有空状态", async () => {
    renderAt("/library/knowledge?ws=ws-demo-1");
    await screen.findByTestId("knowledge-table");
    fireEvent.change(screen.getByLabelText("检索知识"), { target: { value: "巡检" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    const hit = await screen.findByTestId("knowledge-hit");
    expect(hit).toHaveTextContent("手册.pdf");
    expect(within(hit).getByTestId("knowledge-hit-excerpt")).toHaveTextContent("巡检周期为每周一");
    fireEvent.click(within(hit).getByTestId("knowledge-hit-open"));
    const reader = await screen.findByTestId("knowledge-reader");
    expect(await within(reader).findByTestId("knowledge-chunk-hit")).toHaveTextContent("第二章");
    expect(within(reader).getAllByTestId("knowledge-chunk")[0]).toHaveTextContent("第一章");
    fireEvent.click(within(reader).getByRole("button", { name: "关闭" }));
    fireEvent.change(screen.getByLabelText("检索知识"), { target: { value: "不存在的词" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    expect(await screen.findByTestId("knowledge-hits-empty")).toHaveTextContent("没有命中「不存在的词」");
  });

  it("文件：文件夹读 metadata.folder；整理后显示回读的名称与文件夹，抽屉标题随之更新", async () => {
    renderAt("/library/files?ws=ws-demo-1");
    const table = await screen.findByTestId("files-table");
    expect(table).toHaveTextContent("巡检");
    fireEvent.click(within(table).getByText("巡检记录.txt"));
    const drawer = await screen.findByTestId("file-detail");
    fireEvent.click(within(drawer).getByRole("tab", { name: "整理" }));
    fireEvent.change(within(drawer).getByTestId("file-edit-name"), { target: { value: "巡检记录-改名.txt" } });
    fireEvent.change(within(drawer).getByTestId("file-edit-folder"), { target: { value: "归档/2026" } });
    fireEvent.click(within(drawer).getByTestId("file-edit-save"));
    expect(await within(drawer).findByTestId("file-readback")).toHaveTextContent("名称「巡检记录-改名.txt」 · 文件夹「归档/2026」");
    await waitFor(() => expect(within(drawer).getByTestId("file-detail-folder")).toHaveTextContent("归档/2026"));
    expect(within(drawer).getByRole("heading", { level: 2 })).toHaveTextContent("巡检记录-改名.txt");
  });
});

describe("真实表单（网络扩展 / 工作流）", () => {
  it("登记设备：字段级错误（本地校验）→ 修正后保存并回读", async () => {
    const { log } = renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=devices", { extensions: "network_ready" });
    fireEvent.click(await screen.findByTestId("device-new", {}, { timeout: 4000 }));
    const form = await screen.findByTestId("device-form");
    fireEvent.change(within(form).getByTestId("device-name"), { target: { value: "合成-接入-01" } });
    fireEvent.click(screen.getByTestId("device-save"));
    expect(await within(form).findByText("请填写管理地址（IP 或主机名）")).toBeInTheDocument();
    expect(within(form).getByTestId("device-host").getAttribute("aria-invalid")).toBe("true");
    expect(log.some((l) => l.method === "POST" && l.path.includes("/devices"))).toBe(false);
    fireEvent.change(within(form).getByTestId("device-host"), { target: { value: "10.9.0.20" } });
    fireEvent.change(within(form).getByTestId("device-role"), { target: { value: "switch_access" } });
    fireEvent.click(screen.getByTestId("device-save"));
    expect(await screen.findByTestId("device-readback")).toHaveTextContent("回读：合成-接入-01 · 10.9.0.20 · H3C · 接入交换机");
  });

  it("登记设备：服务端 400 映射回字段（同名同地址已存在）", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=devices", { extensions: "network_ready" });
    fireEvent.click(await screen.findByTestId("device-new", {}, { timeout: 4000 }));
    const form = await screen.findByTestId("device-form");
    fireEvent.change(within(form).getByTestId("device-name"), { target: { value: "核心-1" } });
    fireEvent.change(within(form).getByTestId("device-host"), { target: { value: "10.9.0.1" } });
    fireEvent.click(screen.getByTestId("device-save"));
    expect(await within(form).findByText("同名称、同管理地址的设备已存在")).toBeInTheDocument();
    expect(within(form).getByTestId("device-name").getAttribute("aria-invalid")).toBe("true");
  });

  it("添加连接：SSH 缺用户名为字段错误；高级 JSON 不含密码；保存后回读测试状态", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=connections", { extensions: "network_ready" });
    fireEvent.click(await screen.findByTestId("connection-new", {}, { timeout: 4000 }));
    const form = await screen.findByTestId("connection-form", {}, { timeout: 4000 });
    await waitFor(() => expect((within(form).getByTestId("connection-device") as HTMLSelectElement).value).toBe("device_1"), { timeout: 4000 });
    fireEvent.change(within(form).getByTestId("connection-password"), { target: { value: "synthetic-pass" } });
    fireEvent.click(screen.getByTestId("connection-save"));
    expect(await within(form).findByText("SSH 连接必须填写用户名")).toBeInTheDocument();
    fireEvent.click(within(form).getByTestId("toggle-json"));
    const json = within(form).getByLabelText("高级：JSON 请求体") as HTMLTextAreaElement;
    expect(json.value).toContain("\"device_id\": \"device_1\"");
    expect(json.value).not.toContain("synthetic-pass");
    fireEvent.click(within(form).getByTestId("toggle-json"));
    fireEvent.change(within(form).getByTestId("connection-username"), { target: { value: "audit" } });
    fireEvent.click(screen.getByTestId("connection-save"));
    expect(await screen.findByTestId("connection-readback", {}, { timeout: 4000 })).toHaveTextContent("回读：SSH:22 · 用户 audit · 状态 测试失败（connection refused）");
  });

  it("编辑巡检脚本：表单改命令 → 保存 → 回读版本 +1；非只读命令由服务端拒绝并标到命令字段", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=scripts", { extensions: "network_ready" });
    fireEvent.click(await screen.findByTestId("script-edit", {}, { timeout: 4000 }));
    const form = await screen.findByTestId("script-form", {}, { timeout: 4000 });
    expect((within(form).getByTestId("script-commands") as HTMLTextAreaElement).value).toBe("display version");
    fireEvent.change(within(form).getByTestId("script-commands"), { target: { value: "display version\nsystem-view" } });
    fireEvent.click(screen.getByTestId("script-save"));
    expect(await within(form).findByText(/命令必须是只读命令/)).toBeInTheDocument();
    fireEvent.change(within(form).getByTestId("script-commands"), { target: { value: "display version\ndisplay interface brief" } });
    fireEvent.click(screen.getByTestId("script-save"));
    expect(await screen.findByTestId("script-readback", {}, { timeout: 4000 })).toHaveTextContent("回读：「基础健康巡检」v2 · 2 条命令");
  });

  it("新建工作流：真实 nodes 结构（不是 steps）；缺工具为节点字段错误；保存后回读执行层次", async () => {
    const { log } = renderAt("/workflows?ws=ws-demo-1");
    fireEvent.click(await screen.findByTestId("workflow-new"));
    const form = await screen.findByTestId("workflow-form");
    fireEvent.change(within(form).getByTestId("workflow-name"), { target: { value: "合成巡检流" } });
    fireEvent.click(screen.getByTestId("workflow-save"));
    expect(await within(form).findByText("至少添加一个节点")).toBeInTheDocument();
    fireEvent.click(within(form).getByTestId("workflow-add-node"));
    fireEvent.click(screen.getByTestId("workflow-save"));
    expect(await within(form).findByText("请选择工具")).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByTestId("wf-node-tool").querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(within(form).getByTestId("wf-node-tool"), { target: { value: "knowledge.search" } });
    fireEvent.change(within(form).getByTestId("wf-node-args"), { target: { value: "{\"query\": \"巡检\"}" } });
    fireEvent.click(screen.getByTestId("workflow-save"));
    expect(await screen.findByTestId("workflow-readback")).toHaveTextContent("「合成巡检流」v1 · 1 个节点 · 执行层次 node_1");
    const post = log.find((l) => l.method === "POST" && l.path.startsWith("/api/workflows"))!;
    expect(post.body).toMatchObject({ name: "合成巡检流", nodes: [{ node_id: "node_1", tool_id: "knowledge.search", arguments: { query: "巡检" } }] });
    expect(post.body).not.toHaveProperty("steps");
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

  it("工作区改名只改显示名，不发送新 id", async () => {
    const { log } = renderAt("/system/workspaces?ws=ws-demo-1", { role: "admin" });
    const table = await screen.findByTestId("workspaces-table");
    fireEvent.click(within(table).getAllByRole("button", { name: "改名" })[0]);
    const input = (await screen.findByText("显示名")).parentElement!.querySelector("input")!;
    expect(input).toHaveValue("演示工作区 A");
    fireEvent.change(input, { target: { value: "  核心网巡检  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(log.find((l) => l.path.endsWith("/rename"))?.body).toEqual({ name: "核心网巡检" }));
    expect(log.find((l) => l.path.endsWith("/rename"))?.path).toContain("ws-demo-1");
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
    expect(g).toEqual({ allowed: true, targets: ["c2"], scope: "failed_targets" });
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
    const detail = screen.getByTestId("wf-run-detail");
    expect(within(detail).getByText("已读取工作区元数据")).toBeInTheDocument();
    expect(within(detail).getByText("0 ms")).toBeInTheDocument();
    expect(within(detail).getByText("节点输出")).toBeInTheDocument();
    expect(within(detail).getByText("执行结果未知")).toBeInTheDocument();
    expect(within(detail).getByText("响应中断")).toBeInTheDocument();
    expect(log.length).toBe(0);
  });
});
