/**
 * 系统状态各分页的产品化投影。字段名以真实后端响应为准（见 lzcore-ui-fix-evidence/api-samples）：
 * - GET /api/runtime/health?workspace_id=  → { components: [{ name, status, message, details }], summary: { total, ok, warning, error } }
 * - GET /api/runtime/summary               → { capabilities: { total, enabled }, tools: { registered, model_visible, hidden_or_non_llm[] } }
 * - GET /api/agent/usage?workspace_id=     → { call_count, total_tokens, input_tokens, output_tokens, cache_*, estimated_cost, last_updated, ... }
 * - GET /api/workspaces/<ws>/selfcheck 与 GET /api/runtime/selfcheck?workspace_id= → { status, issues[], checks{} }
 * - GET /api/context/status                → { context_runtime_enabled, supported_refs[], default_budget{} }
 * 页面只做展示投影；完整响应始终可在「原始数据」折叠区展开、复制。
 */
import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import type { Tone } from "../../contracts/outcomeState";
import { useApi, type Loadable } from "../../kit/useApi";
import { Chip, KeyValues, LoadState, MetricGrid, ObjectView, RawData, StatusBanner, Table, fmtTime, scalarText } from "../../kit/ui";

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const fmtNum = (v: unknown) => { const n = num(v); return n === undefined ? "—" : n.toLocaleString("zh-CN"); };
const isOkStatus = (s: unknown) => ["ok", "healthy", "pass", "passed", "ready"].includes(String(s ?? "").toLowerCase());
const statusTone = (s: unknown): Tone | "neutral" => {
  const v = String(s ?? "").toLowerCase();
  if (isOkStatus(v)) return "ok";
  if (["warning", "warn", "degraded"].includes(v)) return "warn";
  if (["error", "failed", "fail", "unhealthy", "down"].includes(v)) return "danger";
  return "neutral";
};
const STATUS_LABEL: Record<string, string> = { ok: "正常", healthy: "健康", warning: "警告", warn: "警告", degraded: "降级", error: "错误", failed: "失败", unhealthy: "不健康" };
export const statusLabel = (s: unknown) => STATUS_LABEL[String(s ?? "").toLowerCase()] ?? (s === undefined || s === null || s === "" ? "未上报" : String(s));

/** 一个读取 + 标题 + 刷新 + 原始数据的分区骨架。 */
export function ReadSection({ title, path, query, children, actions }: {
  title: string; path: string; query?: Record<string, string>; actions?: ReactNode;
  children?: (data: Obj, reload: () => void) => ReactNode;
}) {
  const [v, reload] = useApi<Obj>(path, query);
  return (
    <section className="section" data-testid={`read:${path}`}>
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        <span className="grow" />
        {actions}
        <Button className="sm" variant="ghost" onClick={reload}>刷新</Button>
      </div>
      <LoadState value={v} onReload={reload}>{(d) => (
        <>
          {children ? children(d, reload) : <ObjectView value={d} />}
          <RawData value={d} path={withQuery(path, query)} />
        </>
      )}</LoadState>
    </section>
  );
}
export function withQuery(path: string, query?: Record<string, string>) {
  const qs = new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v)).toString();
  return qs ? `${path}?${qs}` : path;
}

// ── 运行时健康 ─────────────────────────────────────────────
const COMPONENT_LABEL: Record<string, string> = {
  workspace: "工作区", capabilities: "能力目录", runs: "运行记录", artifacts: "产出文件", jobs: "作业", agent: "Agent 运行时",
  tool_runtime: "工具运行时", llm: "模型", archive: "归档", memory: "记忆", production_record_storage: "记录存储",
  production_object_storage: "对象存储", production_job_queue: "作业队列", production_event_bus: "事件总线", production_job_worker: "作业 Worker",
};
interface HealthComponent { name?: string; status?: string; message?: string; details?: Obj }

/** components 可能是数组（真实后端）或 {name: status} 映射（旧 mock）；统一成数组。 */
export function healthComponents(d: Obj): HealthComponent[] {
  const c = d.components;
  if (Array.isArray(c)) return c.filter((x): x is HealthComponent => !!x && typeof x === "object");
  if (c && typeof c === "object") return Object.entries(c as Obj).map(([name, status]) => (typeof status === "object" && status ? { name, ...(status as Obj) } : { name, status: String(status) }));
  return [];
}

