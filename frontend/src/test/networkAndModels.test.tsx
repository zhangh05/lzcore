import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { isConnected } from "../pages/system/ModelSettings";
import { BrowserRouter } from "../router";
import { appHandler, type AppFixtureOptions, type Logged } from "./appFixture";
import { installFixture } from "./backendFixture";
import type { FakeHandler } from "./fakeBackend";

const NB = "/api/extensions/network.operations";

/** 夹具里的模型目录：gpt-4 系列识图，o4-mini 有推理强度，其余纯文本。 */
function profileFor(model: string) {
  const vision = /gpt-4/.test(model);
  const effort = /^o4/.test(model);
  return { model, vision, pdf: false, tools: true, reasoning: effort, temperature: !effort, context_window: vision ? 128000 : 64000, max_output: 8192,
    thinking_options: effort ? ["low", "medium", "high"] : [], thinking_required: false, cost_per_million: null,
    catalog_ref: model.startsWith("gpt") || effort ? `openai/${model}` : model === "deepseek-chat" ? "deepseek/deepseek-chat" : "", display_name: "",
    sources: { vision: "catalog", reasoning: "catalog", temperature: "catalog", context_window: "catalog", _base: "catalog" } };
}

/** 在应用夹具之上补模型服务与网络 Skill 接口，记录全部写请求。 */
function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const log: Logged[] = [];
  const app = appHandler(opts, log);
  let active = "deepseek";
  const providers = [
    { provider: "deepseek", label: "DeepSeek", provider_type: "openai_compatible", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", key_configured: true, key_preview: "sk-a****wxyz",
      profile: profileFor("deepseek-chat") },
    { provider: "openai", label: "OpenAI", provider_type: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", key_configured: false },
    { provider: "ollama", label: "Ollama (本地)", provider_type: "openai_compatible", base_url: "http://localhost:11434/v1", model: "llama3.1", key_configured: false },
  ];
  const extra: FakeHandler = (method, path, body) => {
    const p = path.split("?")[0];
    if (method !== "GET") log.push({ method, path: p, body });
    if (p === "/api/agent/llm/providers" && method === "GET") return { status: 200, body: { ok: true, active, providers: providers.map((x) => ({ ...x, is_active: x.provider === active })) } };
    if (p === "/api/agent/llm/profile") return { status: 200, body: { ok: true, profile: profileFor(String((body as { model?: string }).model)) } };
    if (p === "/api/agent/llm/test" && (body as { probe?: string }).probe === "vision") return { status: 200, body: { ok: true, probe: "vision", vision: true, expected: "blue", response: "Blue" } };
    if (p === "/api/agent/llm/test") {
      const b = body as { api_key?: string; provider?: string };
      return b.provider === "openai" && !b.api_key
        ? { status: 200, body: { ok: false, fallback_reason: "API key not configured" } }
        : { status: 200, body: { ok: true, response: "OK" } };
    }
    if (p === "/api/agent/llm/models") {
      const b = body as { api_key?: string; provider?: string; base_url?: string };
      const saved = providers.find((x) => x.provider === b.provider);
      return b.api_key || saved?.key_configured
        ? { status: 200, body: { ok: true, source: "api.openai.com", models: [{ id: "gpt-4.1", owned_by: "openai", capabilities: { vision: true, reasoning: false, tools: true, context_window: 1047576 } }, { id: "gpt-4o-mini", owned_by: "openai" }, { id: "o4-mini", owned_by: "openai" }] } }
        : { status: 200, body: { ok: false, error: "provider rejected the request", http_status: 401 } };
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

describe("网络设备、网络拓扑、网络 Skill 是三个独立入口", () => {
  it("旧深链 /manage?tab=skills 跳到 Skill 工作区；卡片显示发布状态与范围", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=skills");
    const grid = await screen.findByTestId("skills-grid", {}, { timeout: 4000 });
    expect(window.location.pathname).toBe("/extensions/network.operations/skills");
    expect(within(grid).getByText("核心层变更")).toBeInTheDocument();
    expect(within(grid).getByText("已发布")).toBeInTheDocument();
    expect(within(grid).getByText("草稿")).toBeInTheDocument();
    expect(within(grid).getByText("写入需审批")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Skill 概览" })).toHaveTextContent("已发布");
    // Skill 页不再挂设备入口：没有指向设备页的链接或按钮
    expect(screen.queryByRole("button", { name: /管理/ })).toBeNull();
  });

  it("旧深链 /manage?tab=topologies 跳到独立的拓扑页，保留图纸参数", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1&tab=topologies&topology=topo1");
    expect(await screen.findByTestId("netops-topology", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/extensions/network.operations/topology");
    const q = new URLSearchParams(window.location.search);
    expect(q.get("topology")).toBe("topo1");
    expect(q.has("tab")).toBe(false);
    // 主导航里三个入口各自独立
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["网络设备", "网络拓扑", "网络 Skill"]) expect(within(nav).getByText(label)).toBeInTheDocument();
  });

  it("设备清单：连接在设备详情里管理，带健康筛选", async () => {
    renderAt("/extensions/network.operations/manage?ws=ws-demo-1");
    const list = await screen.findByRole("list", { name: "设备列表" }, { timeout: 4000 });
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0));
    expect(screen.getByRole("group", { name: "设备概览" })).toHaveTextContent("连接健康");
    expect(screen.queryByTestId("net-topologies")).toBeNull();
    expect(screen.getByRole("tablist", { name: "网络设备视图" })).not.toHaveTextContent("拓扑");
    fireEvent.click(screen.getByRole("button", { name: /需关注/ }));
    expect(screen.getByRole("button", { name: /需关注/ })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("模型服务", () => {
  it("填好地址和密钥后自动获取模型列表，从列表里选模型再测试", async () => {
    const { log } = renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    fireEvent.click(await screen.findByTestId("provider-add-openai", {}, { timeout: 4000 }));
    const sheet = await screen.findByTestId("provider-sheet");
    // 没有密钥时不去拉
    expect(log.some((l) => l.path === "/api/agent/llm/models")).toBe(false);
    fireEvent.change(within(sheet).getByTestId("provider-key"), { target: { value: "sk-new-1234" } });
    const combo = await within(sheet).findByRole("combobox", { name: "模型" }, { timeout: 3000 });
    expect(log.filter((l) => l.path === "/api/agent/llm/models").pop()?.body).toMatchObject({ provider: "openai", provider_type: "openai_compatible", api_key: "sk-new-1234", base_url: "https://api.openai.com/v1" });
    expect(within(sheet).getByText(/获取 3 个模型/)).toBeInTheDocument();
    fireEvent.click(combo);
    fireEvent.click(await within(sheet).findByRole("option", { name: /^gpt-4\.1（识图 · 1\.05M）$/ }));
    fireEvent.click(within(sheet).getByTestId("provider-test"));
    await waitFor(() => expect(within(sheet).getByTestId("llm-test-result")).toHaveTextContent("连接正常"));
    expect(log.filter((l) => l.path === "/api/agent/llm/test").pop()?.body).toMatchObject({ model: "gpt-4.1", api_key: "sk-new-1234" });
  });

  it("获取模型失败时给出原因，仍可手动填写", async () => {
    renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    fireEvent.click(await screen.findByTestId("provider-add-openai", {}, { timeout: 4000 }));
    const sheet = await screen.findByTestId("provider-sheet");
    fireEvent.change(within(sheet).getByTestId("provider-url"), { target: { value: "https://gateway.example.test/v1" } });
    // 既没密钥也非本机：按钮不可用，不发请求
    expect(within(sheet).getByTestId("provider-fetch-models")).toBeDisabled();
    fireEvent.change(within(sheet).getByTestId("provider-url"), { target: { value: "http://localhost:11434/v1" } });
    expect(await within(sheet).findByTestId("provider-models-error", {}, { timeout: 3000 })).toHaveTextContent("401");
    expect(within(sheet).getByTestId("provider-model")).toHaveValue("gpt-4o-mini");
  });

  it("已接入与可添加分开：有密钥 / 系统默认 / 本机服务算已接入", () => {
    expect(isConnected({ provider: "openai", key_configured: false, base_url: "https://api.openai.com/v1" }, "deepseek")).toBe(false);
    expect(isConnected({ provider: "ollama", base_url: "http://localhost:11434/v1" }, "deepseek")).toBe(true);
    expect(isConnected({ provider: "provider_abc" }, "deepseek")).toBe(true);
    expect(isConnected({ provider: "deepseek" }, "deepseek")).toBe(true);
  });

  it("从画廊接入 OpenAI：先测草稿（不保存）→ 填密钥后测试通过 → 保存后直接出现在已接入里", async () => {
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
    expect(screen.queryByText("当前")).toBeNull();
    expect(within(sheet).queryByTestId("provider-save-activate")).toBeNull();
    fireEvent.click(within(sheet).getByTestId("provider-save"));
    await waitFor(() => expect(log.find((l) => l.path === "/api/agent/llm/providers/openai")?.body).toMatchObject({ api_key: "sk-new-1234", model: "gpt-4o-mini" }));
    // 已有可用的默认服务（DeepSeek），保存不会去切换它
    expect(log.some((l) => l.path === "/api/agent/llm/activate")).toBe(false);
    await waitFor(() => expect(within(screen.getByTestId("providers-table")).getByText("OpenAI")).toBeInTheDocument());
  });

  it("每个已接入的服务都能单独测试连接", async () => {
    const { log } = renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    fireEvent.click(await screen.findByTestId("provider-test-deepseek", {}, { timeout: 4000 }));
    await waitFor(() => expect(log.filter((l) => l.path === "/api/agent/llm/test").pop()?.body).toMatchObject({ provider: "deepseek" }));
  });

  it("卡片显示模型能力：识图 / 深度思考 / 上下文，来自内置目录", async () => {
    renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    const card = (await screen.findByTestId("providers-table", {}, { timeout: 4000 })).querySelector('[data-provider="deepseek"]') as HTMLElement;
    const caps = await within(card).findByTestId("model-caps");
    expect(caps).toHaveTextContent("上下文 64K");
    expect(caps).toHaveTextContent("能力来自内置模型目录");
    expect(caps).not.toHaveTextContent("识图");
  });

  it("配置里能把识图手动设为支持，也能一键检测；保存时带上能力设置", async () => {
    const { log } = renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    const card = (await screen.findByTestId("providers-table", {}, { timeout: 4000 })).querySelector('[data-provider="deepseek"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /配置/ }));
    const sheet = await screen.findByTestId("provider-sheet");
    const caps = await within(sheet).findByTestId("capability-settings");
    await waitFor(() => expect(caps).toHaveTextContent("自动：不支持 · 内置模型目录"));
    // 一键检测：发带图请求，模型认出颜色后设为「支持」
    fireEvent.click(within(caps).getByTestId("detect-vision"));
    expect(await within(caps).findByTestId("detect-vision-result")).toHaveTextContent("检测通过：模型认出了图片是蓝色");
    expect(log.filter((l) => l.path === "/api/agent/llm/test").pop()?.body).toMatchObject({ probe: "vision", provider: "deepseek", model: "deepseek-chat" });
    expect(within(within(caps).getByRole("group", { name: "识图" })).getByRole("button", { name: "支持" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(within(caps).getByTestId("provider-context-window"), { target: { value: "32000" } });
    fireEvent.click(within(sheet).getByTestId("provider-save"));
    await waitFor(() => expect(log.find((l) => l.path === "/api/agent/llm/providers/deepseek")?.body).toMatchObject({
      capabilities: { vision: true, reasoning: null, temperature: null, context_window: 32000 }, thinking: "provider_default",
    }));
  });

  it("换模型后能力回到自动；推理模型可选默认思考档位", async () => {
    const { log } = renderAt("/system/settings?ws=ws-demo-1", { role: "admin" });
    const card = (await screen.findByTestId("providers-table", {}, { timeout: 4000 })).querySelector('[data-provider="deepseek"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /配置/ }));
    const sheet = await screen.findByTestId("provider-sheet");
    const caps = await within(sheet).findByTestId("capability-settings");
    fireEvent.click(within(within(caps).getByRole("group", { name: "识图" })).getByRole("button", { name: "支持" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "手动输入" }));
    fireEvent.change(within(sheet).getByTestId("provider-model"), { target: { value: "o4-mini" } });
    const thinking = await within(sheet).findByTestId("provider-thinking", {}, { timeout: 3000 });
    expect(within(within(caps).getByRole("group", { name: "识图" })).getByRole("button", { name: "自动" })).toHaveAttribute("aria-pressed", "true");
    expect(caps).toHaveTextContent("自动：不发送温度");
    fireEvent.change(thinking, { target: { value: "high" } });
    fireEvent.click(within(sheet).getByTestId("provider-save"));
    await waitFor(() => expect(log.find((l) => l.path === "/api/agent/llm/providers/deepseek")?.body).toMatchObject({
      model: "o4-mini", thinking: "high", capabilities: { vision: null },
    }));
  });
});
