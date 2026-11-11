import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import { invalidateApi, SLOW_AFTER_MS, useApi } from "./useApi";

afterEach(() => { vi.useRealTimers(); });

describe("useApi 读取层", () => {
  it("同 key 并发挂载只发一个请求，并共享结果", async () => {
    let calls = 0;
    fakeBackend((_m, path) => { if (path.startsWith("/api/x")) { calls += 1; return { status: 200, body: { n: calls } }; } return undefined; });
    const a = renderHook(() => useApi<{ n: number }>("/api/x", { workspace_id: "w" }));
    const b = renderHook(() => useApi<{ n: number }>("/api/x", { workspace_id: "w" }));
    await waitFor(() => expect(a.result.current[0].state).toBe("ok"));
    await waitFor(() => expect(b.result.current[0].state).toBe("ok"));
    expect(calls).toBe(1);
  });

  it("等待超过阈值标记 slow，但不放弃请求", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = vi.fn(async () => { await gate; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof fetch;
    const { result } = renderHook(() => useApi("/api/slow"));
    expect(result.current[0]).toEqual({ state: "loading" });
    await act(async () => { vi.advanceTimersByTime(SLOW_AFTER_MS + 10); });
    expect(result.current[0]).toEqual({ state: "loading", slow: true });
    release();
    await waitFor(() => expect(result.current[0].state).toBe("ok"));
  });

  it("重新读取失败时保留上次数据并标出 refreshError，而不是清空成错误", async () => {
    let fail = false;
    fakeBackend((_m, path) => (path.startsWith("/api/y") ? (fail ? { status: 500, body: { error: "boom" } } : { status: 200, body: { v: 1 } }) : undefined));
    const { result } = renderHook(() => useApi<{ v: number }>("/api/y"));
    await waitFor(() => expect(result.current[0].state).toBe("ok"));
    fail = true;
    act(() => result.current[1]());
    await waitFor(() => {
      const v = result.current[0];
      expect(v.state === "ok" && v.refreshError).toBeTruthy();
    });
    const v = result.current[0];
    expect(v.state === "ok" && v.data).toEqual({ v: 1 });
  });

  it("invalidateApi 按路径前缀让已挂载读取立即重读", async () => {
    let n = 0;
    fakeBackend((_m, path) => (path.startsWith("/api/sessions") ? { status: 200, body: { n: ++n } } : undefined));
    const { result } = renderHook(() => useApi<{ n: number }>("/api/sessions", { workspace_id: "w" }));
    await waitFor(() => expect(result.current[0].state === "ok" && result.current[0].data.n).toBe(1));
    act(() => invalidateApi("/api/sessions"));
    await waitFor(() => expect(result.current[0].state === "ok" && result.current[0].data.n).toBe(2));
  });
});
