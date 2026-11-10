/** 内存假后端：只接受同源相对 /api 路径；绝对 URL（含 localhost / 8011）一律报错。 */
export type FakeReply = { status: number; body?: unknown } | "network_error";
export type FakeHandler = (method: string, path: string, body: unknown) => FakeReply | undefined;

export function fakeBackend(handler: FakeHandler) {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("/")) throw new Error(`[test] 非相对路径被拒绝：${url}`);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const reply = handler(method, url, body);
    if (reply === "network_error") throw new TypeError("Failed to fetch");
    if (!reply) return new Response(JSON.stringify({ ok: false, error: "not_in_fake" }), { status: 501 });
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return { calls };
}
