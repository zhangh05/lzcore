import { clearLocalAuth } from "../api/localAuth";
import { clearApiCache } from "../kit/useApi";
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * 单测禁止任何真实网络请求（P-32：旧单测会打 localhost:3000）。
 * 默认 fetch 直接抛错；需要数据的测试用 fakeBackend() 显式安装内存实现。
 */
const blockedFetch = vi.fn(async (input: RequestInfo | URL) => {
  throw new Error(`[test] 真实网络请求被禁止：${String(input)}`);
});

globalThis.fetch = blockedFetch as unknown as typeof fetch;

/** WebSocket 同样默认禁止（happy-dom 的默认 origin 是 localhost:3000）；测试用 installFakeWebSocket() 显式替换。 */
class BlockedWebSocket {
  constructor(url: string) { throw new Error(`[test] 真实 WebSocket 被禁止：${url}`); }
}
const OriginalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = BlockedWebSocket as unknown as typeof WebSocket;
void OriginalWebSocket;

/**
 * happy-dom 只实现了一部分 Web Animations：卸载时 cancel 会让 finished 以 AbortError 拒绝，
 * 变成未处理的 rejection。去掉 animate，让 motion（Arc UI 组件的动效）走 JS 动画路径；真实浏览器不受影响。
 */
for (const proto of [Element.prototype, HTMLElement.prototype] as unknown as Record<string, unknown>[]) {
  if (Object.prototype.hasOwnProperty.call(proto, "animate")) delete proto.animate;
}

afterEach(() => {
  cleanup();
  clearLocalAuth();
  clearApiCache();
  globalThis.fetch = blockedFetch as unknown as typeof fetch;
  globalThis.WebSocket = BlockedWebSocket as unknown as typeof WebSocket;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});
