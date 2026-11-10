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
});