function DetailPairs({ details }: { details?: Obj }) {
  const entries = Object.entries(details ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <span className="detail-pairs">
      {entries.map(([k, v]) => <span key={k}><b>{k}</b> {Array.isArray(v) ? `${v.length} 项` : typeof v === "object" && v ? JSON.stringify(v) : scalarText(v)}</span>)}
    </span>
  );
}

export function HealthView({ ws }: { ws: string }) {
  const q = { workspace_id: ws };
  const [summary] = useApi<Obj>("/api/runtime/summary", q);
  return (
    <ReadSection title="组件健康" path="/api/runtime/health" query={q}>{(d) => {
      const comps = healthComponents(d);
      const s = (d.summary ?? {}) as Obj;
      const counts = { total: num(s.total) ?? comps.length, ok: num(s.ok) ?? comps.filter((c) => isOkStatus(c.status)).length,
        warning: num(s.warning) ?? comps.filter((c) => statusTone(c.status) === "warn").length, error: num(s.error) ?? comps.filter((c) => statusTone(c.status) === "danger").length };
      const overall: Tone = counts.error ? "danger" : counts.warning ? "warn" : "ok";
      const sum = summary.state === "ok" ? summary.data : null;
      const caps = (sum?.capabilities ?? {}) as Obj, tools = (sum?.tools ?? {}) as Obj;
      const hidden = Array.isArray(tools.hidden_or_non_llm) ? tools.hidden_or_non_llm as string[] : [];
      return (
        <>
          <StatusBanner tone={overall} testId="health-banner"
            title={counts.error ? `${counts.error} 个组件错误` : counts.warning ? `${counts.warning} 个组件需要注意` : "全部组件正常"}
            detail={`共 ${counts.total} 个组件 · 工作区 ${ws}`} />
          <MetricGrid testId="health-metrics" items={[
            { label: "组件", value: fmtNum(counts.total) },
            { label: "正常", value: fmtNum(counts.ok), tone: "ok" },
            { label: "警告", value: fmtNum(counts.warning), tone: counts.warning ? "warn" : "neutral" },
            { label: "错误", value: fmtNum(counts.error), tone: counts.error ? "danger" : "neutral" },
            { label: "能力（启用 / 总数）", value: sum ? `${fmtNum(caps.enabled)} / ${fmtNum(caps.total)}` : summary.state === "error" ? "不可读" : "…" },
            { label: "工具（模型可见 / 注册）", value: sum ? `${fmtNum(tools.model_visible)} / ${fmtNum(tools.registered)}` : summary.state === "error" ? "不可读" : "…",
              context: sum ? (hidden.length ? `隐藏或不供模型调用：${hidden.join("、")}` : "没有隐藏工具") : undefined },
          ]} />
          {comps.length ? (
            <div className="health-components">
              <Table testId="health-components" rows={comps} rowKey={(c) => String(c.name)} columns={[
                { key: "name", label: "组件", render: (c) => <>{COMPONENT_LABEL[String(c.name)] ?? c.name} <code className="muted">{c.name}</code></>, sortValue: (c) => String(c.name) },
                { key: "status", label: "状态", render: (c) => <Chip tone={statusTone(c.status)}>{statusLabel(c.status)}</Chip>, sortValue: (c) => String(c.status) },
                { key: "message", label: "说明", render: (c) => c.message ?? "—" },
                { key: "details", label: "详情", render: (c) => <DetailPairs details={c.details} /> },
              ]} />
            </div>
          ) : <ObjectView value={d} />}
          {sum ? <RawData value={sum} path={withQuery("/api/runtime/summary", q)} label="原始数据（能力与工具统计）" /> : null}
        </>
      );
    }}</ReadSection>
  );
}

