import { describe, expect, it } from "vitest";
import { canSignOut, classifyAuthStatus, classifyLoginResponse, LOGIN_COPY } from "./auth";

const base = { ok: true, login_enabled: true, authenticated: false };

describe("登录三态区分（P-18）", () => {
  it("网络失败 → 后端不可达，不是需要登录", () => {
    expect(classifyAuthStatus({ kind: "network_error" }).kind).toBe("backend_unreachable");
  });
  it("5xx / 非预期结构 → 服务器错误，不是需要登录", () => {
    expect(classifyAuthStatus({ kind: "http", status: 500, body: {} }).kind).toBe("server_error");
    expect(classifyAuthStatus({ kind: "http", status: 200, body: "<html>" }).kind).toBe("server_error");
  });
  it("login_enabled 且未登录 → 需要登录（带 oidc 标志）", () => {
    expect(classifyAuthStatus({ kind: "http", status: 200, body: { ...base, oidc_enabled: true } })).toEqual({ kind: "login_required", oidcEnabled: true });
  });
  it("未启用登录 → open；已登录 → signed_in", () => {
    expect(classifyAuthStatus({ kind: "http", status: 200, body: { ...base, login_enabled: false } }).kind).toBe("open");
    expect(classifyAuthStatus({ kind: "http", status: 200, body: { ...base, authenticated: true } }).kind).toBe("signed_in");
  });
  it("登录响应：401 = 账户或密码错误；500 = 服务器错误（不说成密码错）", () => {
    expect(classifyLoginResponse({ kind: "http", status: 401, body: {} }).kind).toBe("invalid_credentials");
    const s = classifyLoginResponse({ kind: "http", status: 500, body: {} });
    expect(s.kind).toBe("server_error");
    if (s.kind === "server_error") expect(s.message).toContain("与账户或密码无关");
    expect(classifyLoginResponse({ kind: "network_error" }).kind).toBe("backend_unreachable");
    expect(classifyLoginResponse({ kind: "http", status: 200, body: { ok: true } }).kind).toBe("ok");
  });
  it("登录文案是通用 Agent 平台，不提运维", () => {
    const text = Object.values(LOGIN_COPY).join(" ");
    expect(text).not.toContain("运维");
    expect(text).toContain("Agent");
    expect(LOGIN_COPY.ssoNote).toContain("尚未");
  });
  it("API token 模式不显示退出", () => {
    expect(canSignOut({ ...base, authenticated: true, auth_type: "api_token" })).toBe(false);
    expect(canSignOut({ ...base, authenticated: true, auth_type: "session" })).toBe(true);
  });
});
