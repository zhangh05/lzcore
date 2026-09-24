/**
 * Diagnostics — 系统诊断仪表盘
 *
 * 设计：手动触发检测，默认显示上一次缓存数据，避免每次进入都 loading。
 * 点击「开始检测」→ 调用全部 API → 缓存到 localStorage → 更新仪表盘。
 * 无缓存时显示空骨架 + 醒目的检测按钮。
 */
import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { Link } from "../../router";
import {
  runtimeApi, agentUsageApi, retentionApi, archiveApi, contextApi, promptsApi,
  operationLedgerApi,
} from "../../api";
import type { OperationLedgerSummary } from "../../api";
import { useSessionStore } from "../../stores/session";
import { Badge } from "../../components/common";
import { IconAlert, IconCheck, IconRefresh } from "../../components/Icon";
import { formatDate } from "../../utils/format";
import { PageHeader, DataTable } from "../../components/ui";
import { scopedLocalStorageKey } from "../../utils/userScope";

const CACHE_KEY = "diagnostics_v1";

/* ──────────────────────── Types ──────────────────────── */

type UsageStats = {
  call_count: number; total_tokens: number; input_tokens: number;
  output_tokens: number; estimated_cost: number; last_updated: string;
  cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
  cache_hit_ratio?: number;
  prompt_cache_strategies?: Record<string, number>;
  latest_prompt_profile?: {
    strategy?: string;
    stable_prefix_fingerprint?: string;
    stable_prefix_estimated_tokens?: number;
    selected_skill?: boolean;
    layers?: Record<string, { estimated_tokens?: number; present?: boolean; cacheable?: boolean }>;
  };
};

type HealthComponent = {
  name: string;
  status: "ok" | "warning" | "error";
  message?: string;
};

type HealthData = {
  summary?: { ok?: number; warning?: number; error?: number };
  components?: HealthComponent[];
};

type SelfcheckIssue = {
  severity: "error" | "warning";
  code?: string;
  ref_id?: string;
  message: string;
  suggested_action?: string;
};

type SelfcheckData = {
  status?: string;
  issues?: SelfcheckIssue[];
};

type PromptItem = {
  prompt_id: string;
  description?: string;
  task?: string;
  version?: string;
};

type PolicyData = { policy?: Record<string, unknown> };

type OperationLedgerData = {
  operations: OperationLedgerSummary[];
  counts: Record<string, number>;
};


type DiagnosticsCache = {
  ts: string;
  health: HealthData | null;
  selfcheck: SelfcheckData | null;
  usage: UsageStats | null;
  contextOk: boolean | null;
  prompts: PromptItem[] | null;
  retention: PolicyData;
  archive: PolicyData;
  operations: OperationLedgerData | null;
};

/* ── 内部组件名 → 用户友好名称 ── */
const COMP_LABELS: Record<string, string> = {
  workspace: "工作空间", registry: "能力注册", runs: "运行记录",
  artifacts: "任务产出管理", jobs: "任务调度", agent: "智能体核心",
  tool_runtime: "工具服务", llm: "模型服务", archive: "归档存储",
  memory: "记忆系统", context: "上下文", knowledge: "知识库",
  web: "Web 能力", browser: "浏览器", data: "数据处理",
  production_record_storage: "业务记录存储", production_object_storage: "文件对象存储",
  production_job_queue: "任务队列", production_job_worker: "任务工作进程",
};

const COMP_DESC: Record<string, string> = {
  workspace: "当前工作区配置与状态", registry: "模块与技能注册表",
  runs: "历史执行记录", artifacts: "任务产出与输出文件",
  jobs: "定时任务与触发任务", agent: "智能体主服务状态",
  tool_runtime: "外部工具调用服务", llm: "模型服务连通性与用量",
  archive: "历史数据归档策略", memory: "长期记忆存储状态",
  context: "对话上下文窗口", knowledge: "知识检索服务",
  production_record_storage: "本地文件或 PostgreSQL 记录存储的实际连通状态",
  production_object_storage: "本地文件或 S3 对象存储的实际连通状态",
  production_job_queue: "本地队列或 Redis 队列的实际连通状态",
  production_job_worker: "工作进程心跳、任务租约与失联状态",
};

