import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillFormDialog } from "../extension-modules/network-operations/SkillForm";
import { fakeBackend } from "./fakeBackend";
import { AuthGateView } from "../app/AuthGate";
import { stageViews } from "../pages/workbench/model";
import { hasProgressContent } from "../pages/workbench/ProgressPanel";
import { healthComponents } from "../pages/system/statusViews";
import { BrowserRouter } from "../router";
import { installApp } from "./appFixture";
import { installFakeWebSocket } from "./fakeWebSocket";

function renderAt(url: string) {
  window.history.replaceState({}, "", url);
  const backend = installApp({ role: "admin" });
  installFakeWebSocket();
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}

describe("网络 Skill：真实设备 / 连接范围合同", () => {
  it("从表单选择范围，保存草稿并回读，不发送无效 steps 模板", async () => {
    const saved = vi.fn();
    let posted: Record<string, unknown> | undefined;
    fakeBackend((method, path, body) => {
      expect(new URL(path, "http://x").searchParams.get("workspace_id")).toBe("ws-demo-1");
      if (method === "POST") { posted = body as Record<string, unknown>; return { status: 201, body: { skill: { ...posted, skill_id: "skill-new" } } }; }
      return { status: 200, body: { skill: { ...posted, skill_id: "skill-new" } } };
    });
    render(<SkillFormDialog ws="ws-demo-1" skill={null} devices={[{ device_id: "d1", name: "合成设备", host: "192.0.2.1" }]} connections={[{ connection_id: "c1", device_id: "d1", protocol: "ssh", port: 22, username: "demo" }]} scripts={[]} onClose={() => {}} onSaved={saved} />);
    fireEvent.click(screen.getByText("保存并回读"));
    expect(await screen.findByText("请填写 1–80 字的名称")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Skill 名称/ }), { target: { value: "合成 Skill" } });
    fireEvent.click(screen.getByLabelText(/合成设备 · 192/));
    fireEvent.click(screen.getByLabelText(/SSH:22/));
    fireEvent.click(screen.getByText("保存并回读"));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(posted).toMatchObject({ name: "合成 Skill", device_ids: ["d1"], connection_ids: ["c1"], enabled: false, approval_enabled: false });
    expect(posted).not.toHaveProperty("steps");
    expect(saved.mock.calls[0][0].skill_id).toBe("skill-new");
  });

  it("保存响应中断后保留原身份，只核对、不重发", async () => {
    let identity = "";
    let writes = 0;
    fakeBackend((method, path, body) => {
      if (method === "PUT") { writes++; identity = (body as { skill_id: string }).skill_id; return "network_error"; }
      expect(path).toContain(`/skills/${identity}?`);
      return { status: 404, body: { error: "skill_not_found" } };
    });
    render(<SkillFormDialog ws="ws-demo-1" skill={{ skill_id: "skill-1", name: "合成", enabled: false, device_ids: ["d1"], connection_ids: ["c1"], allowed_tool_ids: [] }} devices={[]} connections={[]} scripts={[]} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByText("保存并回读"));
    expect(await screen.findByText(/保存结果未知/)).toBeInTheDocument();
    expect(screen.getByText("保存并回读")).toBeDisabled();
    fireEvent.click(screen.getByText("核对保存结果"));
    expect(await screen.findByText(/尚未确认保存结果/)).toBeInTheDocument();
    expect(identity).toBe("skill-1");
    expect(writes).toBe(1);
  });
});

