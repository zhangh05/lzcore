import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { CORE_FORBIDDEN_DOMAIN_WORDS } from "../contracts/naming";
import { BrowserRouter } from "../router";
import { installFixture, type FixtureOptions } from "./backendFixture";

function renderApp(opts?: FixtureOptions, url = "/") {
  window.history.replaceState({}, "", url);
  const backend = installFixture(opts);
  const utils = render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return { ...utils, backend };
}

async function ready() {
  await screen.findByRole("navigation", { name: "主导航" });
  await screen.findByTestId("workspace-switcher");
}

describe("应用壳", () => {
  it("单一左侧导航 + 扩展区由注册表生成（不可用扩展带标记）", async () => {
    renderApp();
    await ready();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["工作台", "任务", "资料", "工作流", "扩展区", "系统"]) expect(within(nav).getByText(label)).toBeInTheDocument();
    const ext = within(nav).getByTestId("nav-extensions");
    await within(ext).findByText("笔记看板");
    expect(within(ext).getByText("网络设备").closest("a")).toHaveClass("is-unavailable");
    expect(within(ext).getAllByText("不可用").length).toBeGreaterThan(0);
  });

  it("工作区切换器来自 /api/workspaces，没有写死 default，URL 带 ws", async () => {
    renderApp();
    await ready();
    const select = screen.getByTestId("workspace-switcher") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["ws-demo-1", "ws-demo-2"]);
    expect(select.innerHTML).not.toContain("default");
    expect(new URLSearchParams(window.location.search).get("ws")).toBe("ws-demo-1");
  });

  it("顶栏不再有全局「待核对」；/review 没有目标时回到任务页", async () => {
    renderApp(undefined, "/review?ws=ws-demo-1");
    await ready();
    expect(screen.queryByTestId("inbox-button")).toBeNull();
    expect(screen.queryByText("待核对")).toBeNull();
    await waitFor(() => expect(window.location.pathname).toBe("/tasks"));
  });

  it("Ctrl K 命令面板：第一项是「新建会话」，真的创建会话（阶段 2 起，见 workbench.test.tsx）", async () => {
    renderApp();
    await ready();
    act(() => { fireEvent.keyDown(window, { key: "k", ctrlKey: true }); });
    const palette = await screen.findByTestId("command-palette");
    expect(within(palette).getAllByRole("option")[0]).toHaveTextContent("新建会话");
  });

  it("不可用扩展路由：说明原因，不是 404", async () => {
    renderApp(undefined, "/extensions/network.operations/manage");
    await ready();
    const page = await screen.findByTestId("ext-unavailable");
    expect(page).toHaveTextContent("依赖未就绪");
    expect(document.body.textContent).not.toMatch(/404|页面不存在/);
  });

  it("未安装任何扩展：导航与扩展空态没有网络 / 运维词；旧网络路径给出「未安装」说明", async () => {
    renderApp({ extensions: "none" }, "/extensions/network.operations/manage");
    await ready();
    expect(await screen.findByTestId("ext-not-installed")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const w of CORE_FORBIDDEN_DOMAIN_WORDS) expect(nav.textContent).not.toContain(w);
    expect(screen.getByTestId("ext-not-installed").textContent).not.toMatch(/网络|运维|404/);
  });

  it("扩展目录读取失败：导航说明原因", async () => {
    renderApp({ extensions: "error" });
    await ready();
    expect(within(screen.getByTestId("nav-extensions")).getByText(/扩展目录不可读/)).toBeInTheDocument();
  });

  it("旧前端死路径不做静默重定向：说明找不到页面", async () => {
    renderApp(undefined, "/network");
    await ready();
    const page = await screen.findByTestId("placeholder-page");
    expect(page).toHaveTextContent("找不到页面");
    expect(window.location.pathname).toBe("/network");
  });

  it("头像菜单：主题、密度、设置、退出（未启用登录时说明无需退出）", async () => {
    renderApp();
    await ready();
    fireEvent.click(screen.getByTestId("avatar-button"));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toMatch(/^主题/);
    expect(items[1]).toMatch(/^密度/);
    expect(items[2]).toBe("设置");
    expect(items[3]).toContain("无需退出");
    fireEvent.click(within(menu).getByText(/^主题/));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("所有请求都是同源相对 /api 路径", async () => {
    const { backend } = renderApp();
    await ready();
    expect(backend.calls.length).toBeGreaterThan(0);
    for (const c of backend.calls) {
      expect(c.path.startsWith("/api/")).toBe(true);
      expect(c.path).not.toMatch(/8011|5273|localhost/);
    }
  });
});

describe("鉴权三态", () => {
  it("auth/status 网络失败 → 后端不可达（不是登录页）", async () => {
    renderApp({ authStatus: "network" });
    expect(await screen.findByTestId("auth-unreachable")).toHaveTextContent("后端不可达");
    expect(screen.queryByLabelText("密码")).toBeNull();
  });

  it("auth/status 500 → 服务器错误（不是登录页）", async () => {
    renderApp({ authStatus: "error" });
    expect(await screen.findByTestId("auth-server_error")).toHaveTextContent("服务器错误");
    expect(screen.queryByLabelText("密码")).toBeNull();
  });

  it("需要登录：通用文案、焦点在账户框、无 SSO；密码错与服务器错分开", async () => {
    renderApp({ login: "required" });
    const user = await screen.findByLabelText("账户");
    expect(document.activeElement).toBe(user);
    expect(document.body.textContent).not.toContain("运维");
    expect(document.body.textContent).toContain("Agent");
    expect(screen.queryByTestId("login-sso")).toBeNull();

    fireEvent.change(user, { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByTestId("login-error-invalid_credentials")).toHaveTextContent("账户或密码不正确");

    fireEvent.change(user, { target: { value: "server-error" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByTestId("login-error-server_error")).toHaveTextContent("与账户或密码无关");

    fireEvent.change(user, { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "demo-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await ready();
  });

  it("oidc_enabled 时保留企业单点登录入口，并注明未验收", async () => {
    renderApp({ login: "sso" });
    const sso = await screen.findByTestId("login-sso");
    expect(sso).toHaveAttribute("href", "/api/auth/oidc/start");
    expect(document.body.textContent).toContain("尚未在新前端验收");
  });
});