/* ──────────────────────── Cache helpers ──────────────────────── */

// Singleton subscription handle for cross-component invalidation. Keep the
// parsed snapshot reference stable between writes; returning a fresh
// JSON.parse() object from getSnapshot on every render makes React think the
// external store changed forever and causes "Maximum update depth exceeded".
const cacheStore = (() => {
  let snapshot: DiagnosticsCache | null | undefined;
  let snapshotKey = "";
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): DiagnosticsCache | null {
      const currentKey = scopedLocalStorageKey(CACHE_KEY);
      if (snapshot === undefined || snapshotKey !== currentKey) {
        snapshotKey = currentKey;
        snapshot = readCache();
      }
      return snapshot;
    },
    publish(next: DiagnosticsCache) {
      snapshotKey = scopedLocalStorageKey(CACHE_KEY);
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
})();

function parseCache(json: string | null): DiagnosticsCache | null {
  if (!json) return null;
  try { return JSON.parse(json) as DiagnosticsCache; } catch { return null; }
}

function readCache(): DiagnosticsCache | null {
  if (typeof localStorage === "undefined") return null;
  return parseCache(localStorage.getItem(scopedLocalStorageKey(CACHE_KEY)));
}

function writeCache(data: Omit<DiagnosticsCache, "ts">) {
  try {
    const entry: DiagnosticsCache = { ts: new Date().toISOString(), ...data };
    localStorage.setItem(scopedLocalStorageKey(CACHE_KEY), JSON.stringify(entry));
    cacheStore.publish(entry);
  } catch { /* quota exceeded — silently ignore */ }
}

/** Subscribes to the stable cached snapshot. The reference changes only after
 *  writeCache() publishes a new entry. */
function useCachedDiagnostics(): DiagnosticsCache | null {
  return useSyncExternalStore(
    cacheStore.subscribe,
    cacheStore.getSnapshot,
    () => null,
  );
}

function selfcheckIssueCopy(issue: SelfcheckIssue): { message: string; action?: string } {
  const ref = issue.ref_id ? `（${issue.ref_id}）` : "";
  switch (issue.code) {
    case "ABSOLUTE_PATH":
      return {
        message: `运行记录${ref}含本机绝对路径`,
        action: "脱敏运行记录中的本机路径，避免泄露本机目录。",
      };
    case "TRACE_PATH_LEAK":
      return {
        message: `执行追踪${ref}含本机绝对路径`,
        action: "脱敏追踪元数据中的本机路径，避免泄露本机目录。",
      };
    default:
      return {
        message: issue.message || "自检发现问题",
        action: issue.suggested_action,
      };
  }
}

/* ──────────────────────── Component ──────────────────────── */

