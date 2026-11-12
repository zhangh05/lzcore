/** Public selection proposal. The server resolves scope and permissions. */
export interface WorkbenchSelection {
  extension_id: string;
  skill_id: string;
  skill_name: string;
  resource_ids: string[];
  allow_edit: boolean;
}
export function readWorkbenchSelection(raw: unknown): WorkbenchSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.extension_id !== "string" || !value.extension_id || typeof value.skill_id !== "string" || !value.skill_id || !Array.isArray(value.resource_ids) || !value.resource_ids.every((id) => typeof id === "string")) return null;
  return { extension_id: value.extension_id, skill_id: value.skill_id, skill_name: typeof value.skill_name === "string" ? value.skill_name : value.skill_id, resource_ids: value.resource_ids as string[], allow_edit: value.allow_edit === true };
}

/**
 * 扩展触发的「会话将继续执行」（例如审批通过后服务端自动续接）。工作台收到后去找该会话正在执行的回合并只续传，
 * 不重发任何消息。detail 里的字段都可缺省，缺了就按会话查找活动回合。
 */
export const SESSION_CONTINUATION_EVENT = "lzcore:session-continuation";
export interface SessionContinuation { session_id?: string; client_request_id?: string; job_id?: string }
export function announceSessionContinuation(detail: SessionContinuation) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<SessionContinuation>(SESSION_CONTINUATION_EVENT, { detail }));
}
