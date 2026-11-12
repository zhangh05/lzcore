import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AUTH_LOST_EVENT, httpRequest } from "../api/http";
import { clearLocalAuth } from "../api/localAuth";
import { LoadMore, usePaged } from "../kit/usePaged";
import { TurnTransport, type Frame, type WebSocketLike } from "../realtime/turnTransport";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

describe("T03 本地令牌失效", () => {
  it("写请求被 local_token_required 拒绝：刷新令牌后只重试一次", async () => {
    clearLocalAuth();
    let tokens = 0; const writes: string[] = [];
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      if (path === "/api/local-token") return json({ token: `t${++tokens}` });
      writes.push(new Headers(init?.headers).get("X-LZCore-Local-Token") ?? "");
      return writes.length === 1 ? json({ ok: false, error: "local_token_required" }, 403) : json({ ok: true });
    }) as typeof fetch;
    const o = await httpRequest("POST", "/api/sessions", {});
    expect(o).toMatchObject({ kind: "http", status: 200 });
    expect(writes).toEqual(["t1", "t2"]);
  });

  it("其它 403 不重试", async () => {
    clearLocalAuth();
    let writes = 0;
    globalThis.fetch = (async (path: string) => path === "/api/local-token" ? json({ token: "t" }) : (writes++, json({ error: "forbidden" }, 403))) as typeof fetch;
    await httpRequest("POST", "/api/sessions", {});
    expect(writes).toBe(1);
  });

  it("WS 首帧鉴权被拒：未受理的新消息如实报「未受理」，不自动重发；并刷新凭据", () => {
    class Ws implements WebSocketLike {
      readyState = 0; sent: Frame[] = [];
      onopen: WebSocketLike["onopen"] = null; onclose: WebSocketLike["onclose"] = null; onmessage: WebSocketLike["onmessage"] = null; onerror: WebSocketLike["onerror"] = null;
      send(d: string) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; }
    }
    const sockets: Ws[] = []; let refreshed = 0; const errors: Frame[] = [];
    const t = new TurnTransport({ url: "ws://x", wsFactory: () => { const s = new Ws(); sockets.push(s); return s; }, readback: async () => false,
      onAuthRejected: () => { refreshed++; }, setTimer: () => 0, clearTimer: () => undefined });
    t.sendMessage({ workspaceId: "w", sessionId: "s", text: "hi", clientRequestId: "cr1", handlers: { onToken: () => {}, onEvent: () => {}, onDone: () => {}, onError: (f) => errors.push(f), onTransport: () => {} } });
    sockets[0].readyState = 1; sockets[0].onopen?.({});
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "error", message: "local_token_required" }) });
    expect(errors[0]).toMatchObject({ not_accepted: true });
    expect(refreshed).toBe(1);
    expect(t.sent.filter((f) => f.type === "message")).toHaveLength(1);
  });
});

describe("T04 登录态失效", () => {
  it("业务请求 401 广播 auth-lost；登录接口自身的 401 不广播", async () => {
    let fired = 0; const on = () => { fired++; };
    window.addEventListener(AUTH_LOST_EVENT, on);
    globalThis.fetch = (async () => json({ error: "unauthorized" }, 401)) as typeof fetch;
    await httpRequest("GET", "/api/workspaces");
    await httpRequest("GET", "/api/auth/status");
    window.removeEventListener(AUTH_LOST_EVENT, on);
    expect(fired).toBe(1);
  });
});

describe("F10 分页", () => {
  function List() {
    const p = usePaged<{ id: string }>("/api/storage/files", { workspace_id: "w" }, { listKey: "files", param: "cursor", next: "next_cursor" });
    return <div><ul>{p.items.map((x) => <li key={x.id}>{x.id}</li>)}</ul><LoadMore paged={p} /></div>;
  }
  it("按服务端 next_cursor 追加下一页，并显示已加载/总数", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (path: string) => {
      seen.push(path);
      return path.includes("cursor=c2") ? json({ files: [{ id: "b" }], total: 2, next_cursor: "" }) : json({ files: [{ id: "a" }], total: 2, next_cursor: "c2" });
    }) as typeof fetch;
    render(<List />);
    expect(await screen.findByText("a", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/已显示 1 \/ 共 2/)).toBeTruthy();
    await act(async () => { screen.getByRole("button", { name: "加载更多" }).click(); });
    expect(await screen.findByText("b", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
    expect(seen.some((p) => p.includes("cursor=c2"))).toBe(true);
  });
});

import { classifyAuthStatus } from "../contracts/auth";
import { SESSION_CONTINUATION_EVENT, announceSessionContinuation } from "../contracts/workbench";
import { TaskUnknowns } from "../pages/ReviewDetail";
import { BrowserRouter } from "../router";

describe("F15 / F16 / T02", () => {
  it("F15 只接受 API 令牌、浏览器无登录方式：不当开放模式", () => {
    const body = { login_enabled: false, authenticated: false, api_token_required: true, browser_login_available: false };
    expect(classifyAuthStatus({ kind: "http", status: 200, body }).kind).toBe("token_required");
    expect(classifyAuthStatus({ kind: "http", status: 200, body: { login_enabled: false, authenticated: false } }).kind).toBe("open");
  });

  it("F16 任务级未知项：有 operation_id 的给出账本核对链接，没有的如实说明", () => {
    render(<BrowserRouter><TaskUnknowns ws="w" taskId="t1" sessionId="s1" record={{ unknowns: [
      { kind: "unknown_outcome", operation_id: "op-1", tool_id: "net.write" },
      { kind: "unknown_outcome", call_id: "c9" },
    ] }} /></BrowserRouter>);
    const link = screen.getByTestId("task-unknown-verify");
    expect(link.getAttribute("href")).toContain("source=ledger&id=op-1&task=t1&session=s1");
    expect(screen.getByTestId("task-unknown-unlocatable").textContent).toContain("c9");
  });

  it("T02 审批续接通过事件通知工作台", () => {
    let got: unknown = null;
    const on = (e: Event) => { got = (e as CustomEvent).detail; };
    window.addEventListener(SESSION_CONTINUATION_EVENT, on);
    announceSessionContinuation({ session_id: "s1", client_request_id: "cr" });
    window.removeEventListener(SESSION_CONTINUATION_EVENT, on);
    expect(got).toEqual({ session_id: "s1", client_request_id: "cr" });
  });
});

import { canReenable, extensionAvailability } from "../contracts/extensions";

describe("扩展被自动隔离后可重新启用", () => {
  it("quarantined：说明原因并允许重新启用", () => {
    const ext = { extension_id: "network.operations", name: "网络运维", lifecycle: { enabled: false, status: "quarantined", last_error: "boom" } };
    expect(canReenable(ext as never)).toBe(true);
    expect(extensionAvailability(ext as never).reason).toContain("自动停用");
    expect(extensionAvailability(ext as never).reason).toContain("boom");
    expect(canReenable({ extension_id: "a", name: "a", lifecycle: { enabled: true, status: "ready" } } as never)).toBe(false);
  });
});
