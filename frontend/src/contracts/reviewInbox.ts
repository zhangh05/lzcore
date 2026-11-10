/**
 * 待核对收件箱数据源（阶段 0 冻结，A18-审阅）。三类来源汇总：
 *   1. review-items：`GET /api/workspaces/<ws>/review-items?status=pending`
 *      （按 artifact：`/api/workspaces/<ws>/artifacts/<artifact_id>/review-items`；
 *       标记：`PUT /api/review-items/<id>?workspace_id=&artifact_id=`）
 *   2. 写操作账本：`GET /api/admin/operation-ledger?workspace_id=<ws>`，
 *      planned / running / unknown / indeterminate / blocked 都计入（W-12）
 *   3. runtime 任务中的未知项：`GET /api/runtime/tasks?workspace_id=<ws>`，按 taskHasUnknown 判定
 *      （字段来源待阶段 3 与后端确认，见 taskHasUnknown 注释）
 * 任一来源不可读（403 / 失败）都要如实标出，不能当成 0 条。
 */
import { deriveGoalState, type UnknownOutcomeFact } from "./outcomeState";
import type { HttpOutcome } from "./auth";

export interface ReviewItem {
  item_id: string;
  workspace_id?: string;
  artifact_id: string;
  title?: string;
  severity?: "info" | "warning" | "error" | string;
  category?: string;
  reason?: string;
  status?: "pending" | "accepted" | "ignored" | "modified" | string;
  updated_at?: string;
}

export interface LedgerOperation {
  operation_id: string;
  status: string;
  canonical_tool?: string;
  tool_id?: string;
  task_id?: string;
  turn_id?: string;
  session_id?: string;
  result_summary?: string;
  updated_at?: string;
}

export interface RuntimeTaskSummary {
  task_id: string;
  status?: string;
  title?: string;
  goal?: string;
  session_id?: string;
  execution_outcome?: string;
  unknown_outcome?: UnknownOutcomeFact | null;
  metadata?: { execution_outcome?: string; unknown_outcome?: UnknownOutcomeFact | null } | null;
  /** 会话 task-state 形态（agent/runtime/task_state.py:556 `_unknowns_from_metadata`，已排除 reconciled）。 */
  unknowns?: { kind?: string; reason?: string }[];
  updated_at?: string;
}

/**
 * 任务是否含未知项。只读服务端字段：
 * - `execution_outcome` / `unknown_outcome`（顶层或 metadata，按 deriveGoalState）
 * - 会话 task-state 的 `unknowns` 非空
 * 注意（基线 f1664ce 源码判断）：`GET /api/runtime/tasks` 返回的 durable TaskState
 * （agent/runtime/durable/models.py:53-62）没有上述字段。
 * 阶段 2–6 最小修复：收件箱的任务来源改为「会话列表 + 每个会话的 task-state」聚合
 * （`/api/runtime/sessions/<sid>/task-state` 的 `task_state.task.unknowns`）。
 */
export function taskHasUnknown(t: RuntimeTaskSummary): boolean {
  if (Array.isArray(t.unknowns) && t.unknowns.length > 0) return true;
  return deriveGoalState({
    metadata: {
      execution_outcome: t.execution_outcome ?? t.metadata?.execution_outcome,
      unknown_outcome: t.unknown_outcome ?? t.metadata?.unknown_outcome,
    },
  }) === "unknown";
}

export const LEDGER_PENDING_STATUSES: ReadonlySet<string> = new Set(["planned", "running", "unknown", "indeterminate", "blocked"]);

export type InboxSource = "review_item" | "ledger" | "task";

export const INBOX_SOURCE_LABEL: Readonly<Record<InboxSource, string>> = {
  review_item: "审阅项",
  ledger: "写操作账本",
  task: "任务",
};

export interface InboxEntry {
  key: string;
  source: InboxSource;
  id: string;
  title: string;
  detail: string;
  statusLabel: string;
  tone: "warn" | "unknown" | "danger" | "info";
  /** 深链到可核对的那一条（W-13）。 */
  href: string;
  /** 唯一动作：去核对。永远没有一键重试。 */
  action: "verify";
  updatedAt?: string;
}

