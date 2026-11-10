import { apiRequest } from "./api/client";

export interface LegacySession { session_id: string; title?: string; status?: string; metadata?: Record<string, unknown> }

export const sessionsApi = {
  list: (workspace_id: string, status?: string) =>
    apiRequest<{ sessions: LegacySession[] }>({ method: "GET", url: "/sessions", params: { workspace_id, status: status || "active", limit: 200 } }),
  get: (session_id: string, workspace_id: string) =>
    apiRequest<{ session: LegacySession }>({ method: "GET", url: `/sessions/${encodeURIComponent(session_id)}`, params: { workspace_id } }),
  create: (workspace_id: string, title?: string, metadata?: Record<string, unknown>) =>
    apiRequest<{ ok: boolean; session: LegacySession }>({ method: "POST", url: "/sessions", data: { workspace_id, title: title || "", metadata: metadata || {} } }),
  rename: (session_id: string, workspace_id: string, title: string) =>
    apiRequest<{ ok: boolean; session: LegacySession }>({ method: "PUT", url: `/sessions/${encodeURIComponent(session_id)}`, params: { workspace_id }, data: { title } }),
};
