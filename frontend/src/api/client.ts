/**
 * 数据层：基于 http.ts 的 HttpOutcome。不做业务判定；只把常见错误翻译成可展示的原因。
 */
import { localAuthHeaders } from "./localAuth";
import type { HttpOutcome } from "../contracts/auth";
import { httpRequest } from "./http";

export type Query = Record<string, string | number | boolean | undefined | null>;

export function apiPath(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

export const enc = encodeURIComponent;

export const api = {
  get: (path: string, query?: Query) => httpRequest("GET", apiPath(path, query)),
  post: (path: string, body?: unknown, query?: Query) => httpRequest("POST", apiPath(path, query), body ?? {}),
  put: (path: string, body?: unknown, query?: Query) => httpRequest("PUT", apiPath(path, query), body ?? {}),
  patch: (path: string, body?: unknown, query?: Query) => httpRequest("PATCH", apiPath(path, query), body ?? {}),
  del: (path: string, body?: unknown, query?: Query) => httpRequest("DELETE", apiPath(path, query), body),
};

export function isOk(o: HttpOutcome): o is { kind: "http"; status: number; body: unknown } {
  return o.kind === "http" && o.status >= 200 && o.status < 300;
}

export function bodyOf<T = Record<string, unknown>>(o: HttpOutcome): T | null {
  return o.kind === "http" && o.body && typeof o.body === "object" ? (o.body as T) : null;
}

/** 失败原因（中文）。401/403/409/501/网络错误各自不同，不混成「失败」。 */
export function describeFailure(o: HttpOutcome): string {
  if (o.kind === "network_error") return "无法连接服务（请求可能未送达；若是写操作，请先回读再决定）。";
  const b = (o.body ?? {}) as { error?: unknown; message?: unknown; errors?: unknown };
  const detail = [b.error, b.message, Array.isArray(b.errors) ? b.errors.join("; ") : undefined].filter(Boolean).join(" · ");
  switch (o.status) {
    case 401: return "需要登录或会话已过期。";
    case 403: return `当前账户无权执行此操作${detail ? `（${detail}）` : ""}。`;
    case 404: return `对象不存在${detail ? `（${detail}）` : ""}。`;
    case 409: return `版本或状态冲突${detail ? `（${detail}）` : ""}。`;
    case 501: return `此接口在当前环境未实现${detail ? `（${detail}）` : ""}。`;
    default: return `请求失败（HTTP ${o.status}${detail ? ` · ${detail}` : ""}）。`;
  }
}

/** 稳定 id：写操作的幂等键（记忆 memory_id、client_request_id 等）。 */
export function stableId(prefix: string): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${raw.slice(0, 24)}`;
}

/** multipart 上传（附件 / 知识）。只发同源 /api 路径。 */
export async function uploadMultipart(path: string, fields: Record<string, string>, file: File): Promise<HttpOutcome> {
  if (!path.startsWith("/api/")) throw new Error("只允许同源 /api 路径");
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", file);
  try {
    const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin", headers: await localAuthHeaders() });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { kind: "http", status: res.status, body };
  } catch (e) {
    return { kind: "network_error", message: e instanceof Error ? e.message : String(e) };
  }
}