export type SourceStatus =
  | { state: "ok"; count: number }
  | { state: "forbidden"; reason: string }
  | { state: "error"; reason: string };

export interface ReviewInbox {
  workspaceId: string;
  entries: InboxEntry[];
  sources: Record<InboxSource, SourceStatus>;
  /** 任一来源不可读 → 计数不完整。 */
  incomplete: boolean;
}

const LEDGER_STATUS_LABEL: Record<string, string> = {
  planned: "已计划 · 未确认执行",
  running: "执行中 · 未确认结果",
  unknown: "结果未知 · 需核对",
  indeterminate: "无法判定 · 需核对",
  blocked: "已阻断 · 需处理",
};

export function reviewItemEntries(items: ReviewItem[], ws: string): InboxEntry[] {
  return items.filter((i) => (i.status ?? "pending") === "pending").map((i) => ({
    key: `review_item:${i.item_id}`,
    source: "review_item" as const,
    id: i.item_id,
    title: i.title || "人工复核",
    detail: i.reason || "",
    statusLabel: "待审阅",
    tone: i.severity === "error" ? "danger" as const : "warn" as const,
    href: `/review?ws=${encodeURIComponent(ws)}&source=review_item&id=${encodeURIComponent(i.item_id)}&artifact=${encodeURIComponent(i.artifact_id)}`,
    action: "verify" as const,
    updatedAt: i.updated_at,
  }));
}

export function ledgerEntries(ops: LedgerOperation[], ws: string): InboxEntry[] {
  return ops.filter((o) => LEDGER_PENDING_STATUSES.has(o.status)).map((o) => ({
    key: `ledger:${o.operation_id}`,
    source: "ledger" as const,
    id: o.operation_id,
    title: o.canonical_tool || o.tool_id || "写操作",
    detail: o.result_summary || "",
    statusLabel: LEDGER_STATUS_LABEL[o.status] ?? o.status,
    tone: o.status === "unknown" || o.status === "indeterminate" ? "unknown" as const : "warn" as const,
    href: `/review?ws=${encodeURIComponent(ws)}&source=ledger&id=${encodeURIComponent(o.operation_id)}`,
    action: "verify" as const,
    updatedAt: o.updated_at,
  }));
}

export function taskEntries(tasks: RuntimeTaskSummary[], ws: string): InboxEntry[] {
  return tasks.filter(taskHasUnknown).map((t) => ({
    key: `task:${t.task_id}`,
    source: "task" as const,
    id: t.task_id,
    title: t.title || t.goal || t.task_id,
    detail: "任务含结果未知的写入，需先核对再续接。",
    statusLabel: "结果未知 · 需核对",
    tone: "unknown" as const,
    href: `/review?ws=${encodeURIComponent(ws)}&source=task&id=${encodeURIComponent(t.task_id)}${t.session_id ? `&session=${encodeURIComponent(t.session_id)}` : ""}`,
    action: "verify" as const,
    updatedAt: t.updated_at,
  }));
}

function sourceFrom(outcome: HttpOutcome, listKey: string): { status: SourceStatus; list: unknown[] } {
  if (outcome.kind === "network_error") return { status: { state: "error", reason: "无法连接服务" }, list: [] };
  if (outcome.status === 401 || outcome.status === 403) {
    return { status: { state: "forbidden", reason: "当前账户无权读取此来源，计数不含该来源。" }, list: [] };
  }
  const list = (outcome.body as Record<string, unknown> | null)?.[listKey];
  if (outcome.status !== 200 || !Array.isArray(list)) {
    return { status: { state: "error", reason: `读取失败（HTTP ${outcome.status}）` }, list: [] };
  }
  return { status: { state: "ok", count: list.length }, list };
}

/** HTTP 读取器接口：阶段 1 由 api 层实现（mock），测试里注入假实现，不发真实请求。 */
export type HttpGet = (path: string) => Promise<HttpOutcome>;

