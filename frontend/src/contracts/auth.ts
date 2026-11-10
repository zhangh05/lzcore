/**
 * 鉴权三态契约（P-18）：需要登录 / 后端不可达 / 服务器错误 / 账户或密码错误 必须分开。
 * `/api/auth/status` 失败不得说成「需要登录」。
 */

export interface AuthStatus {
  ok?: boolean;
  login_enabled: boolean;
  authenticated: boolean;
  username?: string;
  role?: string;
  organization_id?: string;
  workspace_ids?: string[];
  home_workspace_id?: string;
  identity_enabled?: boolean;
  oidc_enabled?: boolean;
  platform_admin?: boolean;
  auth_type?: "api_token" | "session" | "none" | string;
}

/** 一次 HTTP 调用的原始结局；由 api 层产出，判定在这里做。 */
export type HttpOutcome =
  | { kind: "network_error"; message?: string }
  | { kind: "http"; status: number; body: unknown };

export type AuthGate =
  | { kind: "checking" }
  | { kind: "backend_unreachable"; detail: string }
  | { kind: "server_error"; status: number; detail: string }
  | { kind: "login_required"; oidcEnabled: boolean }
  | { kind: "signed_in"; status: AuthStatus }
  | { kind: "open"; status: AuthStatus };

function isAuthStatus(body: unknown): body is AuthStatus {
  const b = body as AuthStatus;
  return !!b && typeof b.login_enabled === "boolean" && typeof b.authenticated === "boolean";
}

export function classifyAuthStatus(outcome: HttpOutcome): AuthGate {
  if (outcome.kind === "network_error") {
    return { kind: "backend_unreachable", detail: "无法连接服务。请确认后端已启动、地址正确，然后重试。" };
  }
  const { status, body } = outcome;
  if (status >= 500 || status === 0) return { kind: "server_error", status, detail: `服务返回错误（HTTP ${status}），与登录凭据无关。` };
  if (status !== 200 || !isAuthStatus(body)) {
    return { kind: "server_error", status, detail: `登录状态接口返回无法识别的结果（HTTP ${status}）。` };
  }
  if (body.authenticated) return { kind: "signed_in", status: body };
  if (!body.login_enabled) return { kind: "open", status: body };
  return { kind: "login_required", oidcEnabled: !!body.oidc_enabled };
}

export type LoginResult =
  | { kind: "ok" }
  | { kind: "invalid_credentials"; message: string }
  | { kind: "login_disabled"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "server_error"; message: string }
  | { kind: "backend_unreachable"; message: string };

export function classifyLoginResponse(outcome: HttpOutcome): LoginResult {
  if (outcome.kind === "network_error") return { kind: "backend_unreachable", message: "无法连接服务，登录请求没有送达。" };
  const { status, body } = outcome;
  if (status === 200 && (body as { ok?: boolean })?.ok) return { kind: "ok" };
  if (status === 401) return { kind: "invalid_credentials", message: "账户或密码不正确。" };
  if (status === 404 && (body as { error?: string })?.error === "login_disabled") return { kind: "login_disabled", message: "此服务未启用登录。" };
  if (status === 429) return { kind: "rate_limited", message: "尝试次数过多，请稍后再试。" };
  return { kind: "server_error", message: `服务器错误（HTTP ${status}），与账户或密码无关，请稍后重试。` };
}

/** API token 模式下隐藏退出（4.3「壳」）。 */
export function canSignOut(status?: AuthStatus): boolean {
  return !!status && status.login_enabled && status.auth_type === "session";
}

export const LOGIN_COPY = {
  title: "登录联智中枢",
  subtitle: "通用 Agent 工作平台：在工作区里与 Agent 协作完成任务、管理资料和工作流。",
  username: "账户",
  password: "密码",
  submit: "登录",
  sso: "使用企业单点登录",
  ssoNote: "企业单点登录入口已保留；完整流程尚未在新前端验收。",
} as const;