// ── 用量 ──────────────────────────────────────────────────
const USAGE_KNOWN = new Set(["ok", "workspace_id", "session_id", "call_count", "total_tokens", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_hit_ratio", "estimated_cost", "last_updated"]);
export function UsageView({ ws }: { ws: string }) {
  const q = { workspace_id: ws };
  return (
    <ReadSection title="模型用量" path="/api/agent/usage" query={q}>{(d) => {
      const calls = num(d.call_count);
      const ratio = num(d.cache_hit_ratio);
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !USAGE_KNOWN.has(k)));
      return (
        <>
          <StatusBanner tone={calls ? "ok" : "neutral"} testId="usage-banner"
            title={calls ? `共 ${fmtNum(calls)} 次模型调用` : "还没有模型调用记录"}
            detail={`工作区 ${String(d.workspace_id ?? ws)} · 最近更新 ${d.last_updated ? fmtTime(d.last_updated) : "—"}`} />
          <MetricGrid testId="usage-metrics" items={[
            { label: "调用次数", value: fmtNum(d.call_count) },
            { label: "总 tokens", value: fmtNum(d.total_tokens) },
            { label: "输入 tokens", value: fmtNum(d.input_tokens) },
            { label: "输出 tokens", value: fmtNum(d.output_tokens) },
            { label: "缓存读取 tokens", value: fmtNum(d.cache_read_input_tokens) },
            { label: "缓存写入 tokens", value: fmtNum(d.cache_creation_input_tokens) },
            { label: "缓存命中率", value: ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%` },
            { label: "估算费用", value: num(d.estimated_cost) === undefined ? scalarText(d.estimated_cost) : String(d.estimated_cost), context: "按 Provider 价目估算，非账单" },
          ]} />
          {d.latest_prompt_profile && typeof d.latest_prompt_profile === "object" ? <PromptProfile p={d.latest_prompt_profile as Obj} /> : null}
          {Object.keys(rest).filter((k) => k !== "latest_prompt_profile").length ? <details className="section object-fold"><summary className="section-title">其他用量字段（展开查看）</summary><ObjectView value={Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "latest_prompt_profile"))} /></details> : null}
        </>
      );
    }}</ReadSection>
  );
}

const LAYER_ZH: Record<string, string> = {
  capability_playbooks: "能力手册", cognitive_state: "推理状态", continuation_messages: "续写消息", conversation_history: "对话历史",
  current_request: "当前请求", dynamic_system: "动态系统提示", governed_context: "受控上下文", managed_attachments: "托管附件",
  static_system: "静态系统提示", tool_schemas: "工具定义", memory: "记忆", knowledge: "知识",
  stable_system: "稳定系统提示", runtime_identity: "运行身份", selected_skill: "选用 Skill", runtime_clock: "运行时钟",
  operational_guards: "操作护栏", task_state: "任务状态",
};
/** 最近一次提示构成：只列「各层是否出现 + 估算 token」，指纹 / 缓存键等诊断字段折叠。 */
function PromptProfile({ p }: { p: Obj }) {
  const layers = Object.entries((p.layers ?? {}) as Record<string, { present?: boolean; estimated_tokens?: number; characters?: number; cacheable?: boolean }>);
  const present = layers.filter(([, l]) => l.present);
  const total = present.reduce((n, [, l]) => n + (l.estimated_tokens ?? 0), 0);
  return (
    <section className="section" data-testid="usage-prompt-profile">
      <h3 className="section-title">最近一次提示构成</h3>
      <p className="muted">{present.length} / {layers.length} 层参与，估算约 {fmtNum(total)} tokens（估算值，不是账单）。</p>
      {layers.length ? (
        <div className="table-wrap"><table className="table">
          <thead><tr><th scope="col">层</th><th scope="col">是否参与</th><th scope="col">估算 tokens</th><th scope="col">可缓存</th></tr></thead>
          <tbody>{layers.map(([k, l]) => <tr key={k}><td title={k}>{LAYER_ZH[k] ?? k}</td><td>{l.present ? "参与" : "未参与"}</td><td>{l.present ? fmtNum(l.estimated_tokens) : "—"}</td><td>{l.cacheable ? "是" : "否"}</td></tr>)}</tbody>
        </table></div>
      ) : null}
      <RawData value={p} label="提示构成诊断原文（指纹、缓存键）" />
    </section>
  );
}

// ── 自检 ──────────────────────────────────────────────────
const CHECK_LABEL: Record<string, string> = {
  artifacts_count: "产出文件数", jobs_count: "作业数", runs_count: "运行数", run_traces_count: "追踪数", durable_event_empty_task_id: "缺 task_id 的持久事件",
  durable_event_invalid: "无效持久事件", forbidden_api: "禁用 API 检查", state_json: "状态文件", tool_runtime: "工具运行时", workspace_root: "工作区根目录",
  tool_registered_count: "注册工具数", tool_forbidden_count: "禁用工具数", enabled_capabilities: "启用能力", tool_forbidden_list: "禁用工具", tool_governance: "工具治理",
  active: "启用", disabled: "停用", forbidden: "禁止", internal: "内部",
};
export function SelfcheckBody({ d }: { d: Obj }) {
  const checks = (d.checks ?? {}) as Obj;
  const issues = Array.isArray(d.issues) ? d.issues : [];
  const counts = Object.entries(checks).filter(([, v]) => typeof v === "number");
  const flags = Object.entries(checks).filter(([, v]) => typeof v === "string" || typeof v === "boolean");
  const others = Object.fromEntries(Object.entries(checks).filter(([, v]) => !(typeof v === "number" || typeof v === "string" || typeof v === "boolean")));
  return (
    <>
      <StatusBanner tone={issues.length ? "warn" : statusTone(d.status)} title={issues.length ? `${issues.length} 个问题` : `自检：${statusLabel(d.status)}`} detail={issues.length ? undefined : "没有发现问题"} />
      {issues.length ? <ul className="section">{issues.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>)}</ul> : null}
      {counts.length ? <MetricGrid items={counts.map(([k, v]) => ({ label: CHECK_LABEL[k] ?? k, value: fmtNum(v), tone: /invalid|empty|forbidden_count/.test(k) && v ? "warn" : "neutral" }))} /> : null}
      {flags.length ? <KeyValues items={flags.map(([k, v]) => [CHECK_LABEL[k] ?? k, typeof v === "string" ? <Chip tone={statusTone(v)}>{statusLabel(v)}</Chip> : scalarText(v)])} /> : null}
      {Object.keys(others).length ? <ObjectView value={others} labels={CHECK_LABEL} /> : null}
    </>
  );
}
export function SelfcheckView({ ws }: { ws: string }) {
  return (
    <div className="grid-2">
      <ReadSection title="工作区自检" path={`/api/workspaces/${encodeURIComponent(ws)}/selfcheck`}>{(d) => <SelfcheckBody d={d} />}</ReadSection>
      <ReadSection title="运行时自检" path="/api/runtime/selfcheck" query={{ workspace_id: ws }}>{(d) => <SelfcheckBody d={d} />}</ReadSection>
    </div>
  );
}

// ── 上下文运行时 ───────────────────────────────────────────
export function ContextView({ ws }: { ws: string }) {
  return (
    <ReadSection title="上下文运行时" path="/api/context/status" query={{ workspace_id: ws }}>{(d) => {
      const budget = (d.default_budget ?? {}) as Obj;
      const refs = Array.isArray(d.supported_refs) ? d.supported_refs : [];
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !["default_budget", "supported_refs", "context_runtime_enabled"].includes(k)));
      return (
        <>
          <StatusBanner tone={d.context_runtime_enabled === true ? "ok" : d.context_runtime_enabled === false ? "warn" : "neutral"}
            title={d.context_runtime_enabled === true ? "上下文运行时已启用" : d.context_runtime_enabled === false ? "上下文运行时未启用" : "启用状态未上报"} />
          <MetricGrid items={[{ label: "默认条目上限", value: fmtNum(budget.max_items) }, { label: "默认字符上限", value: fmtNum(budget.max_chars) }, { label: "支持的引用", value: fmtNum(refs.length) }]} />
          <section className="section"><h3 className="section-title">支持的上下文引用</h3><ObjectView value={refs} /></section>
          {Object.keys(rest).length ? <ObjectView value={rest} /> : null}
        </>
      );
    }}</ReadSection>
  );
}

export type { Loadable };
