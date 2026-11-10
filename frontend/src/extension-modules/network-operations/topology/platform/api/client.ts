/** 旧 apiRequest 的适配：走新传输层 httpRequest（同源 /api），失败抛旧形状 ApiError。 */
import { httpRequest } from "../../../../../api/http";
import type { ApiError, ApiErrorCode } from "../types";

export interface LegacyRequestConfig {
  method?: string;
  url: string;
  params?: Record<string, unknown>;
  // 与旧 axios 配置同形（旧代码与旧测试按 any 使用）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

function withQuery(url: string, params?: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
}

function mkError(code: ApiErrorCode, status: number, message: string, url: string, details?: unknown): ApiError {
  return { ok: false, code, status, message, url, details, timestamp: new Date().toISOString() };
}

export async function apiRequest<T = unknown>(config: LegacyRequestConfig, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw mkError("aborted", 0, "请求已取消", config.url);
  const path = withQuery(`/api${config.url.startsWith("/") ? "" : "/"}${config.url}`, config.params);
  const method = (config.method ?? "GET").toUpperCase();
  const o = await httpRequest(method, path, method === "GET" ? undefined : (config.data ?? {}));
  if (signal?.aborted) throw mkError("aborted", 0, "请求已取消", path);
  if (o.kind === "network_error") throw mkError("network", 0, "后端不可达", path);
  if (o.status >= 200 && o.status < 300) return o.body as T;
  const body = (o.body ?? {}) as { message?: string; error?: string; summary?: string };
  const msg = body.message || body.error || body.summary || `请求失败（HTTP ${o.status}）`;
  const code: ApiErrorCode = o.status === 408 ? "timeout" : o.status === 429 ? "rate_limited" : o.status >= 500 ? "http_5xx" : "http_4xx";
  throw mkError(code, o.status, msg, path, o.body);
}
