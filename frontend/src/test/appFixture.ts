import type { FakeHandler, FakeReply } from "./fakeBackend";
import { installFixture, type FixtureOptions } from "./backendFixture";

/** 组件测试用的阶段 2–6 内存后端（与 mock/mock_phase2.py 同形的合成数据子集）。 */
export interface AppFixtureOptions extends FixtureOptions {
  conflict?: "none" | "annotations" | "topology" | "approval" | "approval_network" | "memory";
  jobs?: "data" | "mapping1";
}

export interface Logged { method: string; path: string; body: unknown }

const md = (o: Record<string, unknown>) => ({ client_request_id: "", tool_calls: [], stage_outputs: [{ stage: "plan", title: "规划", status: "done", summary: "合成" }], ...o });

export function appHandler(opts: AppFixtureOptions, log: Logged[]): FakeHandler {
  const sessions = [
    { session_id: "s-unknown", title: "整理周报", status: "active", created_at: new Date().toISOString(), metadata: {} },
    { session_id: "s-mapping2", title: "映射二", status: "active", created_at: new Date().toISOString(), metadata: {} },
    { session_id: "s-partial", title: "部分达成", status: "active", created_at: new Date().toISOString(), metadata: {} },
    { session_id: "s-reconciled", title: "已核对", status: "active", created_at: new Date().toISOString(), metadata: {} },
    { session_id: "s-drawing", title: "绑定图纸", status: "active", created_at: new Date().toISOString(), metadata: { topology_id: "t1", workbench_selection: { extension_id: "network.operations", skill_id: "drawing:t1", skill_name: "绑定图纸", resource_ids: ["t1"], allow_edit: false } } },
    { session_id: "s-real42", title: "回复 42", status: "active", created_at: new Date().toISOString(), metadata: {} },
    { session_id: "s-archived", title: "旧会话", status: "archived", created_at: "2026-10-01T00:00:00Z", metadata: {} },
  ];
  const messages: Record<string, unknown[]> = {
    "s-unknown": [{ role: "user", content: "写入共享目录" }, { message_id: "a1", role: "assistant", content: "回执丢失", ok: false, errors: ["receipt_lost"],
      metadata: md({ execution_outcome: "unknown", unknown_outcome: { tool_id: "workspace.file.write", call_id: "c1", execution_may_continue: true }, task_id: "t-unknown",
        tool_calls: [{ call_id: "c1", tool_id: "workspace.file.write", status: "unknown" }] }) }],
    "s-mapping2": [{ role: "user", content: "更新配置" }, { message_id: "a2", role: "assistant", content: "已提交", ok: true, errors: [],
      metadata: md({ execution_outcome: "unknown", unknown_outcome: { tool_id: "workspace.file.write", call_id: "c3", execution_may_continue: true }, task_id: "t-mapping2",
        tool_calls: [{ call_id: "c3", tool_id: "workspace.file.write", status: "unknown", result: { ok: true } }] }) }],
    "s-partial": [{ role: "user", content: "汇总三份" }, { message_id: "a3", role: "assistant", content: "已汇总两份；第三份无法读取。", ok: true, errors: [],
      metadata: md({ execution_outcome: "partial", tool_calls: [{ call_id: "r1", tool_id: "workspace.file.read", status: "ok" }, { call_id: "r2", tool_id: "workspace.file.read", status: "error" }] }) }],
    "s-reconciled": [{ role: "user", content: "写一条" }, { message_id: "a4", role: "assistant", content: "已回读确认", ok: true, errors: [],
      metadata: md({ execution_outcome: "complete", unknown_outcome: { tool_id: "workspace.file.write", call_id: "c2", status: "reconciled" } }) }],
    "s-drawing": [],
    // 真实后端历史消息形状：无 execution_outcome；stage_outputs 为 {id,label,text}（含一条空阶段，不应渲染）。
    "s-real42": [{ role: "user", content: "6×7？", run_id: "run-42" }, { message_id: "a42", role: "assistant", content: "42", run_id: "run-42", created_at: "2026-11-09T10:00:00Z",
      metadata: { client_request_id: "cr42", stage_outputs: [{ id: "model-1", label: "模型输出 1", text: "42" }, { id: "", label: "", text: "" }] } }],
  };
  const taskState: Record<string, unknown> = {
    "s-unknown": { task_id: "t-unknown", objective: "整理周报", status: "partial", unknowns: [{ kind: "unknown_outcome" }] },
    "s-mapping2": { task_id: "t-mapping2", status: "partial", unknowns: [{ kind: "unknown_outcome" }] },
    "s-partial": { task_id: "t-partial", status: "partial", unknowns: [] },
    "s-reconciled": { task_id: "t-done", status: "succeeded", unknowns: [] },
    "s-real42": { task_id: "t-42", last_run_id: "run-42", status: "completed", unknowns: [] },
  };
  const runtimeTasks = [
    { task_id: "t-unknown", session_id: "s-unknown", user_goal: "整理周报", status: "failed", steps: [{ step_id: "st1", status: "succeeded" }, { step_id: "st2", status: "failed" }] },
    { task_id: "t-partial", session_id: "s-partial", user_goal: "汇总三份", status: "failed", steps: [{ step_id: "st3", status: "failed" }] },
  ];
  let jobs = [
    { job_id: "job-lease", job_type: "agent_turn", status: "failed", error: "lease", payload: { user_input: "x" }, metadata: { active_turn: { unknown_outcome: { tool_id: "jobs.worker", error_code: "WORKER_LEASE_EXPIRED", execution_may_continue: true } } } },
    { job_id: "job-plain", job_type: "report", status: "failed", payload: { report: "weekly" }, result_summary: { ok: false, execution_outcome: "failed" }, metadata: {} },
    { job_id: "job-queued", job_type: "agent_turn", status: "queued", metadata: {} },
    { job_id: "job-cancel", job_type: "agent_turn", status: "cancel_requested", metadata: {} },
    { job_id: "job-ok", job_type: "agent_turn", status: "succeeded", result_summary: { ok: true, execution_outcome: "partial" }, metadata: {} },
  ];
  if (opts.jobs === "mapping1") jobs = jobs.slice(0, 1);
  const ledger = [{ operation_id: "op1", status: "unknown", canonical_tool: "workspace.file.write" }, { operation_id: "op2", status: "indeterminate" }, { operation_id: "op3", status: "succeeded" }];
  // 拓扑：与旧画布读写同形（nodes / links / groups / canvas_items / version）
  const topology = { topology_id: "topo1", name: "演示拓扑", description: "", version: 3, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
    nodes: [{ node_id: "n1", display_name: "核心-1", device_type: "switch", x: 100, y: 100 }, { node_id: "n2", display_name: "汇聚-1", device_type: "switch", x: 300, y: 100 }],
    links: [] as unknown[], groups: [] as unknown[], canvas_items: [] as unknown[] };
  const reports: { artifact_id: string; title: string; run_id: string | null; sensitivity: string; created_at: string; content: string }[] = [
    { artifact_id: "rep-1", title: "周报运行报告", run_id: "run-a", sensitivity: "internal", created_at: "2026-11-08T00:00:00Z", content: "# 周报\n- 已汇总两份" },
    { artifact_id: "rep-s", title: "敏感报告", run_id: "run-a", sensitivity: "sensitive", created_at: "2026-11-08T00:00:00Z", content: "敏感正文" },
    { artifact_id: "rep-t", title: "只有标题的报告", run_id: null, sensitivity: "internal", created_at: "2026-11-08T00:00:00Z", content: "# 运行报告" },
    { artifact_id: "rep-x", title: "机密报告", run_id: null, sensitivity: "secret", created_at: "2026-11-08T00:00:00Z", content: "不可读" },
  ];
  const orgs: { organization_id: string; name: string; workspace_ids: string[] }[] = [{ organization_id: "org-x", name: "组织 X", workspace_ids: ["ws-demo-2", "ws-legacy"] }];
  let memberships: { username: string; organization_id: string; role: string; workspace_ids: string[] }[] = [{ username: "alice", organization_id: "org-x", role: "operator", workspace_ids: ["ws-demo-2", "ws-legacy"] }];
  const knowledge: { source_id: string; name: string; status: string } = { source_id: "ks1", name: "手册.pdf", status: "indexed" };
  const inspections: Record<string, { task_id: string; status: string; devices: { connection_id: string; name: string; status: string; retryable?: boolean }[] }> = {
    "insp-partial": { task_id: "insp-partial", status: "partial", devices: [{ connection_id: "c-ok", name: "sw-ok", status: "succeeded" }, { connection_id: "c-bad", name: "sw-bad", status: "failed" }] },
    "insp-unknown": { task_id: "insp-unknown", status: "unknown", devices: [{ connection_id: "c-x", name: "sw-x", status: "unknown" }] },
  };
  // 记忆：与 storage/memory_governance 同形（summary = 标题，content = 全文）；memory_id 合同 ^mem-[a-f0-9]{12}$。
  const memory: Record<string, unknown>[] = [
    { memory_id: "mem-a", summary: "周五提交", content: "周报每周五 18:00 前提交到共享目录。", status: "active", memory_type: "knowledge_note", scope: "workspace", source: "user", metadata: {} },
    { memory_id: "mem-b", summary: "周四提交", content: "周报改为每周四提交。", status: "conflict", memory_type: "knowledge_note", scope: "workspace", source: "agent_suggestion", metadata: { conflict_memory_ids: ["mem-a"] } },
  ];
  // 托管文件：PATCH 把文件夹写进 metadata.folder，名称写进 original_name（storage/managed_files）。
  const files: { file_id: string; original_name: string; metadata: { folder?: string }; size_bytes: number; mime_type: string; lifecycle: string; created_at: string; updated_at: string }[] = [
    { file_id: "file-1", original_name: "巡检记录.txt", metadata: { folder: "巡检" }, size_bytes: 2048, mime_type: "text/plain", lifecycle: "active", created_at: "2026-11-08T00:00:00Z", updated_at: "2026-11-08T00:00:00Z" },
  ];
  // 运行审计 / trace：与 /api/workspaces/<ws>/runs/<id>(/trace) 真实返回同形（审计是平铺对象，不包 run）。
  const runAudits: Record<string, Record<string, unknown>> = {
    "run-42": { run_id: "run-42", execution_outcome: "complete", final_response_summary: "Task completed.", created_at: "2026-11-09T10:00:00Z", finished_at: "2026-11-09T10:00:01Z", intent: "assistant_chat",
      llm_metadata: { provider: "offline_mock", model: "mock-safe", used: true }, metadata: { cognitive_events: [{ created_at: "2026-11-09T10:00:00Z", type: "cognitive_initialized", payload: { visible_summary: "已建立任务目标和完成标准" } }] } },
  };
  const runTraces: Record<string, { name: string; type: string; timestamp: number; duration_ms: number }[]> = {
    "run-42": [{ name: "轮次开始", type: "turn_start", timestamp: 1794218400, duration_ms: 10 }, { name: "model", type: "model", timestamp: 1794218400.1, duration_ms: 10 }, { name: "final", type: "final", timestamp: 1794218400.2, duration_ms: 110 }],
  };
  const approval = { operation_id: "appr1", status: "pending", title: "下发配置", target: { device: { name: "core-sw-01", device_id: "dev-1" }, connection: { connection_id: "conn-1", name: "conn-1" } }, commands: ["interface Gi0/1", "description uplink"] };
  const annotations = { version: 1, items: [{ node_id: "n1", text: "核心" }] };
  const sessionsCreated: string[] = [];
  const netDevices: { device_id: string; name: string; host: string; vendor: string; device_type: string; region_id: string }[] = [{ device_id: "device_1", name: "核心-1", host: "10.9.0.1", vendor: "h3c", device_type: "switch_core", region_id: "rg1" }];
  const netConnections: { connection_id: string; device_id: string; protocol: string; port: number; username: string; auth_method: string; status: string; last_error: string }[] = [];
  const netScripts: { script_id: string; name: string; vendors: string[]; commands: string[]; checks: unknown[]; version: number; source: string }[] = [
    { script_id: "starter_health", name: "基础健康巡检", vendors: ["h3c"], commands: ["display version"], checks: [], version: 1, source: "starter" },
  ];
  const workflows: { workflow_id: string; name: string; version?: number; status?: string; nodes?: unknown[]; execution_layers?: string[][]; updated_at?: string }[] = [
    { workflow_id: "wf1", name: "周报", version: 1, status: "active", nodes: [{ node_id: "read", tool_id: "workspace.file.write", depends_on: [] }], execution_layers: [["read"]] },
  ];

  return (method, rawPath, body): FakeReply | undefined => {
    const url = new URL(rawPath, "http://fixture.local");
    const p = url.pathname;
    const q = url.searchParams;
    if (method !== "GET") log.push({ method, path: rawPath, body });
    const seg = p.split("/");
    if (p === "/api/agent/status") return { status: 200, body: { ok: true, status: "ready" } };
    if (p === "/api/agent/llm/status") return { status: 200, body: { enabled: true, connected: true, key_configured: true } };
    if (p === "/api/workbench/skills") return { status: 200, body: { skills: [{ extension_id: "demo.notes", skill_id: "sk1", name: "汇总", resources: [{ resource_id: "board-1", name: "演示看板" }], selection_mode: "single" }] } };
    if (p === "/api/tools/catalog") {
      const tools = [
        { tool_id: "workspace.file.write", display_name: "写入", category: "workspace", group: "file", risk_level: "medium", permission_action: "write", enabled: true, description: "Write a managed workspace file.", callable_by_llm: true },
        { tool_id: "knowledge.search", display_name: "知识检索", category: "knowledge", group: "kb", risk_level: "low", permission_action: "read", enabled: true, description: "Search indexed knowledge chunks.", callable_by_llm: true },
      ];
      return { status: 200, body: { tools, categories: [
        { id: "workspace", name: "Workspace 工作区", count: 1, description: "工作区文件。", groups: [{ id: "file", tools: [tools[0]] }] },
        { id: "knowledge", name: "Knowledge 知识库", count: 1, description: "知识检索。", groups: [{ id: "kb", tools: [tools[1]] }] },
      ] } };
    }
    if (p === "/api/tools/dry-run") return { status: 200, body: { ok: true, dry_run: true, executed: false } };
    if (p === "/api/sessions" && method === "GET") {
      if (q.get("workspace_id") === "ws-demo-2") return { status: 200, body: { sessions: [] } };
      return { status: 200, body: { sessions: sessions.filter((s) => s.status === (q.get("status") ?? "active")) } };
    }
    if (p === "/api/sessions" && method === "POST") {
      const s = { session_id: `s-new-${sessionsCreated.length + 1}`, title: "", status: "active", created_at: new Date().toISOString(), metadata: {} };
      sessionsCreated.push(s.session_id); sessions.unshift(s); messages[s.session_id] = [];
      return { status: 201, body: { ok: true, session: s } };
    }
    if (seg[2] === "sessions" && seg[3]) {
      if ((method === "PUT" || (method === "POST" && ["archive", "restore"].includes(seg[4]))) && !q.get("workspace_id")) return { status: 400, body: { error: "invalid_workspace_id" } };
      const s = sessions.find((x) => x.session_id === seg[3]);
      if (!s) return { status: 404, body: { ok: false } };
      if (seg.length === 4 && method === "GET") return { status: 200, body: { session: s } };
      if (seg.length === 4 && method === "DELETE") { sessions.splice(sessions.indexOf(s), 1); return { status: 200, body: { ok: true } }; }
      if (seg.length === 4 && method === "PUT") { s.title = (body as { title: string }).title; return { status: 200, body: { session: s } }; }
      if (seg[4] === "archive") { s.status = "archived"; return { status: 200, body: { session: s } }; }
      if (seg[4] === "restore") { s.status = "active"; return { status: 200, body: { session: s } }; }
      if (seg[4] === "messages") return { status: 200, body: { messages: messages[s.session_id] ?? [] } };
    }
    if (p === "/api/runtime/session-tasks" && method === "GET") {
      const active = q.get("workspace_id") === "ws-demo-2" ? [] : sessions.filter((s) => s.status === "active");
      const items = active.filter((s) => taskState[s.session_id]).map((s) => ({ session_id: s.session_id, title: s.title, task: taskState[s.session_id] }));
      return { status: 200, body: { ok: true, workspace_id: q.get("workspace_id"), items, sessions_scanned: active.length, truncated: false, errors: [] } };
    }
    if (seg[2] === "runtime" && seg[3] === "sessions" && seg[5] === "task-state") {
      const t = taskState[seg[4]];
      return { status: 200, body: { ok: true, task_state: t ? { task: t } : null } };
    }
    // 与真实后端一致：健康 / 自检 / 用量缺 workspace_id 时 400。
    if ((p === "/api/runtime/health" || p === "/api/runtime/selfcheck" || p === "/api/agent/usage") && !q.get("workspace_id")) return { status: 400, body: { ok: false, error: "invalid_workspace_id" } };
    if (p === "/api/runtime/health") return { status: 200, body: { components: [{ name: "workspace", status: "ok", message: "exists", details: {} }, { name: "llm", status: "warning", message: "probe timeout", details: { provider: "mock" } }], summary: { total: 2, ok: 1, warning: 1, error: 0 } } };
    if (p === "/api/runtime/summary") return { status: 200, body: { capabilities: { total: 8, enabled: 8 }, tools: { registered: 25, model_visible: 24, hidden_or_non_llm: ["x.internal"] } } };
    if (p === "/api/agent/usage") return { status: 200, body: { ok: true, workspace_id: q.get("workspace_id"), call_count: 3, total_tokens: 1200, input_tokens: 1000, output_tokens: 200, cache_hit_ratio: 0.25, estimated_cost: 0, last_updated: "" } };
    if (p === "/api/runtime/tasks") return { status: 200, body: { ok: true, tasks: q.get("workspace_id") === "ws-demo-2" ? [] : runtimeTasks } };
    if (seg[2] === "runtime" && seg[3] === "tasks" && seg[4]) {
      const t = runtimeTasks.find((x) => x.task_id === seg[4]);
      if (!t) return { status: 404, body: {} };
      if (seg.length === 5) return { status: 200, body: { task: t } };
      if (seg[5] === "events") return { status: 200, body: { events: [] } };
      if (seg[5] === "checkpoints") return { status: 200, body: { checkpoints: [] } };
      if (seg[5] === "audit-report") return { status: 200, body: { report: {} } };
      return { status: 200, body: { ok: true } };
    }
    if (p === "/api/jobs" && method === "GET") return { status: 200, body: { jobs } };
    if (p === "/api/jobs/batch-delete") return { status: 200, body: { ok: true } };
    if (seg[2] === "jobs" && seg[3]) return { status: 200, body: { ok: true } };
    if (p === "/api/admin/operation-ledger" && method === "GET") return { status: 200, body: { operations: ledger } };
    if (seg[3] === "operation-ledger" && seg[5] === "resolve") {
      const b = body as { status: string; confirmation: string };
      const op = ledger.find((o) => o.operation_id === seg[4]);
      if (op && b.confirmation === `RESOLVE ${seg[4]}`) op.status = b.status;
      return { status: 200, body: { ok: true } };
    }
    if (p === "/api/memory/list") return { status: 200, body: { records: memory } };
    if (p === "/api/memory/write") {
      const b = body as { memory_id: string; title: string; content?: string; user_confirmed?: boolean };
      if (!/^mem-[a-f0-9]{12}$/.test(b.memory_id ?? "")) return { status: 400, body: { ok: false, error: "invalid_memory_id" } };
      if (opts.conflict === "memory") return { status: 409, body: { ok: false, status: "execution_unknown", memory_id: b.memory_id } };
      const status = b.user_confirmed ? "active" : "pending";
      memory.push({ memory_id: b.memory_id, summary: b.title, content: b.content ?? "", status, metadata: {} });
      return { status: 200, body: { ok: true, memory_id: b.memory_id, status } };
    }
    if (p === "/api/memory/confirm" || p === "/api/memory/reject") {
      const m = memory.find((x) => x.memory_id === (body as { memory_id: string }).memory_id);
      if (!m) return { status: 200, body: { ok: false, error: "not found" } };
      if (p.endsWith("confirm")) {
        if (m.status !== "pending" && m.status !== "conflict") return { status: 200, body: { ok: false, error: `cannot confirm status ${String(m.status)}` } };
        m.status = "active";
      } else m.status = "rejected";
      return { status: 200, body: { ok: true, status: m.status, memory_id: m.memory_id } };
    }
    if (p === "/api/memory/batch-delete") return { status: 200, body: { ok: true, deleted_count: ((body as { memory_ids: string[] }).memory_ids ?? []).length } };
    if (seg[2] === "memory" && seg[3]) {
      const m = memory.find((x) => x.memory_id === seg[3]);
      return m ? { status: 200, body: { record: m } } : { status: 404, body: { ok: false } };
    }
    if (p.startsWith("/api/extensions/approval/operations/appr1")) {
      if (p.endsWith("/decision")) {
        if (opts.conflict === "approval_network") return "network_error";
        if (opts.conflict === "approval") { approval.status = "invalidated"; return { status: 409, body: { ok: false, error: "operation_invalidated", operation: { ...approval, invalidated_reason: "设备配置已被修改" } } }; }
        approval.status = "approved"; return { status: 200, body: { ok: true, operation: approval } };
      }
      return { status: 200, body: { ok: true, operation: approval } };
    }
    if (p === "/api/admin/backups" && method === "GET") return { status: 200, body: { backups: [{ backup_id: "bk1" }] } };
    if (p.startsWith("/api/admin/backups/")) return { status: 200, body: { ok: true } };
    if (p === "/api/admin/production") return { status: 200, body: { ok: true } };
    if (p === "/api/identity/users" && method === "GET") return { status: 200, body: { users: [{ username: "alice", role: "operator", organization_id: "org-x", workspace_ids: ["ws-demo-2", "ws-legacy"], enabled: true }, { username: "bob", role: "viewer", organization_id: "org-y", workspace_ids: ["ws-demo-1"], enabled: true }] } };
    if (p.startsWith("/api/identity/users/")) return { status: 200, body: { ok: true } };
    if (p === "/api/identity/organizations") {
      if (method === "POST") {
        const b = body as { organization_id?: string; name?: string };
        if (!b.organization_id || !b.name) return { status: 400, body: { ok: false, error: "organization name is required" } };
        if (orgs.some((o) => o.organization_id === b.organization_id)) return { status: 400, body: { ok: false, error: "organization already exists" } };
        const rec = { organization_id: b.organization_id, name: b.name, workspace_ids: [] as string[] };
        orgs.push(rec); return { status: 201, body: { ok: true, organization: rec } };
      }
      return { status: 200, body: { ok: true, organizations: orgs } };
    }
    const mem = /^\/api\/identity\/organizations\/([^/]+)\/memberships$/.exec(p);
    if (mem) {
      const org = orgs.find((o) => o.organization_id === decodeURIComponent(mem[1]));
      if (!org) return { status: 400, body: { ok: false, error: "organization not found" } };
      if (method === "GET") return { status: 200, body: { ok: true, memberships: memberships.filter((m) => m.organization_id === org.organization_id) } };
      const b = body as { username?: string; role?: string; workspace_ids?: string[] };
      if (!["viewer", "operator", "developer"].includes(b.role ?? "viewer")) return { status: 400, body: { ok: false, error: "ordinary_user_role_required" } };
      const ws = [...new Set(b.workspace_ids ?? [])].sort();
      if (!ws.every((w) => org.workspace_ids.includes(w))) return { status: 400, body: { ok: false, error: "workspace is not assigned to the organization" } };
      const rec = { username: b.username ?? "", organization_id: org.organization_id, role: b.role ?? "viewer", workspace_ids: ws };
      memberships = memberships.filter((m) => !(m.username === rec.username && m.organization_id === rec.organization_id)).concat(rec);
      return { status: 201, body: { ok: true, membership: rec } };
    }
    if (/^\/api\/workspaces\/[^/]+\/(retention|archive)\/(preview|apply|items|audits)$/.test(p)) return { status: 200, body: { ok: true, items: [], audits: [], candidates: [{ path: "x" }] } };
    if (p === "/api/extensions/network.operations/topologies") return { status: 200, body: { topologies: [topology] } };
    if (p === "/api/extensions/network.operations/topologies/topo1") {
      if (method === "PUT") {
        const b = body as { version?: number };
        if (opts.conflict === "topology" || b.version !== topology.version) return { status: 409, body: { ok: false, error: "topology_version_conflict", topology } };
        Object.assign(topology, b, { version: topology.version + 1 });
        return { status: 200, body: { ok: true, topology } };
      }
      return { status: 200, body: { topology } };
    }
    if (p === "/api/extensions/network.operations/topologies/topo1/revisions") return { status: 200, body: { revisions: [{ revision_id: "rev1", version: 2 }] } };
    if (p === "/api/extensions/network.operations/topologies/topo1/annotations") {
      if (method === "GET") return { status: 200, body: { annotations } };
      if (opts.conflict === "annotations") return { status: 409, body: { ok: false, error: "annotations_version_conflict" } };
      annotations.version += 1; annotations.items = (body as { items: { node_id: string; text: string }[] }).items;
      return { status: 200, body: { annotations } };
    }
    if (p === "/api/knowledge/sources") return { status: 200, body: { sources: [knowledge] } };
    if (p === "/api/knowledge/sources/ks1/reindex") { knowledge.status = "indexing"; return { status: 202, body: { ok: true, accepted: true } }; }
    if (p === "/api/knowledge/sources/ks1") return { status: 200, body: { source: { ...knowledge, chunk_count: 2, chunks: [
      { chunk_id: "ck1", source_id: "ks1", content: "第一章：设备上架前先登记管理地址。" }, { chunk_id: "ck2", source_id: "ks1", content: "第二章：巡检周期为每周一，输出巡检报告。" }] } } };
    // 检索：真实字段是 title / artifact_name / summary / safe_excerpt / content，没有 text。
    if (p === "/api/knowledge/search") {
      const qq = q.get("q") ?? "";
      const hits = qq.includes("巡检") ? [{ chunk_id: "ck2", source_id: "ks1", title: "手册.pdf", artifact_name: "手册.pdf", summary: "", safe_excerpt: "第二章：巡检周期为每周一，输出巡检报告。", content: "第二章：巡检周期为每周一，输出巡检报告。", score: 0.82 }] : [];
      return { status: 200, body: { ok: true, results: hits, count: hits.length } };
    }
    if (p === "/api/storage/files" && method === "GET") return { status: 200, body: { ok: true, files: files.filter((f) => f.lifecycle === (q.get("lifecycle") ?? "active")), folders: [] } };
    const fileM = /^\/api\/storage\/files\/([^/]+)$/.exec(p);
    if (fileM) {
      const f = files.find((x) => x.file_id === fileM[1]);
      if (!f) return { status: 404, body: { ok: false } };
      if (method === "PATCH") {
        const b = body as { name?: string; folder?: string };
        if (b.name) f.original_name = b.name;
        if (b.folder !== undefined) f.metadata = { ...f.metadata, folder: b.folder };
        f.updated_at = "2026-11-10T00:00:00Z";
      }
      return { status: 200, body: { ok: true, file: f } };
    }
    // 设备 / 连接 / 脚本：校验与 extensions/network_operations/network_inventory、network_scripts 同口径（错误串一致）。
    const NB = "/api/extensions/network.operations";
    if (p === `${NB}/regions`) return { status: 200, body: { ok: true, regions: [{ region_id: "rg1", name: "一号楼" }] } };
    if (p === `${NB}/devices` && method === "GET") return { status: 200, body: { ok: true, devices: netDevices } };
    if (p === `${NB}/devices` && method === "POST") {
      const b = body as { name?: string; host?: string; vendor?: string; device_type?: string; region_id?: string };
      if (!b.name?.trim() || !b.host?.trim()) return { status: 400, body: { ok: false, error: "valid device name and host are required" } };
      if (netDevices.some((d) => d.name === b.name && d.host === b.host)) return { status: 400, body: { ok: false, error: "device name and host already exist" } };
      const d = { device_id: `device_${netDevices.length + 1}`, name: b.name, host: b.host, vendor: b.vendor ?? "generic", device_type: b.device_type ?? "switch", region_id: b.region_id ?? "" };
      netDevices.push(d); return { status: 201, body: { ok: true, device: d } };
    }
    const devM = new RegExp(`^${NB.replace(/\./g, "\\.")}/devices/([^/]+)$`).exec(p);
    if (devM && method === "GET") { const d = netDevices.find((x) => x.device_id === devM[1]); return d ? { status: 200, body: { ok: true, device: d } } : { status: 404, body: { ok: false } }; }
    if (p === `${NB}/connections` && method === "GET") return { status: 200, body: { ok: true, connections: netConnections } };
    if (p === `${NB}/connections` && method === "POST") {
      const b = body as { device_id?: string; protocol?: string; port?: number; username?: string; auth_method?: string; password?: string };
      if (!netDevices.some((d) => d.device_id === b.device_id)) return { status: 400, body: { ok: false, error: "device_not_found" } };
      if ((b.protocol ?? "ssh") === "ssh" && !b.username) return { status: 400, body: { ok: false, error: "username is required for ssh" } };
      if (netConnections.some((c) => c.device_id === b.device_id && c.protocol === (b.protocol ?? "ssh") && c.port === b.port)) return { status: 400, body: { ok: false, error: "connection_endpoint_already_exists" } };
      if (b.auth_method === "password" && !b.password) return { status: 400, body: { ok: false, error: "password is required for password authentication" } };
      const c = { connection_id: `connection_${netConnections.length + 1}`, device_id: b.device_id!, protocol: b.protocol ?? "ssh", port: b.port ?? 22, username: b.username ?? "", auth_method: b.auth_method ?? "password", status: "failed", last_error: "connection refused" };
      netConnections.push(c); return { status: 201, body: { ok: true, connection: c } };
    }
    const connM = new RegExp(`^${NB.replace(/\./g, "\\.")}/connections/([^/]+)$`).exec(p);
    if (connM && method === "GET") { const c = netConnections.find((x) => x.connection_id === connM[1]); return c ? { status: 200, body: { ok: true, connection: c } } : { status: 404, body: { ok: false } }; }
    if (p === `${NB}/scripts` && method === "GET") return { status: 200, body: { ok: true, scripts: netScripts } };
    const scrM = new RegExp(`^${NB.replace(/\./g, "\\.")}/scripts/([^/]+)$`).exec(p);
    if ((p === `${NB}/scripts` && method === "POST") || (scrM && method === "PUT")) {
      const b = body as { name?: string; vendors?: string[]; commands?: string[]; checks?: unknown[] };
      if (!b.name) return { status: 400, body: { ok: false, error: "script name is required and must be at most 80 characters" } };
      if (!b.vendors?.length) return { status: 400, body: { ok: false, error: "invalid script vendors" } };
      if (!b.commands?.length) return { status: 400, body: { ok: false, error: "commands must contain at least one read-only command" } };
      if (b.commands.some((c) => /^(conf|system-view|reboot)/i.test(c))) return { status: 400, body: { ok: false, error: "commands_must_be_read_only" } };
      const id = scrM ? scrM[1] : `script_${netScripts.length + 1}`;
      const old = netScripts.find((x) => x.script_id === id);
      const rec = { script_id: id, name: b.name, vendors: b.vendors, commands: b.commands, checks: (b.checks ?? []) as unknown[], version: (old?.version ?? 0) + 1, source: "custom" };
      if (old) Object.assign(old, rec); else netScripts.push(rec);
      return { status: scrM ? 200 : 201, body: { ok: true, script: rec } };
    }
    if (scrM && method === "GET") { const x = netScripts.find((y) => y.script_id === scrM[1]); return x ? { status: 200, body: { ok: true, script: x } } : { status: 404, body: { ok: false } }; }
    if (p === "/api/extensions/network.operations/inspections") return { status: 200, body: { inspections: Object.values(inspections) } };
    const insp = /^\/api\/extensions\/network\.operations\/inspections\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (insp) {
      const t = inspections[insp[1]];
      if (!t) return { status: 404, body: { ok: false } };
      if (insp[2] === "/evidence") return { status: 200, body: { presentation: { devices: t.devices } } };
      if (insp[2] === "/retry") return { status: 202, body: { ok: true, task: { task_id: "insp-retry-1", status: "queued" } } };
      return { status: 200, body: { task: { task_id: t.task_id, status: t.status } } };
    }
    // 工作流：与 workflows/service.validate_definition 同形（nodes，不是 steps）。
    if (p === "/api/workflows" && method === "POST") {
      const b = body as { name?: string; nodes?: { node_id: string; tool_id: string; depends_on?: string[] }[] };
      if (!b.name) return { status: 400, body: { ok: false, error: "workflow name is required" } };
      if (!Array.isArray(b.nodes) || !b.nodes.length) return { status: 400, body: { ok: false, error: "workflow must contain 1 to 16 nodes" } };
      const wf = { workflow_id: `wf-${workflows.length + 1}`, name: b.name, version: 1, status: "active", nodes: b.nodes, execution_layers: [b.nodes.map((n) => n.node_id)], updated_at: "2026-11-10T00:00:00Z" };
      workflows.push(wf);
      return { status: 201, body: { ok: true, workflow: wf } };
    }
    if (p === "/api/workflows") return { status: 200, body: { workflows } };
    const wfM = /^\/api\/workflows\/([^/]+)$/.exec(p);
    if (wfM && method === "GET") { const w = workflows.find((x) => x.workflow_id === wfM[1]); return w ? { status: 200, body: { ok: true, workflow: w } } : { status: 404, body: { ok: false } }; }
    // runs / reports（A7）：/runs/<id>/report 只有 POST，GET 返回 405（与基线 Flask 一致）
    const runM = /^\/api\/workspaces\/[^/]+\/runs(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(p);
    if (runM) {
      if (!runM[1]) return { status: 200, body: { runs: [{ run_id: "run-a", status: "failed", title: "整理周报" }] } };
      if (!runM[2]) return runAudits[runM[1]] ? { status: 200, body: runAudits[runM[1]] } : { status: 200, body: { run: { run_id: runM[1], status: "failed" } } };
      if (runM[2] === "trace" && runTraces[runM[1]]) return { status: 200, body: { ok: true, run_id: runM[1], events: runTraces[runM[1]], trace: { event_count: runTraces[runM[1]].length, events: runTraces[runM[1]], total_duration_ms: 130 } } };
      if (runM[2] === "report") {
        if (method !== "POST") return { status: 405, body: { ok: false, error: "method_not_allowed" } };
        const rec = { artifact_id: `rep-new-${reports.length}`, title: (body as { title?: string }).title ?? "Run report", run_id: runM[1], sensitivity: "internal", created_at: "2026-11-09T00:00:00Z", content: "# 新报告" };
        reports.unshift(rec);
        return { status: 200, body: { ok: true, status: "accepted", artifact_id: rec.artifact_id } };
      }
      return { status: 200, body: { ok: true, [runM[2]]: [] } };
    }
    if (p === "/api/runs/recent") return { status: 200, body: { runs: [] } };
    if (/^\/api\/workspaces\/[^/]+\/reports$/.test(p)) return { status: 200, body: { reports: reports.map(({ content: _c, ...r }) => r) } };
    const repM = /^\/api\/workspaces\/[^/]+\/reports\/([^/]+)\/content$/.exec(p);
    if (repM) {
      const r = reports.find((x) => x.artifact_id === decodeURIComponent(repM[1]));
      const allow = new URLSearchParams(rawPath.split("?")[1] ?? "").get("allow_sensitive") === "1";
      if (!r || r.sensitivity === "secret" || (r.sensitivity === "sensitive" && !allow)) return { status: 403, body: { ok: false, error: "content not accessible" } };
      return { status: 200, body: { ok: true, content: r.content } };
    }
    if (p === "/api/workflows/wf1/runs" && method === "POST") return { status: 202, body: { ok: true, job: { job_id: "job-wf-1", status: "queued" } } };
    if (p === "/api/workflow-runs/run1") return { status: 200, body: { run: { run_id: "run1", workflow_id: "wf1", status: "running", task_id: "t-partial", started_at: "2026-11-10T13:45:41Z", nodes: [
      { node_id: "read", tool_id: "workspace.metadata.get", status: "succeeded", summary: "已读取工作区元数据", duration_ms: 0, errors: [], output: { artifact_count: 3 } },
      { node_id: "write", tool_id: "workspace.file.write", status: "execution_unknown", summary: "需要回读核对", errors: ["响应中断"] },
    ] } } };
    return undefined;
  };
}

export function installApp(opts: AppFixtureOptions = {}) {
  const log: Logged[] = [];
  const backend = installFixture(opts, appHandler(opts, log));
  return { ...backend, log };
}
