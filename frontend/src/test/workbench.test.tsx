import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sessionOps } from "../pages/workbench/useSessions";
import { Thread } from "../pages/workbench/Thread";
import { AuthGateView } from "../app/AuthGate";
import { BrowserRouter } from "../router";
import { installApp, type AppFixtureOptions } from "./appFixture";
import { installFakeWebSocket } from "./fakeWebSocket";

function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const backend = installApp(opts);
  const Fake = installFakeWebSocket();
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return { ...backend, Fake };
}
const FORBIDDEN_ACTIONS = /重试|重发|换方案/;

describe("工作台（阶段 2）", () => {
  it("会话栏按天分组；有限宽度的进度可打开且 Escape 回到入口；URL 带 ws 与 session", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    const col = await screen.findByTestId("session-column");
    await waitFor(() => expect(col).toHaveTextContent("今天"));
    const openProgress = screen.getByRole("button", { name: "进度与证据" });
    openProgress.focus();
    fireEvent.click(openProgress);
    expect(screen.getByTestId("progress-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("composer-input")).toBeInTheDocument();
    expect(await screen.findByTestId("stage-outputs")).toHaveTextContent("规划");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openProgress).toHaveFocus();
    expect(new URLSearchParams(window.location.search).get("session")).toBe("s-partial");
    // 次要状态收进「状态细节」浮层（挂在 body，不丢信息）
    fireEvent.click(await screen.findByTestId("open-status-details"));
    expect(await screen.findByTestId("agent-status")).toHaveTextContent("ready");
    expect(await screen.findByTestId("llm-health")).toHaveTextContent("已连接");
  });

  it("≤2 次点击新建会话并到达输入框：Ctrl K → 新建会话 真正 POST /api/sessions", async () => {
    const { log } = renderAt("/workbench?ws=ws-demo-1");
    await screen.findByTestId("workbench-empty");
    act(() => { fireEvent.keyDown(window, { key: "k", ctrlKey: true }); });
    fireEvent.click(within(await screen.findByTestId("command-palette")).getAllByRole("option")[0]);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe("s-new-1"));
    expect(log.some((l) => l.method === "POST" && l.path.startsWith("/api/sessions"))).toBe(true);
    expect(await screen.findByTestId("composer-input")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-session="s-new-1"]')).toBeInTheDocument());
  });

  it("partial：结论条是「部分达成」，整条消息里没有「完成 / 成功」", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    const bar = await screen.findByTestId("outcome-bar");
    expect(bar.getAttribute("data-goal")).toBe("partial");
    const msg = bar.closest("li")!;
    expect(msg.textContent).not.toMatch(/完成|成功/);
  });

  it("ok:false + unknown：「结果未知 · 需核对」常驻告警，动作只有核对 / 标记 / 续接，深链到可核对条目", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-unknown");
    const bar = await screen.findByTestId("outcome-bar");
    expect(within(bar).getByTestId("goal-label")).toHaveTextContent("结果未知 · 需核对");
    expect(bar).toHaveAttribute("role", "alert");
    expect(bar.textContent).not.toMatch(FORBIDDEN_ACTIONS);
    const verify = within(bar).getByText("去核对").closest("a")!;
    expect(verify.getAttribute("href")).toBe("/review?ws=ws-demo-1&source=task&id=t-unknown&session=s-unknown");
    expect(screen.getByTestId("resume-bar")).toHaveTextContent("先去核对");
    expect(screen.queryByTestId("resume-task-btn")).toBeNull();
    // 一步到达：点「去核对」直接打开核对详情
    fireEvent.click(verify);
    expect(await screen.findByTestId("review-detail")).toBeInTheDocument();
  });

  it("映射二（独立）：ok=true、无 errors、unknown、job 未失败 → 结果未知 · 需核对，动作是核对 / 续接", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-mapping2");
    const bar = await screen.findByTestId("outcome-bar");
    expect(within(bar).getByTestId("goal-label")).toHaveTextContent("结果未知 · 需核对");
    const actions = Array.from(bar.querySelectorAll("[data-action]")).map((x) => x.getAttribute("data-action"));
    expect(actions).toEqual(["verify", "mark_result", "resume"]);
    expect(bar.textContent).not.toMatch(FORBIDDEN_ACTIONS);
  });

  it("reconciled 不报未知", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-reconciled");
    const bar = await screen.findByTestId("outcome-bar");
    expect(bar.getAttribute("data-goal")).toBe("complete");
    expect(bar.textContent).not.toContain("结果未知");
  });

  it("发送：message 带 client_request_id；运行中输入框不禁用；停止走 jobs cancel，显示「已请求停止」中间态", async () => {
    const { Fake, log } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.click(screen.getByTestId("send-btn"));
    await waitFor(() => expect(Fake.instances[0]?.sent.length).toBe(1));
    const sock = Fake.instances[0];
    const frame = sock.sent[0] as { type: string; metadata: { client_request_id: string } };
    expect(frame.type).toBe("message");
    expect(frame.metadata.client_request_id).toMatch(/^cr_/);
    expect(screen.getByTestId("composer-input")).not.toBeDisabled();
    act(() => sock.push({ type: "event", name: "model_started", data: { job_id: "job-run-1" } }));
    act(() => sock.push({ type: "token", content: "部分", seq: 1 }));
    expect(screen.getByTestId("live-turn")).toHaveTextContent("部分");
    fireEvent.click(screen.getByTestId("stop-btn"));
    await waitFor(() => expect(screen.getByTestId("stop-btn")).toHaveTextContent("已请求停止 · 等待终态确认"));
    expect(log.some((l) => l.path.startsWith("/api/jobs/job-run-1/cancel"))).toBe(true);
    // 断线：只发 resume，不重发 message
    act(() => sock.drop());
    await waitFor(() => expect(Fake.instances.length).toBeGreaterThan(1), { timeout: 2000 });
    const second = Fake.instances[1];
    await waitFor(() => expect(second.sent.length).toBeGreaterThan(0));
    expect(second.sent.every((f) => f.type === "resume")).toBe(true);
    expect((second.sent[0] as { stream_seq: number }).stream_seq).toBe(1);
  });

  it("Skill / 资源范围：绑定图纸的会话锁定", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-drawing");
    expect(await screen.findByTestId("scope-locked")).toBeInTheDocument();
    expect(screen.getByTestId("skill-select")).toBeDisabled();
  });

  it("附件：超过限制给出原因", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    const composer = await screen.findByTestId("composer");
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" });
    fireEvent.drop(composer, { dataTransfer: { files: [big] } });
    expect(await screen.findByTestId("attachment-rejected")).toHaveTextContent("big.png");
  });

  it("「记住本次结论」：409 execution_unknown 进入专门未知界面，只能回读，不能再写", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial", { conflict: "memory" });
    fireEvent.click(await screen.findByTestId("remember-btn"));
    const unknown = await screen.findByTestId("memory-unknown");
    expect(unknown).toHaveTextContent("结果未知 · 需核对");
    expect(screen.queryByTestId("remember-btn")).toBeNull();
    expect(within(unknown).getByTestId("memory-readback")).toBeInTheDocument();
  });

  it("「记住本次结论」：稳定 memory_id，写后回读", async () => {
    const { log } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    fireEvent.click(await screen.findByTestId("remember-btn"));
    expect(await screen.findByTestId("memory-written")).toBeInTheDocument();
    const write = log.find((l) => l.path.startsWith("/api/memory/write"))!;
    expect((write.body as { memory_id: string }).memory_id).toMatch(/^mem-[a-f0-9]{12}$/); // 后端合同；上一轮的 mem_+24 位会被 400 invalid_memory_id 拒绝
  });

  it("会话：归档 → 已归档 tab 永久删除需要确认串", async () => {
    const { log } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    await screen.findByTestId("session-column");
    fireEvent.click(screen.getByTestId("sessions-archived-tab"));
    fireEvent.click(await screen.findByRole("button", { name: /管理会话/ }));
    fireEvent.click(await screen.findByTestId("session-delete"));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(within(dialog).getByTestId("confirm-submit")).toBeDisabled();
    fireEvent.change(within(dialog).getByTestId("confirm-text"), { target: { value: "DELETE s-archived" } });
    fireEvent.click(within(dialog).getByTestId("confirm-submit"));
    await waitFor(() => expect(log.some((l) => l.method === "DELETE" && l.path.startsWith("/api/sessions/s-archived"))).toBe(true));
  });

  it("能力目录 dry-run 只演示", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    fireEvent.click(await screen.findByTestId("wb-more"));
    fireEvent.click(await screen.findByTestId("open-catalog"));
    fireEvent.click(await screen.findByTestId("dry-run-workspace.file.write"));
    expect(await screen.findByTestId("dry-run-result")).toHaveTextContent("仅演示");
  });

  it("能力目录：分类 + 搜索，完整合同可展开", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    fireEvent.click(await screen.findByTestId("wb-more"));
    fireEvent.click(await screen.findByTestId("open-catalog"));
    await screen.findByTestId("catalog-section-workspace");
    expect(screen.getByTestId("catalog-section-knowledge")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("catalog-cat-knowledge"));
    expect(screen.queryByTestId("catalog-section-workspace")).toBeNull();
    fireEvent.click(screen.getByText(/^全部/));
    fireEvent.change(screen.getByTestId("catalog-search"), { target: { value: "写入" } });
    expect(screen.getAllByTestId("catalog-tool")).toHaveLength(1);
    expect(screen.getByTestId("catalog-contract")).toHaveTextContent("Write a managed workspace file.");
  });

  it("会话操作是锚定菜单（不是整高抽屉）；改名后主标题与列表来自同一次回读", async () => {
    const { log } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    await waitFor(() => expect(screen.getByTestId("wb-title")).toHaveTextContent("部分达成"));
    fireEvent.click(await screen.findByRole("button", { name: "管理会话 部分达成" }));
    const menu = await screen.findByTestId("session-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(screen.queryByRole("dialog", { name: "会话操作" })).toBeNull();
    fireEvent.click(within(menu).getByTestId("session-rename"));
    const input = await screen.findByLabelText("新名称");
    fireEvent.change(input, { target: { value: "部分达成（改名）" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByTestId("wb-title")).toHaveTextContent("部分达成（改名）"));
    expect(log.some((l) => l.method === "PUT" && l.path.startsWith("/api/sessions/s-partial"))).toBe(true);
  });
});

