import { fakeBackend, type FakeHandler, type FakeReply } from "./fakeBackend";

export interface FixtureOptions {
  login?: "disabled" | "required" | "sso";
  authStatus?: "ok" | "error" | "network";
  extensions?: "mixed" | "none" | "error" | "network_ready";
  role?: string;
  inbox?: "data" | "empty";
}

const workspaces = [
  { workspace_id: "ws-demo-1", name: "演示工作区 A" },
  { workspace_id: "ws-demo-2", name: "演示工作区 B" },
];

const extensions = [
  { extension_id: "demo.notes", name: "演示笔记", frontend_routes: [{ path: "/extensions/demo.notes/board", label: "笔记看板", order: 10 }], lifecycle: { enabled: true, status: "ready" } },
  { extension_id: "network.operations", name: "网络扩展", frontend_routes: [{ path: "/extensions/network.operations/manage", label: "网络 Skill 管理", icon: "probe", order: 30 }, { path: "/extensions/network.operations/skills", label: "网络 Skill", icon: "spark", order: 31 }], lifecycle: { enabled: true, status: "failed", last_error: "依赖未就绪（合成）" } },
];

/** 与 mock/mock_server.py 同形的内存后端，供组件测试使用（不发真实请求）。 */
export function installFixture(opts: FixtureOptions = {}, extra?: FakeHandler) {
  const shell = shellHandler(opts);
  return fakeBackend((m, p, b) => extra?.(m, p, b) ?? shell(m, p, b));
}

export function shellHandler(opts: FixtureOptions = {}): FakeHandler {
  const login = opts.login ?? "disabled";
  let signedIn = false;
  return (method, path, body): FakeReply | undefined => {
    const url = new URL(path, "http://fixture.local");
    const p = url.pathname;
    const ws = url.searchParams.get("workspace_id") ?? p.split("/")[3];
    const empty = opts.inbox === "empty" || ws === "ws-demo-2";
    if (p === "/api/local-token") return { status: 404, body: { error: "local_token_unused" } };
    if (p === "/api/auth/status") {
      if (opts.authStatus === "network") return "network_error";
      if (opts.authStatus === "error") return { status: 500, body: { ok: false } };
      const enabled = login !== "disabled";
      const role = opts.role ?? (signedIn ? "admin" : "");
      return { status: 200, body: { ok: true, login_enabled: enabled, authenticated: signedIn, username: signedIn ? "demo" : "", role, platform_admin: role === "admin", oidc_enabled: login === "sso", auth_type: signedIn ? "session" : "none" } };
    }
    if (p === "/api/auth/login" && method === "POST") {
      const b = body as { username: string; password: string };
      if (b.username === "server-error") return { status: 500, body: { ok: false } };
      if (b.username === "demo" && b.password === "demo-pass") { signedIn = true; return { status: 200, body: { ok: true } }; }
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
    if (p === "/api/workspaces") return { status: 200, body: { workspaces } };
    if (p === "/api/extensions") {
      if (opts.extensions === "error") return { status: 500, body: { ok: false } };
      const list = opts.extensions === "none" ? [] : opts.extensions === "network_ready"
        ? extensions.map((e) => e.extension_id === "network.operations" ? { ...e, lifecycle: { enabled: true, status: "ready", last_error: "" } } : e)
        : extensions;
      return { status: 200, body: { ok: true, extensions: list } };
    }
    if (p.endsWith("/review-items")) return { status: 200, body: { ok: true, items: empty ? [] : [
      { item_id: "r1", artifact_id: "a1", title: "报告结论需人工确认", status: "pending" },
      { item_id: "r2", artifact_id: "a2", title: "导出字段缺失", status: "pending", severity: "error" },
    ] } };
    if (p === "/api/admin/operation-ledger") return { status: 200, body: { ok: true, operations: empty ? [] : [
      { operation_id: "op1", status: "unknown", canonical_tool: "workspace.file.write" },
      { operation_id: "op2", status: "indeterminate", canonical_tool: "external.http.post" },
      { operation_id: "op3", status: "succeeded" },
    ] } };
    if (p === "/api/runtime/tasks") return { status: 200, body: { ok: true, tasks: empty ? [] : [
      { task_id: "t-unknown", session_id: "s-unknown", user_goal: "整理周报", status: "failed" },
      { task_id: "t-done", session_id: "s-done", status: "succeeded" },
    ] } };
    if (p === "/api/sessions" && method === "GET") return { status: 200, body: { ok: true, sessions: empty ? [] : [
      { session_id: "s-unknown", title: "整理周报" }, { session_id: "s-done", title: "已核对" },
    ] } };
    if (p === "/api/runtime/sessions/s-unknown/task-state") return { status: 200, body: { ok: true, task_state: { task: { task_id: "t-unknown", objective: "整理周报", status: "partial", unknowns: [{ kind: "unknown_outcome" }] } } } };
    if (p === "/api/runtime/sessions/s-done/task-state") return { status: 200, body: { ok: true, task_state: { task: { task_id: "t-done", status: "succeeded", unknowns: [] } } } };
    if (p === "/api/auth/logout") { signedIn = false; return { status: 200, body: { ok: true } }; }
    return undefined;
  };
}
