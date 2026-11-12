/**
 * 最小传输层：只产出 HttpOutcome（第 3 层事实），不做任何业务判定。
 * 只发同源相对路径（/api/...），由 Vite 代理到显式配置的本地 mock。
 */
import { clearLocalAuth, localAuthHeaders } from "./localAuth";
import type { HttpOutcome } from "../contracts/auth";

function assertSameOriginApi(path: string): void {
  if (!path.startsWith("/api/") || path.startsWith("//")) throw new Error(`只允许同源 /api 路径：${path}`);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** 业务请求遇到 401：登录态已失效（过期、被禁用）。登录相关接口自己处理 401，不算。 */
export const AUTH_LOST_EVENT = "lzcore:auth-lost";

export async function httpRequest(method: string, path: string, body?: unknown): Promise<HttpOutcome> {
  const first = await sendOnce(method, path, body);
  // 本地令牌失效（后端换了令牌）：鉴权层在进入任何业务处理之前就拒绝了，请求没有被执行；
  // 刷新令牌后只重试这一次。其他任何失败都不重试。
  if (first.kind === "http" && first.status === 403 && !/^(GET|HEAD|OPTIONS)$/i.test(method)
      && (first.body as { error?: unknown } | null)?.error === "local_token_required") {
    clearLocalAuth();
    return sendOnce(method, path, body);
  }
  if (first.kind === "http" && first.status === 401 && !path.startsWith("/api/auth/") && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  }
  return first;
}

async function sendOnce(method: string, path: string, body?: unknown): Promise<HttpOutcome> {
  assertSameOriginApi(path);
  let res: Response;
  try {
    const authHeaders = /^(GET|HEAD|OPTIONS)$/i.test(method) ? {} : await localAuthHeaders();
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...authHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { kind: "network_error", message: error instanceof Error ? error.message : String(error) };
  }
  // Vite 代理在目标不可达时返回 502/504 且无 JSON：视作后端不可达而非服务器错误。
  const parsed = await parseBody(res);
  if ((res.status === 502 || res.status === 503 || res.status === 504) && (parsed === null || typeof parsed === "string")) {
    return { kind: "network_error", message: `代理无法连接后端（HTTP ${res.status}）` };
  }
  return { kind: "http", status: res.status, body: parsed };
}

export const httpGet = (path: string) => httpRequest("GET", path);
