import { uploadMultipart } from "./client";
import { TurnTransport } from "../realtime/turnTransport";
import { installFakeWebSocket } from "../test/fakeWebSocket";
import { describe, expect, it } from "vitest";
import { httpRequest, httpGet } from "./http";

describe("传输层", () => {
  it("代理返回空 502 → 视作后端不可达（不是服务器错误，也不是需要登录）", async () => {
    globalThis.fetch = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    expect((await httpGet("/api/auth/status")).kind).toBe("network_error");
  });
  it("带 JSON 的 500 → http 500", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false }), { status: 500 })) as unknown as typeof fetch;
    expect(await httpGet("/api/auth/status")).toEqual({ kind: "http", status: 500, body: { ok: false } });
  });
  it("拒绝非同源 / 非 /api 路径", async () => {
    await expect(httpGet("http://127.0.0.1:8011/api/auth/status")).rejects.toThrow();
    await expect(httpGet("//evil/api")).rejects.toThrow();
  });
});

describe("测试环境网络封禁", () => {
  it("未安装假后端时 fetch 直接抛错 → network_error，不会碰到任何端口", async () => {
    expect((await httpGet("/api/auth/status")).kind).toBe("network_error");
  });
});

describe("本机认证合同", () => {
  it("写请求、上传、实时消息共享内存令牌，写失败不重发且不持久化令牌", async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (path, init) => {
      requests.push({ path: String(path), init });
      if (path === "/api/local-token") return new Response(JSON.stringify({ token: "synthetic-local-token" }));
      return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
    }) as typeof fetch;
    await httpRequest("POST", "/api/sessions", {});
    await uploadMultipart("/api/workspaces/ws/artifacts/upload", {}, new File(["x"], "demo.txt"));
    expect(requests.filter((r) => r.path === "/api/local-token")).toHaveLength(1);
    expect(requests.filter((r) => r.path === "/api/sessions")).toHaveLength(1);
    for (const r of requests.slice(1)) expect(new Headers(r.init?.headers).get("X-LZCore-Local-Token")).toBe("synthetic-local-token");
    const Fake = installFakeWebSocket();
    const transport = new TurnTransport({ url: "ws://synthetic/ws/agent", readback: async () => false });
    transport.sendMessage({ workspaceId: "ws", sessionId: "s", text: "x", clientRequestId: "cr", handlers: { onToken() {}, onEvent() {}, onDone() {}, onError() {}, onTransport() {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Fake.instances[0].sent[0]).toHaveProperty("local_token", "synthetic-local-token");
    transport.close();
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("synthetic-local-token");
  });
});