describe("系统状态：页面查询带当前工作区（真实后端缺 workspace_id 返回 400）", () => {
  it("运行时健康：health / summary 都带 workspace_id，以状态 + 指标 + 组件表呈现，原始数据折叠", async () => {
    const { calls: log } = renderAt("/system?ws=ws-demo-1&tab=health");
    const banner = await screen.findByTestId("health-banner");
    expect(banner).toHaveTextContent("1 个组件需要注意");
    const health = log.filter((l) => l.path.startsWith("/api/runtime/health"));
    expect(health.length).toBeGreaterThan(0);
    for (const l of health) expect(new URL(l.path, "http://x").searchParams.get("workspace_id")).toBe("ws-demo-1");
    expect(log.some((l) => l.path.startsWith("/api/runtime/summary?") && l.path.includes("workspace_id=ws-demo-1"))).toBe(true);
    expect(within(screen.getByTestId("health-components")).getByText("probe timeout")).toBeInTheDocument();
    expect(screen.queryByTestId("failure-note")).toBeNull();
    const raw = screen.getAllByTestId("raw-data").find((d) => d.textContent?.includes("/api/runtime/health"))!;
    expect(raw.tagName).toBe("DETAILS");
    expect(raw).not.toHaveAttribute("open");
    expect(raw.querySelector("pre")?.textContent).toContain("probe timeout");
  });

  it("自检：运行时自检带 workspace_id；用量以指标呈现", async () => {
    const { calls: log } = renderAt("/system?ws=ws-demo-1&tab=selfcheck");
    await waitFor(() => expect(log.some((l) => l.path.startsWith("/api/runtime/selfcheck?") && l.path.includes("workspace_id=ws-demo-1"))).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByTestId("usage-metrics")).toHaveTextContent("1,200");
  });

  it("healthComponents 兼容数组与映射两种形状", () => {
    expect(healthComponents({ components: [{ name: "a", status: "ok" }] })).toEqual([{ name: "a", status: "ok" }]);
    expect(healthComponents({ components: { jobs: "ok" } })).toEqual([{ name: "jobs", status: "ok" }]);
  });
});

