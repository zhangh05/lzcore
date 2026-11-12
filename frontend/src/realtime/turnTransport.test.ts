import { describe, expect, it, vi } from "vitest";
import { TurnTransport, type Frame, type TurnHandlers, type WebSocketLike } from "./turnTransport";

class FakeWs implements WebSocketLike {
  readyState = 0;
  sent: Frame[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onerror: WebSocketLike["onerror"] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(f: Frame) { this.onmessage?.({ data: JSON.stringify(f) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}

function handlers(): TurnHandlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onToken: (t) => log.push(`token:${t}`),
    onEvent: (n) => log.push(`event:${n}`),
    onDone: () => log.push("done"),
    onError: () => log.push("error"),
    onTransport: (s) => log.push(`transport:${s}`),
  };
}

describe("TurnTransport", () => {
  it("断线重连只发 resume（带 stream_seq），不重发 message", () => {
    const sockets: FakeWs[] = [];
    const timers: (() => void)[] = [];
    const t = new TurnTransport({ url: "ws://x/ws/agent", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; },
      readback: async () => false, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    const h = handlers();
    t.sendMessage({ workspaceId: "ws-demo-1", sessionId: "s1", text: "你好", clientRequestId: "cr1", handlers: h });
    sockets[0].open();
    expect(sockets[0].sent.map((f) => f.type)).toEqual(["message"]);
    expect((sockets[0].sent[0].metadata as Record<string, unknown>).client_request_id).toBe("cr1");
    sockets[0].push({ type: "token", content: "a", seq: 1, client_request_id: "cr1" });
    sockets[0].push({ type: "token", content: "b", seq: 2, client_request_id: "cr1" });
    sockets[0].drop();
    expect(h.log).toContain("transport:interrupted");
    timers.shift()!(); // reconnect timer (readback timer also queued)
    const reconnect = sockets[1] ?? (timers.shift()!(), sockets[1]);
    reconnect.open();
    expect(reconnect.sent).toEqual([{ type: "resume", workspace_id: "ws-demo-1", session_id: "s1", client_request_id: "cr1", stream_seq: 2 }]);
    expect(t.sent.filter((f) => f.type === "message")).toHaveLength(1);
    // 重复帧被丢弃
    reconnect.push({ type: "token", content: "b", seq: 2, client_request_id: "cr1" });
    reconnect.push({ type: "token", content: "c", seq: 3, client_request_id: "cr1" });
    reconnect.push({ type: "done", seq: 4, client_request_id: "cr1" });
    expect(h.log.filter((x) => x.startsWith("token"))).toEqual(["token:a", "token:b", "token:c"]);
    expect(h.log).toContain("done");
  });

  it("通道不可用时 2.5 秒回读兜底，服务端终态优先", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWs[] = [];
      const readback = vi.fn(async () => true);
      const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; }, readback });
      const h = handlers();
      t.sendMessage({ workspaceId: "w", sessionId: "s", text: "x", clientRequestId: "c", handlers: h });
      sockets[0].open();
      sockets[0].drop();
      await vi.advanceTimersByTimeAsync(2600);
      expect(readback).toHaveBeenCalledWith("s", "c");
      expect(h.log).toContain("transport:readback_terminal");
      expect(t.hasOpenTurn("s")).toBe(false);
      t.close();
    } finally { vi.useRealTimers(); }
  });

  it("续接任务是新 message 且带 metadata.resume_task_id", () => {
    const s = new FakeWs();
    const t = new TurnTransport({ url: "ws://x", wsFactory: () => s, readback: async () => false });
    t.sendMessage({ workspaceId: "w", sessionId: "s", text: "继续", clientRequestId: "c2", metadata: { resume_task_id: "task-9" }, handlers: handlers() });
    s.open();
    expect(s.sent[0]).toMatchObject({ type: "message", metadata: { resume_task_id: "task-9", client_request_id: "c2" } });
    t.close();
  });
  it("工作区广播（topology_updated）交给 onBroadcast，不混进进行中的回合", () => {
    const sockets: FakeWs[] = [];
    const seen: string[] = [];
    const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; },
      readback: async () => false, onBroadcast: (name, data) => seen.push(`${name}:${String(data.version)}`) });
    const h = handlers();
    t.sendMessage({ workspaceId: "w", sessionId: "s1", text: "画图", clientRequestId: "cr1", handlers: h });
    sockets[0].open();
    sockets[0].push({ type: "event", name: "topology_updated", data: { workspace_id: "w", topology_id: "t1", version: 3 } });
    expect(seen).toEqual(["topology_updated:3"]);
    expect(h.log).not.toContain("event:topology_updated");
  });

  it("resumeTurn 只发 resume 从头续传，不发 message", () => {
    const sockets: FakeWs[] = [];
    const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; }, readback: async () => false });
    const h = handlers();
    t.resumeTurn({ workspaceId: "w", sessionId: "s1", clientRequestId: "cr9", handlers: h });
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ type: "resume", workspace_id: "w", session_id: "s1", client_request_id: "cr9", stream_seq: 0 }]);
    sockets[0].push({ type: "token", content: "已", seq: 1, client_request_id: "cr9" });
    sockets[0].push({ type: "done", seq: 2, client_request_id: "cr9" });
    expect(h.log).toEqual(["transport:resumed", "token:已", "done"]);
    expect(t.hasOpenTurn("s1")).toBe(false);
  });
  it("subscribeBroadcasts 在每次连上（含重连）时发 ping 注册工作区", () => {
    const sockets: FakeWs[] = [];
    const timers: (() => void)[] = [];
    const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; },
      readback: async () => false, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    t.subscribeBroadcasts("w");
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ type: "ping", workspace_id: "w" }]);
    sockets[0].drop();
    timers.shift()!();
    sockets[1].open();
    expect(sockets[1].sent).toEqual([{ type: "ping", workspace_id: "w" }]);
  });

  describe("续传控制与幂等（前后端契约）", () => {
    function rig() {
      const sockets: FakeWs[] = [];
      const timers: (() => void)[] = [];
      const broadcasts: string[] = [];
      const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new FakeWs(); sockets.push(s); return s; },
        readback: async () => false, onBroadcast: (n, d) => broadcasts.push(`${n}:${String(d.job_id ?? "")}`),
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
      return { t, sockets, timers, broadcasts };
    }

    it("resume_pending 不是回合终态：保持跟踪、有界重试 resume，之后的帧照常送达", () => {
      const { t, sockets, timers } = rig();
      const h = handlers();
      t.resumeTurn({ workspaceId: "w", sessionId: "s1", clientRequestId: "cr1", handlers: h });
      sockets[0].open();
      sockets[0].push({ type: "error", error_code: "resume_pending", message: "resume_pending", session_id: "s1", client_request_id: "cr1" });
      expect(h.log).not.toContain("error");
      expect(t.hasOpenTurn("s1")).toBe(true);
      timers.forEach((fn) => fn());
      expect(sockets[0].sent.filter((f) => f.type === "resume")).toHaveLength(2);
      sockets[0].push({ type: "token", content: "x", seq: 1, client_request_id: "cr1" });
      sockets[0].push({ type: "done", seq: 2, client_request_id: "cr1" });
      expect(h.log).toEqual(expect.arrayContaining(["transport:interrupted", "token:x", "done"]));
      expect(t.sent.some((f) => f.type === "message")).toBe(false);
    });

    it("业务错误仍是终态", () => {
      const { t, sockets } = rig();
      const h = handlers();
      t.sendMessage({ workspaceId: "w", sessionId: "s1", text: "hi", clientRequestId: "cr1", handlers: h });
      sockets[0].open();
      sockets[0].push({ type: "error", message: "boom", client_request_id: "cr1" });
      expect(h.log).toContain("error");
      expect(t.hasOpenTurn("s1")).toBe(false);
    });

    it("job_updated 只按 active_turn 的请求 ID 归属；别的会话的更新走广播，不进唯一活动回合", () => {
      const { t, sockets, broadcasts } = rig();
      const h = handlers();
      t.sendMessage({ workspaceId: "w", sessionId: "s1", text: "hi", clientRequestId: "cr1", handlers: h });
      sockets[0].open();
      sockets[0].push({ type: "event", name: "job_updated", data: { job_id: "job_other", session_id: "s2", active_turn: { client_request_id: "cr_other" } } });
      expect(h.log).not.toContain("event:job_updated");
      expect(broadcasts).toEqual(["job_updated:job_other"]);
      sockets[0].push({ type: "event", name: "job_updated", data: { job_id: "job_mine", session_id: "s1", active_turn: { client_request_id: "cr1" } } });
      expect(h.log).toContain("event:job_updated");
    });

    it("幂等回执 done（idempotent_redirect.status=running）转为续传目标回合，不当终态", () => {
      const { t, sockets } = rig();
      const h = handlers();
      t.sendMessage({ workspaceId: "w", sessionId: "s1", text: "hi", clientRequestId: "cr_dup", handlers: h });
      sockets[0].open();
      sockets[0].push({ type: "done", client_request_id: "cr_dup", metadata: { idempotent: true, idempotent_redirect: { job_id: "job1", status: "running", client_request_id: "cr_real" } } });
      expect(h.log).not.toContain("done");
      expect(h.log).toContain("event:idempotent_redirect");
      expect(sockets[0].sent.at(-1)).toMatchObject({ type: "resume", client_request_id: "cr_real", stream_seq: 0 });
      sockets[0].push({ type: "done", seq: 5, client_request_id: "cr_real" });
      expect(h.log).toContain("done");
      expect(t.sent.filter((f) => f.type === "message")).toHaveLength(1);
    });

    it("幂等回执 status=succeeded 是正常终态", () => {
      const { t, sockets } = rig();
      const h = handlers();
      t.sendMessage({ workspaceId: "w", sessionId: "s1", text: "hi", clientRequestId: "cr1", handlers: h });
      sockets[0].open();
      sockets[0].push({ type: "done", client_request_id: "cr1", metadata: { idempotent_redirect: { status: "succeeded" } } });
      expect(h.log).toContain("done");
    });
  });
});