export function Diagnostics() {
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);
  const cache = useCachedDiagnostics();

  // State: init from cache or null
  const [health, setHealth] = useState<HealthData | null>(cache?.health ?? null);
  const [selfcheck, setSelfcheck] = useState<SelfcheckData | null>(cache?.selfcheck ?? null);
  const [usage, setUsage] = useState<UsageStats | null>(cache?.usage ?? null);
  const [contextOk, setContextOk] = useState<boolean | null>(cache?.contextOk ?? null);
  const [prompts, setPrompts] = useState<PromptItem[] | null>(cache?.prompts ?? null);
  const [retention, setRetention] = useState<PolicyData>(cache?.retention ?? {});
  const [archive, setArchive] = useState<PolicyData>(cache?.archive ?? {});
  const [operations, setOperations] = useState<OperationLedgerData | null>(cache?.operations ?? null);
  const [operationLedgerError, setOperationLedgerError] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(cache?.ts ?? null);
  const [resolvingOperation, setResolvingOperation] = useState("");

  const [detecting, setDetecting] = useState(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const runDetection = useCallback(async () => {
    const seq = ++seqRef.current;
    setDetecting(true);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const wsId = currentWorkspaceId;
    if (!wsId) {
      setDetecting(false);
      return;
    }
    setOperationLedgerError(false);
    try {
      const [rh, sc, us, cs, pr, rp, ap, ol] = await Promise.allSettled([
        runtimeApi.health(wsId, ctrl.signal),
        runtimeApi.selfcheck(wsId, ctrl.signal),
        agentUsageApi.get(wsId, ctrl.signal),
        contextApi.status(ctrl.signal),
        promptsApi.list(ctrl.signal),
        retentionApi.preview(wsId, ctrl.signal),
        archiveApi.preview(wsId, ctrl.signal),
        operationLedgerApi.list(wsId, ctrl.signal),
      ]);
      if (!mountedRef.current || seq !== seqRef.current) return;

      let newHealth: HealthData | null = null;
      let newSelfcheck: SelfcheckData | null = null;
      let newUsage: UsageStats | null = null;
      let newContextOk: boolean | null = null;
      let newPrompts: PromptItem[] | null = null;
      let newRetention: PolicyData = {};
      let newArchive: PolicyData = {};
      let newOperations: OperationLedgerData | null = null;

      if (rh.status === "fulfilled") {
        newHealth = rh.value as HealthData;
        setHealth(newHealth);
      }
      if (sc.status === "fulfilled") {
        newSelfcheck = sc.value as SelfcheckData;
        setSelfcheck(newSelfcheck);
      }
      if (us.status === "fulfilled") {
        const raw = us.value;
        newUsage = {
          call_count: raw.call_count ?? 0,
          total_tokens: raw.total_tokens ?? 0,
          input_tokens: raw.input_tokens ?? 0,
          output_tokens: raw.output_tokens ?? 0,
          estimated_cost: raw.estimated_cost ?? 0,
          last_updated: raw.last_updated ?? "",
        };
        setUsage(newUsage);
      }
      if (cs.status === "fulfilled") {
        newContextOk = (cs.value).context_runtime_enabled;
        setContextOk(newContextOk);
      }
      if (pr.status === "fulfilled") {
        newPrompts = ((pr.value).prompts ?? []) as PromptItem[];
        setPrompts(newPrompts);
      }
      if (rp.status === "fulfilled") {
        newRetention = rp.value as PolicyData;
        setRetention(newRetention);
      }
      if (ap.status === "fulfilled") {
        newArchive = ap.value as PolicyData;
        setArchive(newArchive);
      }
      if (ol.status === "fulfilled") {
        newOperations = {
          operations: ol.value.operations ?? [],
          counts: ol.value.counts ?? {},
        };
        setOperations(newOperations);
      } else if (!ctrl.signal.aborted) {
        setOperationLedgerError(true);
      }

      // Save to cache
      writeCache({
        health: newHealth,
        selfcheck: newSelfcheck,
        usage: newUsage,
        contextOk: newContextOk,
        prompts: newPrompts,
        retention: newRetention,
        archive: newArchive,
        operations: newOperations,
      });
      setLastCheck(new Date().toISOString());
    } finally {
      if (mountedRef.current && seq === seqRef.current) {
        setDetecting(false);
      }
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const hs = health?.summary ?? {};
  const runtimeOk = (hs.ok ?? 0) > 0 && (hs.warning ?? 0) === 0 && (hs.error ?? 0) === 0;
  const selfcheckIssueCount = selfcheck?.issues?.length ?? 0;
  const selfcheckOk = !selfcheck || (selfcheck.status === "healthy" && selfcheckIssueCount === 0);
  const operationUnknownCount = operations?.counts.unknown ?? 0;
  const operationRunningCount = operations?.counts.running ?? 0;
  const allOk = runtimeOk && selfcheckOk && operationUnknownCount === 0 && operationRunningCount === 0;
  const hasData = health !== null || selfcheck !== null || usage !== null;

  const resolveUnknownOperation = useCallback(async (
    operationId: string,
    status: "succeeded" | "failed",
  ) => {
    if (!currentWorkspaceId || resolvingOperation) return;
    const outcome = status === "succeeded" ? "已成功完成" : "执行失败";
    const reason = window.prompt(`填写核对依据，说明为什么确认该操作${outcome}。`)?.trim();
    if (!reason) return;
    if (!window.confirm(`确认已核对外部事实，并将该操作标记为“${outcome}”？`)) return;
    setResolvingOperation(operationId);
    try {
      await operationLedgerApi.resolve(currentWorkspaceId, operationId, status, reason);
      const refreshed = await operationLedgerApi.list(currentWorkspaceId);
      setOperations({ operations: refreshed.operations, counts: refreshed.counts });
    } finally {
      setResolvingOperation("");
    }
  }, [currentWorkspaceId, resolvingOperation]);

  /* ── 概览摘要数据 ── */
  const summaryStats = useMemo(() => {
    if (!health && !usage) return null;
    const comps = health?.components ?? [];
    const okCount = comps.filter((c: HealthComponent) => c.status === "ok").length;
    const warnCount = comps.filter((c: HealthComponent) => c.status === "warning").length;
    const errCount = comps.filter((c: HealthComponent) => c.status === "error").length;
    return {
      totalComps: comps.length,
      okCount, warnCount, errCount,
      calls: usage?.call_count ?? 0,
      cost: usage?.estimated_cost ?? 0,
      tokens: usage?.total_tokens ?? 0,
      selfOk: selfcheckOk,
      issueCount: selfcheckIssueCount,
    };
  }, [health, usage, selfcheckOk, selfcheckIssueCount]);

  /* ══════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════ */

  return (
    <div className="page diagnostics-page" data-testid="page-diagnostics">
      <PageHeader
        title="系统状态"
        subtitle={
          <span>
            服务健康 · 模型用量 · 自动检查 · 数据策略
            {lastCheck && (
              <span className="ml-2 faint">上次检测：{formatDate(lastCheck, "compact")}</span>
            )}
            {hasData && (
              <span className={`ml-2 ${allOk ? "success-text" : "warning-text"}`}>
                {allOk ? "● 正常" : "● 注意"}
              </span>
            )}
          </span>
        }
      >
        <button
          className="btn sm diag-run-btn"
          onClick={runDetection}
          disabled={detecting}
        >
          {detecting ? (
            <><IconRefresh size={12} aria-hidden="true" /> 检测中…</>
          ) : (
            <><IconRefresh size={12} /> {hasData ? "重新检测" : "开始检测"}</>
          )}
        </button>
      </PageHeader>

      <div className="page-body page-body-flex">
        {/* ═══ 概览摘要卡（用户3秒看懂系统状态） ═══ */}
        {summaryStats ? (
          <div className="diag-summary">
            <div className="diag-summary-icon" data-healthy={String(allOk)}>
              {allOk ? <IconCheck size={20} aria-hidden="true" /> : <IconAlert size={20} aria-hidden="true" />}
            </div>
            <div className="diag-summary-text">
              <h2>{allOk ? "系统运行正常" : "需要注意"}</h2>
              <p>
                {summaryStats.okCount}/{summaryStats.totalComps} 项服务正常
                {summaryStats.warnCount > 0 && `，${summaryStats.warnCount} 项警告`}
                {summaryStats.errCount > 0 && `，${summaryStats.errCount} 项异常`}
                {summaryStats.calls > 0 && ` · 累计调用 ${summaryStats.calls.toLocaleString()} 次`}
                {summaryStats.issueCount > 0 && ` · 自检发现 ${summaryStats.issueCount} 项问题`}
                {summaryStats.cost > 0 && ` · 花费 ¥${summaryStats.cost.toFixed(4)}`}
              </p>
            </div>
            {!summaryStats.selfOk && summaryStats.issueCount > 0 && (
              <div className="diag-summary-alert">
                自检发现 {summaryStats.issueCount} 个问题
              </div>
            )}
          </div>
        ) : (
          <div className="diag-summary diag-summary-standby">
            <div className="diag-summary-icon diag-icon-idle">
              <IconRefresh size={18} className={detecting ? "spin" : ""} aria-hidden="true" />
            </div>
            <div className="diag-summary-text">
              <h2>{detecting ? "正在执行系统全面诊断…" : "系统就绪待检"}</h2>
              <p>
                {detecting
                  ? "正在全面检测 16 项核心子系统健康度、模型用量统计、规约自检与写操作账本…"
                  : "暂未执行系统全面诊断。点击右侧开始扫描 16 项核心子系统健康度、模型用量与写操作账本。"}
              </p>
            </div>
            <button
              className="btn primary sm"
              onClick={runDetection}
              disabled={detecting}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              {detecting ? (
                <><IconRefresh size={12} className="spin" aria-hidden="true" /> 检测中…</>
              ) : (
                "立即开始全面检测"
              )}
            </button>
          </div>
        )}

        {/* ═══ 行1: 运行时健康（全宽） ═══ */}
        <div>
          <Section title="运行时健康" badge={
            health ? (
              <span className="diag-section-badge">
                {runtimeOk ? <span className="diag-section-badge diag-text-ok">● 全部正常</span> : `${hs.ok} 正常` + (hs.warning ? ` / ${hs.warning} 警告` : "") + (hs.error ? ` / ${hs.error} 异常` : "")}
              </span>
            ) : null
          }>
            {health ? (
              <div className="diag-health-grid">
                {[...(health.components ?? [])]
                  .sort((a, b) => Number(a.status === "ok") - Number(b.status === "ok"))
                  .map((c: HealthComponent) => {
                  const label = COMP_LABELS[c.name] || c.name;
                  const desc = COMP_DESC[c.name] || "";
                  return (
                    <div key={c.name} className={`diag-health-card diag-health-${c.status}`}>
                      <div className="diag-health-head">
                        <span className={`diag-status-dot diag-status-${c.status}`} />
                        <span className="diag-comp-name">{label}</span>
                        <Badge kind={c.status === "ok" ? "ok" : c.status === "warning" ? "warn" : "err"}>
                          {c.status === "ok" ? "正常" : c.status === "warning" ? "警告" : "异常"}
                        </Badge>
                      </div>
                      {desc && <div className="diag-comp-desc">{desc}</div>}
                      {c.message && <div className="diag-comp-msg">{c.message}</div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="diag-health-grid diag-health-standby">
                {Object.entries(COMP_LABELS).slice(0, 16).map(([name, label]) => (
                  <div key={name} className="diag-health-card diag-health-idle">
                    <div className="diag-health-head">
                      <span className={`diag-status-dot ${detecting ? "diag-status-detecting" : "diag-status-idle"}`} />
                      <span className="diag-comp-name">{label}</span>
                      <Badge kind={detecting ? "info" : "muted"}>{detecting ? "检测中" : "就绪待检"}</Badge>
                    </div>
                    <div className="diag-comp-desc">{COMP_DESC[name] || "核心服务模块就绪"}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* ═══ 行2: 用量 + 自检 + 提示词 ═══ */}
        <div className="diag-row-3col">
          <Section title="用量统计">
            {usage ? (
              <div className="diag-usage-body">
                <div className="diag-usage-big">
                  <span className="diag-usage-number">{usage.call_count.toLocaleString()}</span>
                  <span className="diag-usage-unit">次调用</span>
                </div>
                <div className="diag-usage-rows">
                  <Row label="Token 总量" value={usage.total_tokens.toLocaleString()} />
                  <Row label="输入 / 输出" value={`${usage.input_tokens.toLocaleString()} / ${usage.output_tokens.toLocaleString()}`} dim />
                  <Row label="缓存读取 / 写入" value={`${Number(usage.cache_read_input_tokens ?? 0).toLocaleString()} / ${Number(usage.cache_creation_input_tokens ?? 0).toLocaleString()}`} dim />
                  <Row label="输入缓存命中" value={`${(Number(usage.cache_hit_ratio ?? 0) * 100).toFixed(1)}%`} dim />
                  <Row label="缓存策略" value={usage.latest_prompt_profile?.strategy || Object.keys(usage.prompt_cache_strategies || {}).join("、") || "未报告"} dim />
                  <Row label="稳定前缀" value={usage.latest_prompt_profile ? `${Number(usage.latest_prompt_profile.stable_prefix_estimated_tokens ?? 0).toLocaleString()} tokens · ${(usage.latest_prompt_profile.stable_prefix_fingerprint || "").slice(0, 12)}` : "暂无装配记录"} dim />
                  <Row label="Skill 提示词" value={usage.latest_prompt_profile?.selected_skill ? "本轮按需装配" : "本轮未装配"} dim />
                  <div className="diag-cost-row">
                    <span className="diag-cost-label">预估费用</span>
                    <b className="diag-cost">¥{Number(usage.estimated_cost ?? 0).toFixed(4)}</b>
                  </div>
                </div>
              </div>
            ) : detecting ? (
              <EmptyHint icon="loading" title="正在拉取用量数据…" hint="正在同步累计调用次数、Token 消耗与模型预估费用" />
            ) : (
              <EmptyHint title="尚未获取模型用量统计" hint="执行全面检测后展示累计调用、Token 消耗与预估费用" />
            )}
          </Section>

          <Section title="自动检查结果" badge={selfcheck?.status === "healthy" ? <span className="diag-section-badge diag-text-ok">通过</span> : (selfcheck?.issues?.length ?? 0) > 0 ? <span className="diag-section-badge diag-text-warn">{(selfcheck?.issues?.length ?? 0)} 项问题</span> : null}>
            {selfcheck ? (
              selfcheck.issues && selfcheck.issues.length > 0 ? (
                <div className="diag-issues-list">
                  {selfcheck.issues.map((iss: SelfcheckIssue, i: number) => {
                    const copy = selfcheckIssueCopy(iss);
                    return (
                      <div key={i} className={`diag-issue-item diag-issue-${iss.severity}`}>
                        <span className="diag-issue-sev">{iss.severity === "error" ? "错误" : "警告"}</span>
                        <div className="diag-issue-body">
                          <span className="diag-issue-msg">{copy.message}</span>
                          {copy.action && <span className="diag-issue-action">建议：{copy.action}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="diag-check-passed">
                  <div className="diag-check-passed-icon">
                    <IconCheck size={18} aria-hidden="true" />
                  </div>
                  <div className="diag-check-passed-title">安全与规约检查全部通过</div>
                  <div className="diag-check-passed-desc">未发现本机绝对路径泄露、追踪元数据异常或配置不合规问题。</div>
                </div>
              )
            ) : detecting ? (
              <EmptyHint icon="loading" title="正在执行规约自检…" hint="正在排查运行记录与追踪元数据中的合规性风险" />
            ) : (
              <EmptyHint title="尚未执行安全与规约自检" hint="检测后自动排查绝对路径泄露与配置合规风险" />
            )}
          </Section>

          <Section title="提示词库" badge={prompts?.length != null ? <span className="faint">{prompts.length} 条</span> : null}>
            {prompts && prompts.length > 0 ? (
              <div className="diag-prompt-list">
                <DataTable<PromptItem>
                  rows={prompts}
                  keyExtractor={(p) => p.prompt_id}
                  columns={[
                    { key: "desc", header: "用途说明", render: (p) => <span className="diag-prompt-desc">{p.description || p.task || p.prompt_id}</span> },
                    { key: "version", header: "版本", width: 70, align: "center", render: (p) => <span className="diag-ver-badge">{p.version}</span> },
                    { key: "id", header: "ID", width: 180, render: (p) => <span className="diag-prompt-id">{p.prompt_id}</span> },
                  ]}
                />
              </div>
            ) : detecting ? (
              <EmptyHint icon="loading" title="正在加载提示词库…" hint="正在检索当前工作区装配的系统提示词" />
            ) : (
              <EmptyHint title="暂无装配的系统提示词" hint="系统当前未装配额外的系统提示词模版" />
            )}
          </Section>
        </div>

        {/* ═══ 行3: 上下文 + 数据策略 ═══ */}
        <div className="diag-row-2col">
          <Section title="上下文运行时">
            {contextOk !== null ? (
              <div className="diag-context-info">
                <div className={`diag-context-status ${contextOk ? "diag-context-on" : "diag-context-off"}`}>
                  <span className={`diag-status-dot diag-status-${contextOk ? "ok" : "error"}`} />
                  {contextOk ? "已启用" : "未启用"}
                </div>
                <p className="diag-context-desc">
                  {contextOk
                    ? "上下文运行时已开启，智能体可在多轮对话中维护完整的工作记忆与任务状态。"
                    : "上下文运行时未启用，部分跨轮次的功能可能受限。如需完整体验，请在后端配置中启用。"}
                </p>
              </div>
            ) : detecting ? (
              <EmptyHint icon="loading" title="正在检测上下文运行时…" hint="正在检查工作记忆与任务状态维护能力" />
            ) : (
              <EmptyHint title="尚未检测上下文运行时" hint="检测后展示多轮对话记忆与任务状态维护能力" />
            )}
          </Section>

          <Section title="数据策略">
            <div className="diag-policy-management">
              <span>此处只显示当前策略，文件和归档操作统一在数据管理中完成。</span>
              <Link className="btn sm" to="/data" viewTransition>打开数据管理</Link>
            </div>
            <div className="diag-policy-grid">
              {retention?.policy && (
                <div className="diag-policy-block">
                  <div className="diag-policy-title">到期清理规则</div>
                  {Object.entries(retention.policy).slice(0, 5).map(([k, v]) => (
                    <Row key={k} label={fmtKey(k)} value={fmtVal(k, v)} compact />
                  ))}
                </div>
              )}
              {archive?.policy && (
                <div className="diag-policy-block">
                  <div className="diag-policy-title">历史归档规则</div>
                  {Object.entries(archive.policy).slice(0, 5).map(([k, v]) => (
                    <Row key={k} label={fmtKey(k)} value={fmtVal(k, v)} compact />
                  ))}
                </div>
              )}
              {!retention?.policy && !archive?.policy && (
                detecting ? (
                  <EmptyHint icon="loading" title="正在读取数据策略…" hint="正在获取生命周期到期清理与历史归档规则" />
                ) : (
                  <EmptyHint title="尚未读取生命周期策略" hint="检测后展示历史数据到期清理与归档规则" />
                )
              )}
            </div>
          </Section>
        </div>

        <div>
          <Section title="写操作账本" badge={operations ? (
            <span className={`diag-section-badge ${operationUnknownCount + operationRunningCount === 0 ? "diag-text-ok" : "diag-text-warn"}`}>
              {operationUnknownCount + operationRunningCount === 0 ? "无待核对项" : `${operationUnknownCount + operationRunningCount} 项未决操作`}
            </span>
          ) : null}>
            {operations ? (
              <div className="diag-continuation-panel" data-testid="operation-ledger-panel">
                <div className="diag-continuation-summary">
                  <Row label="结果未知" value={String(operationUnknownCount)} compact />
                  <Row label="当前执行中" value={String(operationRunningCount)} compact />
                  <Row label="历史失败" value={String(operations.counts.failed ?? 0)} compact />
                </div>
                {operations.operations.filter((item) => item.status === "unknown" || item.status === "running").slice(0, 5).map((item) => (
                  <div className="diag-continuation-alert" key={item.operation_id}>
                    <div>
                      <b>{item.operation_id}</b>
                      <span>{item.canonical_tool} · {item.status === "unknown" ? "结果未知，先核对外部事实，禁止重试" : "仍在执行，请等待或按运维流程核对"}</span>
                      {item.planned_at && <small>发生时间：{formatDate(item.planned_at, "compact")}</small>}
                      {item.resource_kind && item.resource_id && <small>关联任务：{item.resource_kind} · {item.resource_id}</small>}
                      {item.error_code && <small>{item.error_code}</small>}
                    </div>
                    {item.status === "unknown" ? <div className="diag-operation-actions">
                      <button className="btn sm" disabled={resolvingOperation === item.operation_id} onClick={() => { void resolveUnknownOperation(item.operation_id, "succeeded"); }}>核对为成功</button>
                      <button className="btn sm" disabled={resolvingOperation === item.operation_id} onClick={() => { void resolveUnknownOperation(item.operation_id, "failed"); }}>核对为失败</button>
                    </div> : null}
                  </div>
                ))}
                {operations.operations.filter((item) => item.status === "unknown" || item.status === "running").length === 0 && (
                  <div className="diag-ledger-clean">
                    <IconCheck size={14} style={{ color: "var(--ok, #2e7d32)" }} aria-hidden="true" />
                    <span>{operations.operations.length === 0 ? "当前工作区暂无耐久写操作记录" : "当前无待核对或执行中的未决操作"}</span>
                  </div>
                )}
              </div>
            ) : operationLedgerError ? (
              <EmptyHint title="写操作账本暂时无法读取" hint="请检查管理权限或点击重新检测重试" />
            ) : detecting ? (
              <EmptyHint icon="loading" title="正在读取写操作账本…" hint="正在核对未决操作与执行状态" />
            ) : (
              <EmptyHint title="尚未同步写操作账本" hint="管理员执行系统检测后可查看写操作账本" />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ─── */

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="diag-section">
      <div className="diag-section-head">
        <h3 className="diag-section-title">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, dim, compact }: { label: string; value: string; dim?: boolean; compact?: boolean }) {
  return (
    <div className={`diag-row ${compact ? "diag-row-compact" : "diag-row-normal"}`}>
      <span className="diag-row-label">{label}</span>
      <span className={`diag-row-value ${dim ? "dim" : "normal"}`}>{value}</span>
    </div>
  );
}

function EmptyHint({ title, hint, icon }: { title: string; hint?: string; icon?: "loading" | "idle" }) {
  return (
    <div className="diag-empty-card">
      <div className="diag-empty-card-title">
        {icon === "loading" && <IconRefresh size={13} className="spin" aria-hidden="true" />}
        <span>{title}</span>
      </div>
      {hint && <div className="diag-empty-card-hint">{hint}</div>}
    </div>
  );
}

/* ─── Small helpers ─── */

function fmtKey(k: string): string {
  const m: Record<string, string> = {
    runs_max_age_days: "运行保留", runs_max_count: "最大运行",
    traces_max_age_days: "过程记录保留", traces_max_count: "最大过程记录",
    jobs_max_age_days: "任务保留", artifacts_temp_max_age_days: "临时任务产出",
    prune_reports: "清理报告",
    runs_older_than_days: "执行记录超过天数", traces_older_than_days: "过程记录超过天数",
    temp_older_than_days: "临时>天数", runs_keep_latest: "保留最近运行",
  };
  return m[k] ?? k.replace(/_/g, " ");
}

function fmtVal(k: string, v: unknown): string {
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") { if (k.includes("days") || k.includes("older_than")) return `${v}天`; return v.toLocaleString(); }
  return String(v);
}