describe("工作台：按真实公开字段投影，事实源分开", () => {
  it("stage_outputs 读 id/label/text，兼容旧 title/stage/summary，空阶段不渲染", () => {
    expect(stageViews([{ id: "model-1", label: "模型输出 1", text: "42" }])).toEqual([{ key: "model-1", title: "模型输出 1", text: "42", status: undefined }]);
    expect(stageViews([{ stage: "plan", title: "规划", summary: "合成", status: "done" }])[0]).toMatchObject({ title: "规划", text: "合成", status: "done" });
    expect(stageViews([{ id: "", label: "", text: "" }, {}, null, "x"])).toEqual([]);
    expect(stageViews(undefined)).toEqual([]);
  });

  it("无 execution_outcome 的回复显示「结论未上报」；task-state completed 另行标注来源，不覆盖消息结论", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-real42");
    const bar = await screen.findByTestId("outcome-bar");
    expect(within(bar).getByTestId("goal-label")).toHaveTextContent("结论未上报");
    expect(bar).not.toHaveTextContent(/已完成|成功/);
    fireEvent.click(screen.getByTestId("open-progress"));
    const panel = await screen.findByTestId("progress-panel");
    expect(within(panel).getByTestId("stage-outputs").querySelectorAll("li")).toHaveLength(1);
    expect(within(panel).getByTestId("stage-outputs")).toHaveTextContent("模型输出 1");
    expect(within(panel).getByTestId("stage-outputs")).toHaveTextContent("42");
    const msg = within(panel).getByTestId("progress-message-outcome");
    expect(msg).toHaveTextContent("消息 execution_outcome：未上报");
    // 同一 run 的运行审计有 execution_outcome=complete：两个事实源分开显示并标来源，不互相覆盖
    const audit = await within(panel).findByTestId("progress-run-outcome");
    expect(audit).toHaveTextContent("运行审计 execution_outcome：完成（complete）");
    expect(audit).toHaveTextContent("/runs/run-42");
    expect(msg).toHaveTextContent("run run-42");
    await waitFor(() => expect(within(panel).getByTestId("progress-task-state")).toHaveTextContent("task-state：completed"));
    expect(within(panel).getByTestId("progress-task-state")).toHaveTextContent("来源：会话 task-state");
    expect(msg).not.toHaveTextContent("completed");
    // 真实字段 last_run_id 与消息 run_id 对上：显示同一 run，不提示错位
    expect(within(panel).getByTestId("progress-task-state")).toHaveTextContent("run run-42");
    expect(within(panel).getByTestId("progress-task-state")).not.toHaveTextContent("不是同一 run");
  });

  it("没有进度内容时不占右栏：空阶段 / 无任务 / 无实时事件 → 不渲染进度栏", () => {
    expect(hasProgressContent(undefined, null, [])).toBe(false);
    expect(hasProgressContent({ role: "assistant", content: "x", metadata: { stage_outputs: [{ id: "", label: "", text: "" }] } } as never, null, [])).toBe(false);
    expect(hasProgressContent({ role: "assistant", content: "x", metadata: { stage_outputs: [{ id: "model-1", label: "模型输出 1", text: "42" }] } } as never, null, [])).toBe(true);
    expect(hasProgressContent(undefined, { task_id: "t", status: "completed" } as never, [])).toBe(true);
  });

  it("回合结束后时间线读持久化 trace / 运行审计，不再显示「本轮还没有实时事件」", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-real42");
    fireEvent.click(await screen.findByTestId("open-progress"));
    const panel = await screen.findByTestId("progress-panel");
    fireEvent.click(within(panel).getByTestId("timeline-tab"));
    const persisted = await within(panel).findByTestId("timeline-persisted");
    expect(persisted).toHaveTextContent("/runs/run-42/trace");
    expect(within(persisted).getByTestId("timeline")).toHaveTextContent("回合开始");
    expect(within(persisted).getByTestId("timeline")).toHaveTextContent("生成最终回复");
    expect(within(persisted).getByTestId("timeline-run-summary")).toHaveTextContent("完成（complete）");
    expect(panel).not.toHaveTextContent("本轮还没有实时事件");
  });

  it("页头分开写「模型最近检测」与「本轮响应」", async () => {
    renderAt("/workbench?ws=ws-demo-1&session=s-real42");
    fireEvent.click(await screen.findByTestId("open-status-details"));
    expect(await screen.findByTestId("llm-health")).toHaveTextContent(/^模型最近检测：/);
    await waitFor(() => expect(screen.getByTestId("turn-response")).toHaveTextContent("本轮响应：已收到回复"));
  });

  it("「最近检测」以 health 探测为准；顶层 connected 与探测不一致时如实标注", async () => {
    window.history.replaceState({}, "", "/workbench?ws=ws-demo-1&session=s-real42");
    installApp({ role: "admin" });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/agent/llm/status")
      ? new Response(JSON.stringify({ enabled: true, connected: false, key_configured: false, health: { connected: true, configured: true } }), { status: 200, headers: { "Content-Type": "application/json" } })
      : inner(input, init)) as typeof fetch;
    installFakeWebSocket();
    render(<BrowserRouter><AuthGateView /></BrowserRouter>);
    fireEvent.click(await screen.findByTestId("open-status-details"));
    await waitFor(() => expect(screen.getByTestId("llm-health")).toHaveTextContent("模型最近检测：已连接（时间未上报）"));
    expect(screen.getByTestId("llm-health").getAttribute("title")).toContain("不一致");
  });

  it("探测时间缺失时不拿 last_success.at 冒充：分开写「最近检测（时间未上报）」与「最近成功：<时间>」", async () => {
    window.history.replaceState({}, "", "/workbench?ws=ws-demo-1&session=s-real42");
    installApp({ role: "admin" });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/agent/llm/status")
      ? new Response(JSON.stringify({ enabled: true, connected: true, health: { connected: true }, last_success: { at: "2026-09-01T08:00:00Z" } }), { status: 200, headers: { "Content-Type": "application/json" } })
      : inner(input, init)) as typeof fetch;
    installFakeWebSocket();
    render(<BrowserRouter><AuthGateView /></BrowserRouter>);
    fireEvent.click(await screen.findByTestId("open-status-details"));
    await waitFor(() => expect(screen.getByTestId("llm-health")).toHaveTextContent("（时间未上报）"));
    expect(screen.getByTestId("llm-health")).not.toHaveTextContent("2026");
    expect(screen.getByTestId("llm-last-success")).toHaveTextContent(/最近成功：.*2026/);
  });
});
