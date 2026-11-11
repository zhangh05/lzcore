import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { isConnected } from "../pages/system/ModelSettings";
import { BrowserRouter } from "../router";
import { appHandler, type AppFixtureOptions, type Logged } from "./appFixture";
import { installFixture } from "./backendFixture";
import type { FakeHandler } from "./fakeBackend";

const NB = "/api/extensions/network.operations";

/** 在应用夹具之上补模型服务与网络 Skill 接口，记录全部写请求。 */
function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const log: Logged[] = [];
  const app = appHandler(opts, log);
  let active = "deepseek";
  const providers = [
    { provider: "deepseek", label: "DeepSeek", provider_type: "openai_compatible", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", key_configured: true, key_preview: "sk-a****wxyz" },
    { provider: "openai", label: "OpenAI", provider_type: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", key_configured: false },
    { provider: "ollama", label: "Ollama (本地)", provider_type: "openai_compatible", base_url: "http://localhost:11434/v1", model: "llama3.1", key_configured: false },
  ];
  const extra: FakeHandler = (method, path, body) => {
    const p = path.split("?")[0];
    if (method !== "GET") log.push({ method, path: p, body });
    if (p === "/api/agent/llm/providers" && method === "GET") return { status: 200, body: { ok: true, active, providers: providers.map((x) => ({ ...x, is_active: x.provider === active })) } };
    if (p === "/api/agent/llm/test") {
      const b = body as { api_key?: string; provider?: string };
      return b.provider === "openai" && !b.api_key
        ? { status: 200, body: { ok: false, fallback_reason: "API key not configured" } }
        : { status: 200, body: { ok: true, response: "OK" } };
    }
    const save = /^\/api\/agent\/llm\/providers\/([^/]+)$/.exec(p);
    if (save && method === "POST") {
      const rec = providers.find((x) => x.provider === save[1])!;
      const b = body as { api_key?: string; model?: string };
      Object.assign(rec, { model: b.model ?? rec.model, key_configured: rec.key_configured || !!b.api_key, key_preview: b.api_key ? "sk-n****1234" : rec.key_preview });
      return { status: 200, body: { ok: true, config: rec } };
    }
    if (p === "/api/agent/llm/activate") { active = (body as { provider: string }).provider; return { status: 200, body: { ok: true, active } }; }
    if (p === `${NB}/skills` && method === "GET") return { status: 200, body: { ok: true, skills: [
      { skill_id: "sk_core", name: "核心层变更", description: "VLAN 变更", enabled: true, approval_enabled: true, device_ids: ["device_1"], connection_ids: ["connection_1"], allowed_tool_ids: ["network.operations.device.manage"] },
      { skill_id: "sk_draft", name: "园区巡检", enabled: false, device_ids: [], connection_ids: [], allowed_tool_ids: [] },
    ] } };
    return app(method, path, body);
  };
  installFixture({ ...opts, extensions: "network_ready" }, extra);
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return { log };
}

describe("网络扩展拆成设备与 Skill 两个工作区", () => {
  it("旧深链 /manage?tab=skills 跳到 Skill 工作区；卡片显示发布状态与范围", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=skills");
    const grid = await screen.findByTestId("skills-grid", {}, { timeout: 4000 });
    expect(window.location.pathname).toBe("/extensions/network.operations/skills");
    expect(within(grid).getByText("核心层变更")).toBeInTheDocument();
    expect(within(grid).getByText("已发布")).toBeInTheDocument();
    expect(within(grid).getByText("草稿")).toBeInTheDocument();
    expect(within(grid).getByText("写入需审批")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Skill 的使用流程" })).toHaveTextContent("1 个已发布");
  });

  it("设备清单：连接在设备详情里管理，带健康筛选", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1");
    const list = await screen.findByRole("list", { name: "设备列表" }, { timeout: 4000 });
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    expect(screen.getByRole("group", { name: "设备概览" })).toHaveTextContent("连接健康");
    fireEvent.click(screen.getByRole("radio", { name: /需关注/ }));
    expect(screen.getByRole("radio", { name: /需关注/ })).toHaveAttribute("aria-checked", "true");
  });
});

describe("模型服务", () => {
  it("已接入与可添加分开：有密钥 / 当前 / 本机服务算已接入", () => {
    expect(isConnected({ provider: "openai", key_configured: false, base_url: "https://api.openai.com/v1" }, "deepseek")).toBe(false);
    expect(isConnected({ provider: "ollama", base_url: "http://localhost:11434/v1" }, "deepseek")).toBe(true);
    expect(isConnected({ provider: "provider_abc" }, "deepseek")).toBe(true);
    expect(isConnected({ provider: "deepseek" }, "deepseek")).toBe(true);
  });

  it("从画廊接入 OpenAI：先测草稿（不保存）→ 填密钥后测试通过 → 保存并设为当前", async () => {
    const { log } = renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    const settings = await screen.findByTestId("model-settings");
    await waitFor(() => expect(within(settings).getAllByText("deepseek-chat").length).toBeGreaterThan(0));
    expect(within(screen.getByTestId("providers-table")).queryByText("OpenAI")).toBeNull();
    fireEvent.click(await screen.findByTestId("provider-add-openai"));
    const sheet = await screen.findByTestId("provider-sheet");
    fireEvent.click(within(sheet).getByTestId("provider-test"));
    expect(await within(sheet).findByTestId("llm-test-result")).toHaveTextContent("测试未通过");
    expect(log.some((l) => l.path.startsWith("/api/agent/llm/providers/"))).toBe(false);
    fireEvent.change(within(sheet).getByTestId("provider-key"), { target: { value: "sk-new-1234" } });
    fireEvent.click(within(sheet).getByTestId("provider-test"));
    await waitFor(() => expect(within(sheet).getByTestId("llm-test-result")).toHaveTextContent("连接正常"));
    const probe = log.filter((l) => l.path === "/api/agent/llm/test").pop()!;
    expect(probe.body).toMatchObject({ provider: "openai", api_key: "sk-new-1234", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1" });
    fireEvent.click(within(sheet).getByTestId("provider-save-activate"));
    await waitFor(() => expect(log.find((l) => l.path === "/api/agent/llm/activate")?.body).toEqual({ provider: "openai" }));
    expect(log.find((l) => l.path === "/api/agent/llm/providers/openai")?.body).toMatchObject({ api_key: "sk-new-1234", model: "gpt-4o-mini" });
    await waitFor(() => expect(within(screen.getByTestId("providers-table")).getByText("OpenAI")).toBeInTheDocument());
  });
});
