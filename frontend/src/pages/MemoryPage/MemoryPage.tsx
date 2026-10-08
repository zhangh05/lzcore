import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { memoryApi } from "../../api";
import { useSessionStore } from "../../stores/session";
import { Badge, StatusDot } from "../../components/common";
import { IconAlert, IconSearch, IconPlus, IconRefresh, IconClose, IconCheck, IconTrash, IconLayers, IconChevronDown } from "../../components/Icon";
import { PageHeader, FilterBar, SearchInput } from "../../components/ui";
import { EmptyState } from "../../components/common";

interface MemEntry {
  memory_id?: string;
  title?: string;
  summary?: string;
  content?: string;
  value_preview?: string;
  status?: string;
  scope?: string;
  source?: string;
  confidence?: number;
  memory_type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workspace_id?: string;
  updated_at?: string;
  superseded_by?: string;
  retrievable?: boolean;
  citations?: Record<string, unknown>[];
}

export function MemoryPage() {
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);
  const wsId = currentWorkspaceId;
  const [entries, setEntries] = useState<MemEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState<MemEntry[] | null>(null);
  const [activeQuery, setActiveQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [draftScope, setDraftScope] = useState("workspace");
  const [draftType, setDraftType] = useState("knowledge_note");
  const [editing, setEditing] = useState<MemEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [unknownSave, setUnknownSave] = useState(false);
  const saveId = useRef("");
  const latestScope = useRef(wsId);
  latestScope.current = wsId;
  const requestVersion = useRef(0);
  const [typeFilter, setTypeFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [sel, setSel] = useState<MemEntry | null>(null);
  const [err, setErr] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const load = useCallback(async (offset = 0) => {
    const version = ++requestVersion.current;
    if (!wsId) { setEntries([]); setLoading(false); return; }
    setLoading(true);
    setErr("");
    try {
      const options = { workspace_id: wsId, limit: 100, offset, scope: scopeFilter, memory_type: typeFilter, status: statusFilter };
      const data = activeQuery
        ? await memoryApi.search({ ...options, query: activeQuery, include_deleted: includeHistory })
        : await memoryApi.list({ ...options, include_deleted: includeHistory });
      if (version !== requestVersion.current || latestScope.current !== wsId) return;
      if (!data.ok) throw new Error("加载失败");
      const records = ("results" in data ? data.results : data.records) as MemEntry[];
      const update = (previous: MemEntry[]) => offset ? [...previous, ...(records || [])] : records || [];
      if (activeQuery) { setSearchRes(previous => update(previous || [])); setEntries([]); }
      else { setEntries(update); setSearchRes(null); }
      setTotal(data.total ?? records?.length ?? 0);
      setNextOffset(data.next_offset ?? null);
      if (data.load_errors?.length) setErr(`有 ${data.load_errors.length} 条记忆原记录暂时无法读取，以下仅显示已成功读取的内容。`);
    } catch (error: unknown) {
      if (version === requestVersion.current && latestScope.current === wsId) setErr(error instanceof Error ? error.message : "加载失败");
    } finally {
      if (version === requestVersion.current && latestScope.current === wsId) setLoading(false);
    }
  }, [wsId, activeQuery, scopeFilter, typeFilter, statusFilter, includeHistory]);

  useEffect(() => {
    setEntries([]); setSearchRes(null); setSel(null); setChecked(new Set());
    void load();
    return () => { requestVersion.current++; };
  }, [load]);
  useEffect(() => {
    setShowCreate(false); setEditing(null); setTitle(""); setContent(""); setUnknownSave(false); setSaving(false);
    saveId.current = ""; setSearchQ(""); setActiveQuery(""); setDeleteConfirm(null); setToast(null);
  }, [wsId]);

  const display = searchRes ?? entries;
  const handleSearch = () => setActiveQuery(searchQ.trim());
  const clearDraft = () => {
    setShowCreate(false); setEditing(null); setTitle(""); setContent(""); setUnknownSave(false);
    saveId.current = "";
  };
  const saved = () => { clearDraft(); void load(); showToast("ok", editing ? "已替换原记忆，旧版本保留在历史中" : "记忆已保存"); };
  const reconcileSave = async () => {
    const workspace = wsId;
    if (!saveId.current) return;
    setSaving(true);
    try {
      const result = await memoryApi.get(saveId.current, workspace);
      if (latestScope.current !== workspace) return;
      if (result.ok && result.record.content === content && result.record.summary === title && result.record.status === "active") saved();
      else setErr("保存结果尚未核对，请保留内容并刷新查看；不会自动重复写入。");
    } catch {
      if (latestScope.current === workspace) setErr("尚未查到可确认的原记录，请保留内容并刷新查看；不会自动重复写入。");
    } finally { if (latestScope.current === workspace) setSaving(false); }
  };
  const handleCreate = async () => {
    if (!title.trim() || !content.trim() || saving || unknownSave) return;
    const workspace = wsId;
    saveId.current ||= "mem-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    setSaving(true); setErr("");
    try {
      const result = await memoryApi.create({
        title, content, workspace_id: workspace, memory_id: saveId.current,
        scope: editing?.scope || draftScope,
        memory_type: (editing?.memory_type || draftType) as Parameters<typeof memoryApi.create>[0]["memory_type"],
        supersedes_memory_id: editing?.memory_id,
        memory_key: String(editing?.metadata?.memory_key || ""), user_confirmed: true,
      });
      if (latestScope.current !== workspace) return;
      if (!result.ok) { setErr("记忆未保存，请检查内容与所选范围。"); return; }
      saved();
    } catch (error: unknown) {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
      if (latestScope.current !== workspace) return;
      if (status >= 400 && status < 500 && status !== 409) {
        setErr('保存被拒绝，请检查内容或刷新核对原记忆版本。'); saveId.current = '';
      } else { setUnknownSave(true); await reconcileSave(); }
    } finally { if (latestScope.current === workspace) setSaving(false); }
  };
  const beginEdit = (entry: MemEntry) => {
    clearDraft(); setEditing(entry); setTitle(entry.summary || entry.title || "");
    setContent(entry.content || ""); setShowCreate(true);
  };
  const createForm = showCreate && (
    <div className="card card-highlight">
      <div className="card-title memory-form-title">{editing ? "修改记忆" : "新建记忆"}</div>
      {editing ? <p className="memory-explain-box">保存后启用新版本，并保留原记录供回查。范围：{scopeLabel(editing.scope)}。</p> : (
        <div className="memory-form-options">
          <label>生效范围<span className="memory-select-wrap"><select className="input memory-filter-select" aria-label="生效范围" value={draftScope} onChange={event => setDraftScope(event.target.value)}>
            <option value="workspace">当前项目</option><option value="global">个人通用偏好</option>
          </select><IconChevronDown size={12} aria-hidden="true" /></span></label>
          <label>记忆分类<span className="memory-select-wrap"><select className="input memory-filter-select" aria-label="记忆分类" value={draftType} onChange={event => setDraftType(event.target.value)}>
            {["knowledge_note", "core_rule", "semantic_fact", "episodic_case", "procedural_rule"].map(value => <option key={value} value={value}>{memoryTypeLabel(value)}</option>)}
          </select><IconChevronDown size={12} aria-hidden="true" /></span></label>
        </div>
      )}
      <input className="input memory-form-input" aria-label="记忆标题" placeholder="标题" value={title} disabled={saving || unknownSave} onChange={event => setTitle(event.target.value)} />
      <textarea className="input memory-form-textarea" aria-label="记忆内容" placeholder="完整记忆内容" value={content} disabled={saving || unknownSave} onChange={event => setContent(event.target.value)} rows={6} />
      <div className="memory-form-actions">
        <button className="btn primary sm" onClick={() => void handleCreate()} disabled={!title.trim() || !content.trim() || saving || unknownSave}>保存</button>
        {unknownSave && <button className="btn sm" onClick={() => void reconcileSave()} disabled={saving}>核对保存结果</button>}
        <button className="btn sm" onClick={clearDraft} disabled={saving}>取消</button>
      </div>
    </div>
  );

  const handleDeleteHard = async (memoryId: string) => {
    const workspace = wsId;
    try {
      await memoryApi.deleteHard(memoryId, workspace);
      if (latestScope.current !== workspace) return;
      void load();
      showToast("ok", "已永久删除");
    } catch (e: unknown) {
      if (latestScope.current === workspace) { showToast("err", "删除结果未确认，请刷新核对"); void load(); }
    }
    setDeleteConfirm(null);
  };

  const handleReview = async (memoryId: string, decision: "confirm" | "reject") => {
    const workspace = wsId;
    try {
      const result = decision === "confirm"
        ? await memoryApi.confirm({ memory_id: memoryId, workspace_id: wsId })
        : await memoryApi.reject({ memory_id: memoryId, workspace_id: wsId });
      if (latestScope.current !== workspace) return;
      if (!result.ok) throw new Error("review_failed");
      showToast("ok", decision === "confirm" ? (result.status === "expired" ? "已确认停用原记忆" : "记忆已确认并开始生效") : "记忆已拒绝");
      await load();
    } catch {
      if (latestScope.current === workspace) showToast("err", "操作结果未确认，请刷新核对");
    }
  };

  const handleBatchDelete = async () => {
    if (checked.size === 0) return;
    const workspace = wsId;
    const ids = Array.from(checked);
    if (!confirm(`永久删除选中的 ${ids.length} 条记忆？此操作不可逆。`)) return;
    try {
      const res = await memoryApi.batchHardDelete(workspace, ids);
      if (latestScope.current !== workspace) return;
      showToast("ok", `已删除 ${res.deleted_count} 条`);
      setChecked(new Set());
      load();
    } catch {
      if (latestScope.current === workspace) { showToast("err", "删除结果未确认，请刷新核对"); void load(); }
    }
  };

  const showToast = (kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2000);
  };

  const allVisibleIds = useMemo(() => display.map(e => e.memory_id ?? "__").filter(Boolean), [display]);
  const allSelected = checked.size > 0 && allVisibleIds.every(id => checked.has(id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setChecked(new Set());
    } else {
      setChecked(new Set(allVisibleIds));
    }
  };

  return (
    <div className="page memory-page">
      <PageHeader title="长期记忆" subtitle="个人通用偏好随用户保存；项目资料、事实和经验保留在所属项目">
        <button className="btn sm" onClick={() => { clearDraft(); setShowCreate(true); }}>
          <IconPlus size={14} /> 新建
        </button>
        <button className="btn sm ghost" onClick={() => void load()} title="刷新">
          <IconRefresh size={14} />
        </button>
      </PageHeader>

      <div className="page-body">
        {/* Search + filter bar */}
        <FilterBar className="memory-toolbar">
          <SearchInput
            placeholder="搜索记忆..."
            aria-label="搜索记忆"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            onClear={() => { setSearchQ(""); setActiveQuery(""); }}
          />
          <button className="btn sm" onClick={handleSearch}><IconSearch size={14} /> 搜索</button>
          <span className="memory-select-wrap"><select className="input memory-filter-select" aria-label="筛选分类" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="">全部分类</option>
            <option value="core_rule">核心规则</option>
            <option value="semantic_fact">稳定事实</option>
            <option value="episodic_case">故障案例</option>
            <option value="procedural_rule">操作方法</option>
            <option value="knowledge_note">知识笔记</option>
            <option value="profile">用户档案</option>
          </select><IconChevronDown size={12} aria-hidden="true" /></span>
          <span className="memory-select-wrap"><select className="input memory-filter-select" aria-label="筛选范围" value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
            <option value="">全部范围</option><option value="workspace">当前项目</option><option value="global">个人通用</option>
            <option value="session">会话范围</option><option value="task">任务记忆</option>
          </select><IconChevronDown size={12} aria-hidden="true" /></span>
          <span className="memory-select-wrap"><select className="input memory-filter-select" aria-label="筛选状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="">全部状态</option><option value="active">已启用</option><option value="pending">待确认</option><option value="conflict">待解决冲突</option>
          </select><IconChevronDown size={12} aria-hidden="true" /></span>
          <label><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} /> 显示历史</label>
          {searchRes && (
            <button className="btn sm ghost" onClick={() => { setActiveQuery(""); setSearchQ(""); }}>清除结果</button>
          )}
          <div className="spacer" />
          {display.length > 0 && (
            <label className="select-all">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              全选 ({checked.size})
            </label>
          )}
          {checked.size > 0 && (
            <button className="btn sm danger" onClick={handleBatchDelete}>
              <IconTrash size={12} /> 删除 {checked.size} 条
            </button>
          )}
          <span className="count">
            {searchRes ? `搜索结果 ${display.length} 条` : `已加载 ${display.length} / ${total} 条记忆`}
          </span>
        </FilterBar>

        {createForm}

        {err && (
          <div className="card memory-error-card">
            <div className="memory-error-row">
              <span className="memory-error-icon"><IconAlert size={16} aria-hidden="true" /></span>
              <span className="memory-error-text">{err}</span>
            </div>
          </div>
        )}

        {loading && (
          <div className="empty">
            <div className="empty-icon"><span className="spinner" /></div>
            <div className="empty-text">加载中…</div>
          </div>
        )}

        {!loading && (
          <div className="memory-list">
            {display.length === 0 && <EmptyState icon={<IconLayers size={18} />} text={activeQuery || typeFilter || scopeFilter || statusFilter ? "没有匹配的记忆" : "暂无记忆"} hint="可以手动创建。自动整理生成的规则与推断会在这里等待确认。" />}
            {display.map((e, i) => {
              const isSelected = sel?.memory_id === e.memory_id;
              const isChecked = checked.has(e.memory_id ?? "");
              const isInactive = e.status === "rejected" || e.status === "expired" || Boolean(e.superseded_by) || e.status === "active" && e.retrievable === false;
              const dotColor = isInactive ? "err" : e.status === "pending" || e.status === "conflict" ? "warn" : "ok";
              const meta = e.metadata || {};
              const origin = String(meta.generation_origin || meta.extraction_method || e.source || "");
              const reason = String(meta.extraction_reason || "");
              const score = meta.llm_score != null ? Number(meta.llm_score) : undefined;
              const confidence = e.confidence != null ? Number(e.confidence) : undefined;
              const evidenceSource = meta.evidence_source ? String(meta.evidence_source) : "";
              const authority = meta.authority ? String(meta.authority) : "";
              const memoryKey = meta.memory_key ? String(meta.memory_key) : "";
              const evidenceEventIds = Array.isArray(meta.evidence_event_ids)
                ? meta.evidence_event_ids.map((value) => String(value || "")).filter(Boolean)
                : [];
              const mergedFrom = Array.isArray(meta.merged_from)
                ? meta.merged_from.map((v) => String(v || "")).filter(Boolean)
                : [];

              // A row, not a card: the list is already one bordered surface, so
              // giving every entry its own border and radius nested two
              // containers and turned the page into a card wall.
              return (
                <div key={e.memory_id || i} className={`memory-card ${isChecked ? "checked" : ""} ${isInactive ? "inactive" : ""}`}>
                  <div className="memory-card-row">
                    {/* Checkbox */}
                    <input type="checkbox" checked={isChecked}
                      aria-label={`选择记忆：${e.title || e.summary || "未命名记忆"}`}
                      onChange={(ev) => {
                        const next = new Set(checked);
                        if (ev.target.checked) next.add(e.memory_id ?? "");
                        else next.delete(e.memory_id ?? "");
                        setChecked(next);
                      }}
                      onClick={(ev) => ev.stopPropagation()}
                      className="memory-checkbox" />

                    <div className="memory-card-content">
                      <div className="memory-card-title">
                        <StatusDot status={dotColor} />
                        <button type="button" className="memory-detail-toggle" aria-expanded={isSelected}
                          aria-controls={`memory-detail-${e.memory_id || i}`}
                          onClick={() => setSel(isSelected ? null : e)}>
                          <strong>{e.title || e.summary || e.content?.slice(0, 80) || "未命名记忆"}</strong>
                          <span aria-hidden="true">{isSelected ? "▾" : "▸"}</span>
                        </button>
                        {/* Badges are kept for exceptions only. Six of them on
                            every row made the page shout and left nothing to
                            stand out: a state that needs attention, a
                            user-confirmed authority, a low score. */}
                        {e.status && e.status !== "active" && (
                          <Badge kind={isInactive ? "err" : "warn"}>{memoryStatusLabel(e.status)}</Badge>
                        )}
                        {authority === "explicit_user" && <Badge kind="ok">{memoryAuthorityLabel(authority)}</Badge>}
                        {score != null && Number.isFinite(score) && score < 4 && (
                          <Badge kind="warn">建议分 {score}</Badge>
                        )}
                      </div>
                      {/* Where this memory came from and how far it can be
                          trusted, stated once in the product's metadata
                          language rather than as a row of pills. */}
                      <div className="memory-card-meta">
                        {e.memory_type && (
                          <span className="meta-fact"><span className="meta-label">类型</span><span className="meta">{memoryTypeLabel(e.memory_type)}</span></span>
                        )}
                        {origin && (
                          <span className="meta-fact"><span className="meta-label">来源</span><span className="meta">{memoryOriginLabel(origin)}</span></span>
                        )}
                        {e.scope && (
                          <span className="meta-fact"><span className="meta-label">范围</span><span className="meta">{scopeLabel(e.scope)}</span></span>
                        )}
                        {authority && (
                          <span className="meta-fact"><span className="meta-label">权威</span><span className="meta">{memoryAuthorityLabel(authority)}</span></span>
                        )}
                        {score != null && Number.isFinite(score) && score >= 4 && (
                          <span className="meta-fact"><span className="meta-label">建议分</span><span className="meta">{score}</span></span>
                        )}
                        {confidence != null && Number.isFinite(confidence) && !["user", "manual_confirm"].includes(e.source || "") && (
                          <span className="meta-fact"><span className="meta-label">模型自评</span><span className="meta">{Math.round(confidence * 100)}%</span></span>
                        )}
                      </div>
                      <div className="memory-card-preview">
                        {e.value_preview || e.content?.substring(0, 150) || "(无内容)"}
                      </div>
                    </div>

                    <button className="btn sm ghost memory-card-delete" title="永久删除"
                      onClick={(ev) => { ev.stopPropagation(); setDeleteConfirm(e.memory_id || null); }}>
                      <IconTrash size={13} />
                    </button>
                  </div>

                  {deleteConfirm === e.memory_id && (
                    <div className="memory-delete-confirm">
                      <span>永久删除这条记忆？此操作不可逆。</span>
                      <button className="btn sm danger-confirm" onClick={() => handleDeleteHard(e.memory_id!)}>
                        <IconCheck size={11} /> 确认
                      </button>
                      <button className="btn sm ghost" onClick={(ev) => { ev.stopPropagation(); setDeleteConfirm(null); }}>
                        <IconClose size={11} /> 取消
                      </button>
                    </div>
                  )}

                  {isSelected && (
                    <div className="memory-card-detail" id={`memory-detail-${e.memory_id || i}`}>
                      <div className="memory-explain-box">
                        <div>记录：{e.memory_id}</div><div>所属项目：{e.workspace_id || wsId}</div>
                        {e.updated_at && <div>更新时间：{e.updated_at}</div>}
                        {e.superseded_by && <div>已被新版本替换：{e.superseded_by}</div>}
                        {meta.supersedes_memory_id ? <div>替换原记录：{String(meta.supersedes_memory_id)}</div> : null}
                        {e.citations?.length ? <details><summary>查看来源与证据</summary><pre>{JSON.stringify(e.citations, null, 2)}</pre></details> : null}
                      </div>
                      {e.memory_id && !isInactive && <button className="btn sm" onClick={() => beginEdit(e)}>修改记忆</button>}
                      {e.content && (
                        <pre>{e.content}</pre>
                      )}
                      {(reason || evidenceSource || authority || memoryKey || evidenceEventIds.length > 0 || mergedFrom.length > 0) && (
                        <div className="memory-explain-box">
                          {reason && <div>为什么记：{memoryReasonLabel(reason)}</div>}
                          {authority && <div>权威来源：{memoryAuthorityLabel(authority)}</div>}
                          {evidenceSource && <div>证据来源：{evidenceSource}</div>}
                          {memoryKey && <div>记忆主题：{memoryKey}</div>}
                          {evidenceEventIds.length > 0 && <div>经历证据：{evidenceEventIds.length} 条</div>}
                          {mergedFrom.length > 0 && (
                            <div>合并来源：{mergedFrom.join(" + ")}</div>
                          )}
                        </div>
                      )}
                      {e.tags && e.tags.length > 0 && (
                        <div className="tags">
                          {e.tags.map((t: string) => <Badge key={t} kind="accent">{t}</Badge>)}
                        </div>
                      )}
                      {(e.status === "pending" || e.status === "conflict") && e.memory_id && (
                        <div className="actions">
                          <button className="btn sm" onClick={() => void handleReview(e.memory_id!, "confirm")}>
                            <IconCheck size={12} /> {meta.proposed_action === "expire" ? "确认停用原记忆" : "确认并启用"}
                          </button>
                          <button className="btn sm" onClick={() => void handleReview(e.memory_id!, "reject")}>
                            <IconClose size={12} /> 拒绝
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {nextOffset !== null && <button className="btn sm" onClick={() => void load(nextOffset)} disabled={loading}>加载更多</button>}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`toast-notification ${toast.kind}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function memoryOriginLabel(origin: string): string {
  const value = String(origin || "");
  if (value.includes("task_reflection") || value.includes("memory_consolidator")) return "任务反思";
  if (value.includes("user")) return "用户明确设置";
  if (value.includes("llm")) return "智能体总结";
  return value;
}

function memoryStatusLabel(status: string): string {
  return ({ active: "已启用", pending: "待确认", conflict: "待解决冲突", expired: "已停用", rejected: "已拒绝" } as Record<string, string>)[status] || status;
}

function memoryTypeLabel(memoryType: string): string {
  const map: Record<string, string> = {
    core_rule: "核心规则",
    semantic_fact: "稳定事实",
    episodic_case: "故障案例",
    procedural_rule: "操作方法",
    knowledge_note: "知识笔记",
    profile: "用户档案",
  };
  return map[memoryType] || memoryType;
}

function memoryAuthorityLabel(authority: string): string {
  const map: Record<string, string> = {
    explicit_user: "用户明确规则",
    manual_confirm: "人工确认",
    operator_confirm: "显式工具审核",
    verified_tool: "历史工具原文",
    agent_inference: "智能体推断",
  };
  return map[authority] || authority;
}

function memoryReasonLabel(reason: string): string {
  const map: Record<string, string> = {
    explicit_user_memory_command: "用户明确要求长期记住",
    explicit_user_forget_command: "用户明确要求忘记",
  };
  return map[reason] || reason;
}

function scopeLabel(scope?: string): string {
  return ({ global: "个人通用", workspace: "当前项目", session: "会话", task: "任务" } as Record<string, string>)[scope || ""] || scope || "未指定";
}
