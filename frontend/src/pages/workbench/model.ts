/** 工作台数据模型与纯函数（会话分组、附件约束、回合视图）。 */
import type { ToolCallFacts, TurnFacts, UnknownOutcomeFact } from "../../contracts/outcomeState";

export interface SessionSummary {
  session_id: string;
  title?: string;
  status?: "active" | "archived" | string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
  metadata?: Record<string, unknown> | null;
}

export interface StageOutput { stage?: string; title?: string; summary?: string; status?: string }

export interface ChatMessage {
  message_id?: string;
  role: "user" | "assistant" | string;
  content: string;
  created_at?: string;
  run_id?: string;
  ok?: boolean;
  errors?: string[];
  metadata?: {
    client_request_id?: string;
    execution_outcome?: string;
    tool_execution_outcome?: string;
    unknown_outcome?: UnknownOutcomeFact | null;
    stage_outputs?: StageOutput[];
    tool_calls?: (ToolCallFacts & { summary?: string; result?: Record<string, unknown> })[];
    task_id?: string;
    operation_id?: string;
    cancelled?: boolean;
    [k: string]: unknown;
  } | null;
}

export function turnFacts(m: ChatMessage): TurnFacts {
  return { ok: m.ok, errors: m.errors, metadata: m.metadata ?? {} };
}

/** 按日分组（本地日期），新的在前。 */
export function groupSessionsByDay(list: SessionSummary[], now = new Date()): { label: string; items: SessionSummary[] }[] {
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const today = day(now);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const yesterday = day(y);
  const groups = new Map<string, SessionSummary[]>();
  const sorted = [...list].sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  for (const s of sorted) {
    const raw = s.updated_at ?? s.created_at;
    const d = raw ? new Date(raw) : null;
    const key = !d || Number.isNaN(d.getTime()) ? "更早" : day(d) === today ? "今天" : day(d) === yesterday ? "昨天" : d.toLocaleDateString("zh-CN");
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

export function filterSessions(list: SessionSummary[], q: string): SessionSummary[] {
  const t = q.trim().toLowerCase();
  return t ? list.filter((s) => (s.title ?? "").toLowerCase().includes(t) || s.session_id.toLowerCase().includes(t)) : list;
}

// ── 附件约束（迁自旧工作台：8 个上限、图片 5MB、文件 100MB） ──
export const ATTACHMENT_LIMITS = { maxCount: 8, maxImageBytes: 5 * 1024 * 1024, maxFileBytes: 100 * 1024 * 1024 } as const;

export interface PendingAttachment { id: string; name: string; size: number; kind: "image" | "file"; source: "upload" | "paste" | "drop" | "managed"; file_id?: string; file?: File }

export function attachmentKind(mime: string): "image" | "file" { return mime.startsWith("image/") ? "image" : "file"; }

export function admitAttachments(current: PendingAttachment[], incoming: PendingAttachment[]): { accepted: PendingAttachment[]; rejected: { name: string; reason: string }[] } {
  const accepted = [...current];
  const rejected: { name: string; reason: string }[] = [];
  for (const a of incoming) {
    if (accepted.length >= ATTACHMENT_LIMITS.maxCount) { rejected.push({ name: a.name, reason: `最多 ${ATTACHMENT_LIMITS.maxCount} 个附件` }); continue; }
    if (a.kind === "image" && a.size > ATTACHMENT_LIMITS.maxImageBytes) { rejected.push({ name: a.name, reason: "图片不能超过 5MB" }); continue; }
    if (a.kind === "file" && a.size > ATTACHMENT_LIMITS.maxFileBytes) { rejected.push({ name: a.name, reason: "文件不能超过 100MB" }); continue; }
    if (a.file_id && accepted.some((x) => x.file_id === a.file_id)) { rejected.push({ name: a.name, reason: "已添加" }); continue; }
    accepted.push(a);
  }
  return { accepted, rejected };
}

/** Skill / 资源范围是否锁定：运行中，或会话已绑定绘图。 */
export function scopeLocked(running: boolean, bound: boolean): { locked: boolean; reason?: string } {
  if (running) return { locked: true, reason: "运行中不能更改 Skill 与资源范围。" };
  if (bound) return { locked: true, reason: "本会话已绑定资源，Skill 与资源范围已锁定。" };
  return { locked: false };
}

/** 未知告警深链：优先会话任务（task-state），其次账本记录，最后按会话过滤的待核对页。 */
export function unknownTargetHref(ws: string, sessionId: string, taskId?: string, operationId?: string): string {
  const base = `/review?ws=${encodeURIComponent(ws)}`;
  if (taskId) return `${base}&source=task&id=${encodeURIComponent(taskId)}&session=${encodeURIComponent(sessionId)}`;
  if (operationId) return `${base}&source=ledger&id=${encodeURIComponent(operationId)}`;
  return `${base}&session=${encodeURIComponent(sessionId)}`;
}

export type StopState = "idle" | "requesting" | "requested" | "failed" | "no_job";

export function stopLabel(s: StopState): string {
  switch (s) {
    case "idle": return "停止";
    case "requesting": return "正在请求停止…";
    case "requested": return "已请求停止 · 等待终态确认";
    case "failed": return "停止请求失败";
    case "no_job": return "尚未拿到作业编号，暂不能停止";
  }
}

/** 回合终态的界面文案：cancelled 与 unknown 分开，不都映射成 error（W-5）。 */
export function terminalKind(m: ChatMessage): "cancelled" | "error" | "normal" {
  if (m.metadata?.cancelled) return "cancelled";
  if (m.errors && m.errors.length && m.metadata?.execution_outcome !== "unknown") return "error";
  return "normal";
}