export function reviewInboxPaths(ws: string) {
  const w = encodeURIComponent(ws);
  return {
    reviewItems: `/api/workspaces/${w}/review-items?status=pending`,
    ledger: `/api/admin/operation-ledger?workspace_id=${w}&limit=200`,
    /** 0–1 时的来源；仅保留路径供任务中心使用，收件箱不再用它判定未知（字段缺失）。 */
    tasks: `/api/runtime/tasks?workspace_id=${w}`,
    sessions: `/api/sessions?workspace_id=${w}&status=active&limit=${INBOX_SESSION_LIMIT}`,
    sessionTaskState: (sid: string) => `/api/runtime/sessions/${encodeURIComponent(sid)}/task-state?workspace_id=${w}`,
  };
}

/** 聚合时最多看最近这么多个会话；超过时标记不完整，不说成 0。 */
export const INBOX_SESSION_LIMIT = 50;

interface SessionTaskStateBody { task_state?: { task?: { task_id?: string; objective?: string; status?: string; unknowns?: { kind?: string; reason?: string }[] } | null } | null }

/** 会话 task-state 聚合：返回有任务的会话的任务摘要；任一会话读失败 → 来源标记 error。 */
async function loadSessionTasks(get: HttpGet, ws: string): Promise<{ status: SourceStatus; list: RuntimeTaskSummary[] }> {
  const paths = reviewInboxPaths(ws);
  const s = sourceFrom(await get(paths.sessions), "sessions");
  if (s.status.state !== "ok") return { status: s.status, list: [] };
  const sessions = s.list as { session_id: string; title?: string }[];
  const results = await Promise.all(sessions.map((x) => get(paths.sessionTaskState(x.session_id))));
  const list: RuntimeTaskSummary[] = [];
  let failed = 0;
  results.forEach((o, i) => {
    if (o.kind !== "http" || (o.status !== 200 && o.status !== 404)) { failed += 1; return; }
    const task = (o.body as SessionTaskStateBody | null)?.task_state?.task;
    if (!task?.task_id) return;
    list.push({ task_id: task.task_id, status: task.status, title: task.objective || sessions[i].title, session_id: sessions[i].session_id, unknowns: task.unknowns ?? [] });
  });
  if (failed) return { status: { state: "error", reason: `${failed} 个会话的任务状态不可读，计数不完整` }, list };
  if (sessions.length >= INBOX_SESSION_LIMIT) return { status: { state: "error", reason: `只聚合了最近 ${INBOX_SESSION_LIMIT} 个会话，计数可能不完整` }, list };
  return { status: { state: "ok", count: list.length }, list };
}

export async function loadReviewInbox(get: HttpGet, ws: string): Promise<ReviewInbox> {
  const paths = reviewInboxPaths(ws);
  const [r, l, tasks] = await Promise.all([get(paths.reviewItems), get(paths.ledger), loadSessionTasks(get, ws)]);
  const reviews = sourceFrom(r, "items");
  const ledger = sourceFrom(l, "operations");
  const entries = [
    ...taskEntries(tasks.list, ws),
    ...ledgerEntries(ledger.list as LedgerOperation[], ws),
    ...reviewItemEntries(reviews.list as ReviewItem[], ws),
  ];
  const sources = { review_item: reviews.status, ledger: ledger.status, task: tasks.status };
  return { workspaceId: ws, entries, sources, incomplete: Object.values(sources).some((s) => s.state !== "ok") };
}

/** 顶栏徽标文案：不完整时加「+」并给出原因提示，不把不可读当 0。 */
export function inboxBadge(inbox: ReviewInbox | null): { text: string; title: string } {
  if (!inbox) return { text: "…", title: "待核对读取中" };
  const n = inbox.entries.length;
  if (inbox.incomplete) return { text: `${n}+`, title: `待核对 ${n} 项；部分来源不可读，实际可能更多` };
  return { text: String(n), title: n ? `待核对 ${n} 项` : "暂无待核对项" };
}
