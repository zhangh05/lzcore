export type ApiErrorCode = "network" | "timeout" | "rate_limited" | "http_4xx" | "http_5xx" | "parse" | "aborted" | "unknown";
export interface ApiError {
  ok: false;
  status: number;
  code: ApiErrorCode;
  message: string;
  request_id?: string;
  details?: unknown;
  url?: string;
  timestamp: string;
}
export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "ok" in e && (e as { ok: unknown }).ok === false && "code" in e && "message" in e;
}