describe("现有框架合同对齐", () => {
  it("Skill 资源来自目录，发送公开 workbench_selection，附件不冒充资源范围", async () => {
    const { Fake } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    await screen.findByTestId("composer-input");
    await waitFor(() => expect(screen.getByTestId("skill-select").querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("skill-select"), { target: { value: JSON.stringify(["demo.notes", "sk1"]) } });
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "汇总看板" } });
    expect(screen.getByTestId("send-btn")).toBeDisabled();
    fireEvent.click(screen.getByTestId("scope-btn"));
    fireEvent.click(await screen.findByRole("radio", { name: "演示看板" }));
    fireEvent.click(screen.getByRole("button", { name: "确定范围" }));
    fireEvent.click(screen.getByTestId("send-btn"));
    await waitFor(() => expect(Fake.instances[0]?.sent.length).toBe(1));
    const metadata = Fake.instances[0].sent[0].metadata;
    expect(metadata).toMatchObject({ workbench_selection: {
      extension_id: "demo.notes", skill_id: "sk1", skill_name: "汇总", resource_ids: ["board-1"], allow_edit: true,
    } });
    expect(metadata).not.toHaveProperty("skill_id");
    expect(metadata).not.toHaveProperty("resource_scope");
  });

  it("助手消息恢复表格和代码，原始 HTML 和危险链接不会成为可执行内容", () => {
    render(<Thread ws="ws-demo-1" sessionId="s" messages={[{ role: "assistant", content: "| 名称 | 状态 |\n| --- | --- |\n| 测试 | 正常 |\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n[危险](javascript:alert)" }]} live={null} task={null} availableExtensions={new Set()} onResume={() => {}} />);
    expect(screen.getByRole("table")).toHaveTextContent("测试");
    expect(document.querySelector("pre code")).toHaveTextContent("const x = 1;");
    expect(document.querySelector(".message-body script")).toBeNull();
    expect(screen.getByRole("link", { name: "危险" })).toHaveAttribute("href", "#blocked");
  });
});

