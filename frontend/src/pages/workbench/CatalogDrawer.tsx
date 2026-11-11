import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { useApi, listOf } from "../../kit/useApi";
import { Chip, Drawer, FailureNote, LoadState, RawData } from "../../kit/ui";

interface Tool {
  tool_id: string; display_name?: string; name?: string; short_label?: string; description?: string; usage_hint?: string; not_for?: string;
  category?: string; group?: string; action?: string; risk_level?: string; permission_action?: string; enabled?: boolean;
  governance_status?: string; governance_reason?: string; callable_by_llm?: boolean; planner_visible?: boolean; canonical_tool_id?: string;
}
interface Category { id: string; name?: string; description?: string; count?: number; groups?: { id: string; name?: string; tools?: Tool[] }[] }

const RISK_ZH: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "极高风险" };
const PERM_ZH: Record<string, string> = { read: "只读", write: "会写入", execute: "会执行", admin: "管理" };
const GOV_ZH: Record<string, string> = { active: "启用", disabled: "停用", forbidden: "禁止", internal: "内部" };
/** 目录分类名形如 "Agent 多 Agent"：去掉英文前缀，只留中文名。 */
export const categoryName = (c: Category) => (c.name ?? c.id).replace(/^[A-Za-z]+\s+/, "") || c.id;

export function matchesTool(t: Tool, q: string): boolean {
  if (!q) return true;
  const hay = [t.tool_id, t.display_name, t.name, t.short_label, t.description, t.usage_hint, t.group, t.category].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** 能力 / 工具目录（挂在工作台「更多」菜单）：按后端 categories 分类、可搜索；完整工具合同逐条可展开。dry-run 只演示，不执行。 */
export function CatalogDrawer({ ws, onClose }: { ws: string; onClose: () => void }) {
  const [catalog, reload] = useApi("/api/tools/catalog", { workspace_id: ws });
  const [dry, setDry] = useState<{ tool: string; o: HttpOutcome } | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const categories = useMemo<Category[]>(() => (catalog.state === "ok" ? ((catalog.data as { categories?: Category[] }).categories ?? []) : []), [catalog]);
  const allTools = useMemo<Tool[]>(() => {
    if (catalog.state !== "ok") return [];
    const flat = listOf<Tool>(catalog, "tools");
    return flat.length ? flat : categories.flatMap((c) => (c.groups ?? []).flatMap((g) => g.tools ?? []));
  }, [catalog, categories]);
  const visible = allTools.filter((t) => (cat === "all" || t.category === cat) && matchesTool(t, q.trim()));
  const sections = (categories.length ? categories : [{ id: "all", name: "全部" } as Category])
    .map((c) => ({ c, tools: visible.filter((t) => categories.length ? t.category === c.id : true) }))
    .filter((s) => s.tools.length);
  return (
    <Drawer title="能力与工具目录" onClose={onClose} testId="catalog-drawer">
      <p className="inline-alert tone-info">「演示调用」走 <code>/api/tools/dry-run</code>：只展示将如何调用，不会执行。</p>
      <LoadState value={catalog} onReload={reload}>{() => (
        <>
          <div className="catalog-toolbar">
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索能力名称、工具 id 或说明" aria-label="搜索能力" data-testid="catalog-search" />
            <div className="chip-filter" role="group" aria-label="能力分类">
              <button type="button" className={`filter-chip${cat === "all" ? " is-active" : ""}`} aria-pressed={cat === "all"} onClick={() => setCat("all")}>全部 {allTools.length}</button>
              {categories.map((c) => (
                <button key={c.id} type="button" className={`filter-chip${cat === c.id ? " is-active" : ""}`} aria-pressed={cat === c.id} onClick={() => setCat(c.id)} title={c.description} data-testid={`catalog-cat-${c.id}`}>
                  {categoryName(c)} {c.count ?? allTools.filter((t) => t.category === c.id).length}
                </button>
              ))}
            </div>
            <p className="muted" data-testid="catalog-count">显示 {visible.length} / {allTools.length} 项</p>
          </div>
          {sections.length ? sections.map(({ c, tools }) => (
            <section key={c.id} className="catalog-section" data-testid={`catalog-section-${c.id}`}>
              <h3>{categoryName(c)} <span className="muted">{c.description}</span></h3>
              <ul className="tool-catalog">
                {tools.map((t) => (
                  <li key={t.tool_id} className="tool-card" data-testid="catalog-tool">
                    <div className="tool-head">
                      <strong>{t.display_name ?? t.name ?? t.tool_id}</strong>
                      <code>{t.tool_id}</code>
                      {t.risk_level ? <Chip tone={t.risk_level === "high" || t.risk_level === "critical" ? "danger" : t.risk_level === "medium" ? "warn" : "ok"}>{RISK_ZH[t.risk_level] ?? t.risk_level}</Chip> : null}
                      {t.permission_action ? <Chip>{PERM_ZH[t.permission_action] ?? t.permission_action}</Chip> : null}
                      {t.enabled === false || (t.governance_status && t.governance_status !== "active") ? <Chip tone="warn">{GOV_ZH[t.governance_status ?? ""] ?? t.governance_status ?? "停用"}</Chip> : null}
                    </div>
                    <details className="tool-contract" data-testid="catalog-contract">
                      <summary>完整工具合同</summary>
                      <dl className="kv">
                        <div className="kv-row"><dt>说明</dt><dd>{t.description || "—"}</dd></div>
                        {t.usage_hint ? <div className="kv-row"><dt>使用提示</dt><dd>{t.usage_hint}</dd></div> : null}
                        {t.not_for ? <div className="kv-row"><dt>不适用</dt><dd>{t.not_for}</dd></div> : null}
                        <div className="kv-row"><dt>分组 / 动作</dt><dd>{t.group ?? "—"} / {t.action ?? "—"}</dd></div>
                        <div className="kv-row"><dt>模型可调用</dt><dd>{t.callable_by_llm ? "是" : "否"}{t.planner_visible === false ? " · 规划不可见" : ""}</dd></div>
                        {t.governance_reason ? <div className="kv-row"><dt>治理说明</dt><dd>{t.governance_reason}</dd></div> : null}
                      </dl>
                      <RawData value={t} label="合同原文" />
                    </details>
                    <Button className="sm" onClick={async () => setDry({ tool: t.tool_id, o: await api.post("/api/tools/dry-run", { workspace_id: ws, tool_id: t.tool_id, arguments: {} }) })} data-testid={`dry-run-${t.tool_id}`}>演示调用（不执行）</Button>
                    {dry?.tool === t.tool_id ? (dry.o.kind === "http" && dry.o.status < 300 ? <div data-testid="dry-run-result"><p className="muted">仅演示结果（未执行）。</p><RawData value={dry.o.body} label="演示响应原文" /></div> : <FailureNote outcome={dry.o} />) : null}
                  </li>
                ))}
              </ul>
            </section>
          )) : <p className="muted" data-testid="catalog-empty">没有匹配「{q}」的能力。</p>}
        </>
      )}</LoadState>
    </Drawer>
  );
}
