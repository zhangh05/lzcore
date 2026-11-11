import { describe, expect, it } from "vitest";
import { inboxBadge, loadReviewInbox, reviewInboxPaths, type HttpGet } from "./reviewInbox";
import { pickCurrentWorkspace } from "./workspace";

function getter(map: Record<string, { status: number; body: unknown } | "net">): HttpGet {
  return async (path) => {
    const r = map[path] ?? (path.startsWith("/api/runtime/session-tasks") ? { status: 404, body: { ok: false } } : undefined);
    if (!r) throw new Error(`unexpected ${path}`);
    return r === "net" ? { kind: "network_error" } : { kind: "http", ...r };
  };
}

const ws = "ws-demo-1";
const p = reviewInboxPaths(ws);

describe("待核对收件箱汇总", () => {
  it("汇总三类来源；账本计入 planned/unknown/indeterminate/blocked；任务按 outcomeState 判定未知", async () => {
    const inbox = await loadReviewInbox(getter({
      [p.reviewItems]: { status: 200, body: { items: [{ item_id: "r1", artifact_id: "a1", status: "pending" }, { item_id: "r2", artifact_id: "a1", status: "accepted" }] } },
      [p.ledger]: { status: 200, body: { operations: [
        { operation_id: "o1", status: "unknown" }, { operation_id: "o2", status: "planned" }, { operation_id: "o3", status: "blocked" },
        { operation_id: "o4", status: "indeterminate" }, { operation_id: "o5", status: "succeeded" }, { operation_id: "o6", status: "reconciled" }] } },
      // 阶段 2–6 最小修复：任务来源 = 会话列表 + 各会话 task-state（durable runtime tasks 没有 outcome 字段）
      [p.sessions]: { status: 200, body: { sessions: [{ session_id: "s1" }, { session_id: "s4" }, { session_id: "s5" }, { session_id: "s6" }] } },
      [p.sessionTaskState("s1")]: { status: 200, body: { ok: true, task_state: { task: { task_id: "t1", status: "partial", unknowns: [{ kind: "unknown_outcome" }] } } } },
      [p.sessionTaskState("s4")]: { status: 200, body: { ok: true, task_state: { task: { task_id: "t4", status: "partial", unknowns: [{ kind: "unknown_outcome", reason: "回执丢失" }] } } } },
      [p.sessionTaskState("s5")]: { status: 200, body: { ok: true, task_state: { task: { task_id: "t5", status: "partial", unknowns: [] } } } },
      [p.sessionTaskState("s6")]: { status: 200, body: { ok: true, task_state: null } },
    }), ws);
    expect(inbox.entries.map((e) => e.key)).toEqual(["task:t1", "task:t4", "ledger:o1", "ledger:o2", "ledger:o3", "ledger:o4", "review_item:r1"]);
    expect(inbox.entries[0].href).toBe("/review?ws=ws-demo-1&source=task&id=t1&session=s1");
    expect(inbox.incomplete).toBe(false);
    for (const e of inbox.entries) {
      expect(e.action).toBe("verify");
      expect(e.href.startsWith("/review?ws=ws-demo-1")).toBe(true);
      expect(e.statusLabel).not.toMatch(/完成|成功/);
    }
    expect(inboxBadge(inbox).text).toBe("7");
  });

  it("来源 403 / 失败不当成 0：标记不完整", async () => {
    const inbox = await loadReviewInbox(getter({
      [p.reviewItems]: { status: 200, body: { items: [] } },
      [p.ledger]: { status: 403, body: { ok: false } },
      [p.sessions]: "net",
    }), ws);
    expect(inbox.sources.ledger.state).toBe("forbidden");
    expect(inbox.sources.task.state).toBe("error");
    expect(inbox.incomplete).toBe(true);
    expect(inboxBadge(inbox).text).toBe("0+");
  });

  it("全部为空 → 0 且完整", async () => {
    const inbox = await loadReviewInbox(getter({
      [p.reviewItems]: { status: 200, body: { items: [] } },
      [p.ledger]: { status: 200, body: { operations: [] } },
      [p.sessions]: { status: 200, body: { sessions: [] } },
    }), ws);
    expect(inbox.entries).toHaveLength(0);
    expect(inboxBadge(inbox)).toEqual({ text: "0", title: "暂无待核对项" });
  });
});

describe("会话 task-state 聚合（最小修复）", () => {
  it("单个会话 task-state 读失败 → 不完整，不当 0", async () => {
    const inbox = await loadReviewInbox(getter({
      [p.reviewItems]: { status: 200, body: { items: [] } },
      [p.ledger]: { status: 200, body: { operations: [] } },
      [p.sessions]: { status: 200, body: { sessions: [{ session_id: "s1" }] } },
      [p.sessionTaskState("s1")]: { status: 500, body: {} },
    }), ws);
    expect(inbox.sources.task.state).toBe("error");
    expect(inboxBadge(inbox).text).toBe("0+");
  });
  it("后端提供聚合接口时只发一次请求，不再逐会话读取", async () => {
    const seen: string[] = [];
    const base = getter({
      [p.reviewItems]: { status: 200, body: { items: [] } },
      [p.ledger]: { status: 200, body: { operations: [] } },
      [p.sessionTasks]: { status: 200, body: { ok: true, items: [
        { session_id: "s1", title: "周报", task: { task_id: "t1", status: "partial", unknowns: [{ kind: "unknown_outcome" }] } },
        { session_id: "s2", task: { task_id: "t2", status: "succeeded", unknowns: [] } },
      ], sessions_scanned: 2, truncated: false, errors: [] } },
    });
    const inbox = await loadReviewInbox(async (path) => { seen.push(path); return base(path); }, ws);
    expect(seen.some((x) => x.includes("/task-state"))).toBe(false);
    expect(seen.some((x) => x.startsWith("/api/sessions"))).toBe(false);
    expect(inbox.sources.task).toEqual({ state: "ok", count: 2 });
    expect(inbox.entries.filter((e) => e.source === "task")).toHaveLength(1);
  });
  it("聚合接口报告单会话失败或截断 → 不完整，不当 0", async () => {
    for (const extra of [{ errors: [{ session_id: "s9", reason: "boom" }] }, { truncated: true }]) {
      const inbox = await loadReviewInbox(getter({
        [p.reviewItems]: { status: 200, body: { items: [] } },
        [p.ledger]: { status: 200, body: { operations: [] } },
        [p.sessionTasks]: { status: 200, body: { ok: true, items: [], errors: [], truncated: false, ...extra } },
      }), ws);
      expect(inbox.sources.task.state).toBe("error");
      expect(inboxBadge(inbox).text).toBe("0+");
    }
  });
  it("taskHasUnknown 对 durable runtime task（无 outcome 字段）恒为 false：所以收件箱不再用它", async () => {
    const { taskHasUnknown } = await import("./reviewInbox");
    expect(taskHasUnknown({ task_id: "x", status: "failed" })).toBe(false);
  });
});

describe("工作区选择（禁止写死 default）", () => {
  const list = [{ workspace_id: "ws-demo-1" }, { workspace_id: "ws-demo-2" }];
  it("URL → 记忆 → home → 第一项", () => {
    expect(pickCurrentWorkspace(list, { fromUrl: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, { fromUrl: "nope", remembered: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, { home: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, {})).toBe("ws-demo-1");
  });
  it("列表里没有 default 时绝不返回 default", () => {
    expect(pickCurrentWorkspace(list, { fromUrl: "default", remembered: "default", home: "default" })).toBe("ws-demo-1");
    expect(pickCurrentWorkspace([], { home: "default" })).toBeNull();
  });
});