describe("会话写入的真实范围合同", () => {
  it("重命名、归档与恢复将 workspace_id 传到服务端读取的 query", async () => {
    const { log } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    await screen.findByTestId("composer-input");
    for (const outcome of [await sessionOps.rename("ws-demo-1", "s-partial", "验收"), await sessionOps.archive("ws-demo-1", "s-partial"), await sessionOps.restore("ws-demo-1", "s-partial")]) {
      expect(outcome.kind === "http" && outcome.status).toBe(200);
    }
    for (const request of log.filter((r) => r.path.startsWith("/api/sessions/s-partial"))) expect(new URL(request.path, "http://synthetic").searchParams.get("workspace_id")).toBe("ws-demo-1");
  });
});

describe("附件使用托管文件合同", () => {
  it.each([200, 409])("上传 HTTP %i：使用 file.file_id；未知写入保留草稿和附件且不发起回合", async (status) => {
    const { Fake } = renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    await screen.findByTestId("composer-input");
    const fixtureFetch = globalThis.fetch;
    const uploads: FormData[] = [];
    globalThis.fetch = (async (path, init) => {
      if (String(path).endsWith("/artifacts/upload")) {
        uploads.push(init!.body as FormData);
        return new Response(JSON.stringify({ ok: status === 200, file: { file_id: "managed-original" }, artifact: { artifact_id: "different-artifact" }, error: status === 409 ? "execution_unknown" : undefined }), { status });
      }
      return fixtureFetch(path, init);
    }) as typeof fetch;
    fireEvent.drop(screen.getByTestId("composer"), { dataTransfer: { files: [new File(["data"], "original.txt", { type: "text/plain" })] } });
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "检查附件" } });
    fireEvent.click(screen.getByTestId("send-btn"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0].get("artifact_type")).toBe("chat_attachment");
    expect(uploads[0].get("session_id")).toBe("s-partial");
    if (status === 200) {
      await waitFor(() => expect(Fake.instances[0]?.sent.length).toBe(1));
      expect(Fake.instances[0].sent[0].metadata).toMatchObject({ attachments: [{ file_id: "managed-original", name: "original.txt", mime_type: "text/plain", size_bytes: 4, kind: "file" }] });
    } else {
      expect(await screen.findByTestId("stop-error")).toHaveTextContent("先核对");
      expect(Fake.instances).toHaveLength(0);
      expect(screen.getByTestId("composer-input")).toHaveValue("检查附件");
      expect(screen.getByRole("button", { name: "移除 original.txt" })).toBeInTheDocument();
    }
  });
});

describe("浮层层级（R2）", () => {
  it("托管文件选择抽屉挂到 body，遮罩覆盖整个窗口（不被输入区 max-width 限制）", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    fireEvent.click(await screen.findByRole("button", { name: "从托管文件选" }));
    const drawer = await screen.findByTestId("managed-picker");
    const overlay = drawer.parentElement!;
    expect(overlay.classList.contains("overlay")).toBe(true);
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.closest(".wb-composer")).toBeNull();
  });

  it("顶部入口如实叫「命令」，并说明只搜动作 / 页面 / 工作区", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-partial");
    const btn = await screen.findByTestId("open-palette");
    expect(btn).toHaveTextContent("命令");
    expect(btn).not.toHaveTextContent("全局搜索");
    fireEvent.click(btn);
    expect(await screen.findByTestId("palette-hint")).toHaveTextContent("只搜索动作、页面和工作区");
  });
});
