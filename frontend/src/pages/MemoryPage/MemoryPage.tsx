import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { memoryApi } from "../../api";
import { useSessionStore } from "../../stores/session";
import { Badge, EmptyState, LoadingState, StatusDot } from "../../components/common";
import { confirm } from "../../components/ConfirmDialog";
import { IconAlert, IconSearch, IconPlus, IconRefresh, IconClose, IconCheck, IconTrash, IconLayers, IconChevronDown, IconEdit, IconShield } from "../../components/Icon";
import { Button, FilterSelect, PageHeader, SearchInput, SelectionBar } from "../../components/ui";

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
    saveId.current = ""; setSearchQ(""); setActiveQuery(""); setToast(null);
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
    <section className="memory-editor" aria-labelledby="memory-editor-title">
      <header className="memory-editor-head">
        <h2 id="memory-editor-title">{editing ? "修改记忆" : "新建记忆"}</h2>
        <p>{editing ? `保存后启用新版本，并保留原记录供回查。范围：${scopeLabel(editing.scope)}。` : "手动创建的记忆由你确认，保存后立即生效。"}</p>
      </header>
      {!editing && (
        <div className="memory-form-options">
          <label className="memory-field"><span>生效范围</span><span className="memory-select-wrap"><select className="input" aria-label="生效范围" value={draftScope} onChange={event => setDraftScope(event.target.value)}>
            <option value="workspace">当前项目</option><option value="global">个人通用偏好</option>
          </select><IconChevronDown size={12} aria-hidden="true" /></span></label>
          <label className="memory-field"><span>记忆分类</span><span className="memory-select-wrap"><select className="input" aria-label="记忆分类" value={draftType} onChange={event => setDraftType(event.target.value)}>
            {["knowledge_note", "core_rule", "semantic_fact", "episodic_case", "procedural_rule"].map(value => <option key={value} value={value}>{memoryTypeLabel(value)}</option>)}
          </select><IconChevronDown size={12} aria-hidden="true" /></span></label>
        </div>
      )}
      <label className="memory-field"><span>标题</span><input className="input memory-form-input" aria-label="记忆标题" placeholder="一句话说明这条记忆" value={title} disabled={saving || unknownSave} autoFocus onChange={event => setTitle(event.target.value)} /></label>
      <label className="memory-field"><span>内容</span><textarea className="input memory-form-textarea" aria-label="记忆内容" placeholder="完整记忆内容" value={content} disabled={saving || unknownSave} onChange={event => setContent(event.target.value)} rows={6} /></label>
      <div className="memory-form-actions">
        <Button variant="primary" size="sm" onClick={() => void handleCreate()} disabled={!title.trim() || !content.trim() || saving || unknownSave}>保存</Button>
        {unknownSave && <Button size="sm" onClick={() => void reconcileSave()} disabled={saving}>核对保存结果</Button>}
        <Button size="sm" onClick={clearDraft} disabled={saving}>取消</Button>
        {saving && <span className="memory-form-status" role="status">正在保存…</span>}
      </div>
    </section>
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
  };

  const requestDelete = async (entry: MemEntry) => {
    if (!entry.memory_id) return;
    const accepted = await confirm({
      title: "永久删除这条记忆？",
      body: `「${entry.title || entry.summary || "未命名记忆"}」将被永久删除，此操作不可逆。`,
      confirmLabel: "永久删除",
      destructive: true,
    });
    if (accepted) await handleDeleteHard(entry.memory_id);
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
    const accepted = await confirm({
      title: `永久删除选中的 ${ids.length} 条记忆？`,
      body: "此操作不可逆，删除后无法从历史中找回。",
      confirmLabel: "永久删除",
      destructive: true,
    });
    if (!accepted || latestScope.current !== workspace) return;
    try {
      const res = await memoryApi.batchHardDelete(workspace, ids);
      if (latestScope.current !== workspace) return;
      showToast("ok", `已删除 ${res.deleted_count} 条`);
      setChecked(new Set());
      void load();
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

  const filtered = Boolean(activeQuery || typeFilter || scopeFilter || statusFilter);
  const someSelected = checked.size > 0 && !allSelected;

  return (
    <div className="page memory-page">
      <PageHeader title="长期记忆" subtitle="个人通用偏好随用户保存；项目资料、事实和经验保留在所属项目">
        <Button size="sm" iconOnly aria-label="刷新" title="刷新" onClick={() => void load()}><IconRefresh size={15} aria-hidden="true" /></Button>
        <Button variant="primary" size="sm" onClick={() => { clearDraft(); setShowCreate(true); }}>
          <IconPlus size={14} aria-hidden="true" />新建
        </Button>
      </PageHeader>

      <div className="page-body memory-body">
        <div className="memory-toolbar" role="search" aria-label="查找记忆">
          <div className="memory-search-controls">
            <SearchInput
              placeholder="搜索记忆标题或内容"
              aria-label="搜索记忆"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
              onClear={() => { setSearchQ(""); setActiveQuery(""); }}
            />
            <Button size="sm" onClick={handleSearch}><IconSearch size={14} aria-hidden="true" />搜索</Button>
          </div>
          <div className="memory-filter-controls">
            <FilterSelect label="分类" aria-label="筛选分类" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="">全部</option>
              <option value="core_rule">核心规则</option>
              <option value="semantic_fact">稳定事实</option>
              <option value="episodic_case">故障案例</option>
              <option value="procedural_rule">操作方法</option>
              <option value="knowledge_note">知识笔记</option>
              <option value="profile">用户档案</option>
            </FilterSelect>
            <FilterSelect label="范围" aria-label="筛选范围" value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}>
              <option value="">全部</option><option value="workspace">当前项目</option><option value="global">个人通用</option>
              <option value="session">会话范围</option><option value="task">任务记忆</option>
            </FilterSelect>
            <FilterSelect label="状态" aria-label="筛选状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="">全部</option><option value="active">已启用</option><option value="pending">待确认</option><option value="conflict">待解决冲突</option>
            </FilterSelect>
            <label className="memory-history-toggle"><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />显示历史</label>
          </div>
        </div>

        {createForm}

        {err && (
          <div className="callout err memory-error" role="alert">
            <IconAlert size={16} aria-hidden="true" />
            <span>{err}</span>
            <Button size="sm" onClick={() => void load()}>重新加载</Button>
          </div>
        )}

        <section className="memory-list" aria-label="记忆列表" aria-busy={loading}>
          <div className="memory-list-tools">
            {display.length > 0 && (
              <label className="select-all">
                <input type="checkbox" checked={allSelected} ref={element => { if (element) element.indeterminate = someSelected; }} onChange={toggleSelectAll} />
                全选 ({checked.size})
              </label>
            )}
            <span className="count">
              {searchRes ? `搜索结果 ${display.length} 条` : `已加载 ${display.length} / ${total} 条记忆`}
            </span>
            {searchRes && (
              <Button size="sm" variant="ghost" onClick={() => { setActiveQuery(""); setSearchQ(""); }}><IconClose size={12} aria-hidden="true" />清除结果</Button>
            )}
          </div>
          <SelectionBar count={checked.size} unit="条" note="永久删除，不可恢复" onClear={() => setChecked(new Set())}>
            <Button size="sm" variant="danger" onClick={() => void handleBatchDelete()}>
              <IconTrash size={13} aria-hidden="true" />删除 {checked.size} 条
            </Button>
          </SelectionBar>

          {loading && display.length === 0 && <div className="memory-loading"><LoadingState skeleton="list" /></div>}
          {!loading && display.length === 0 && <EmptyState
            icon={<IconLayers size={18} aria-hidden="true" />}
            text={filtered ? "没有匹配的记忆" : "暂无记忆"}
            hint={filtered ? "调整搜索词或筛选条件，或勾选“显示历史”查看已替换的版本。" : "可以手动创建。自动整理生成的规则与推断会在这里等待确认。"}
            action={filtered ? undefined : <Button size="sm" onClick={() => { clearDraft(); setShowCreate(true); }}><IconPlus size={14} aria-hidden="true" />新建记忆</Button>}
          />}
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
            const label = e.title || e.summary || e.content?.slice(0, 80) || "未命名记忆";
            const needsReview = e.status === "pending" || e.status === "conflict";

            // A row, not a card: the list is one bordered surface; each entry
            // is separated by a hairline so the page never turns into a card wall.
            return (
              <div key={e.memory_id || i} className={`memory-card${isChecked ? " checked" : ""}${isInactive ? " inactive" : ""}${needsReview ? " needs-review" : ""}${isSelected ? " expanded" : ""}`}>
                <div className="memory-card-row">
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
                        <strong>{label}</strong>
                        <IconChevronDown size={12} aria-hidden="true" className="memory-detail-caret" />
                      </button>
                      {/* Badges are kept for exceptions only: a state that needs
                          attention, a user-confirmed authority, a low score. */}
                      {e.status && e.status !== "active" && (
                        <Badge kind={isInactive ? "err" : "warn"}>{memoryStatusLabel(e.status)}</Badge>
                      )}
                      {authority === "explicit_user" && <Badge kind="ok">{memoryAuthorityLabel(authority)}</Badge>}
                      {score != null && Number.isFinite(score) && score < 4 && (
                        <Badge kind="warn">建议分 {score}</Badge>
                      )}
                    </div>
                    <div className="memory-card-meta">
                      {e.memory_type && <span className="memory-type-label">{memoryTypeLabel(e.memory_type)}</span>}
                      {e.scope && <span className="memory-scope-label">{scopeLabel(e.scope)}</span>}
                      {origin && <span>{memoryOriginLabel(origin)}</span>}
                      {authority === "manual_confirm" && <span className="memory-reviewed"><IconShield size={12} aria-hidden="true" />已审核</span>}
                      {e.updated_at && <span className="memory-updated" title={e.updated_at}>{memoryDateLabel(e.updated_at)}</span>}
                    </div>
                    {!isSelected && <div className="memory-card-preview">
                      {e.value_preview || e.content?.substring(0, 150) || "(无内容)"}
                    </div>}
                  </div>

                  {e.memory_id && <Button size="sm" variant="ghost" iconOnly className="memory-card-delete" title="永久删除"
                    aria-label={`永久删除：${label}`}
                    onClick={(ev) => { ev.stopPropagation(); void requestDelete(e); }}>
                    <IconTrash size={14} aria-hidden="true" />
                  </Button>}
                </div>

                {isSelected && (
                  <div className="memory-card-detail" id={`memory-detail-${e.memory_id || i}`}>
                    <div className="memory-detail-head"><span>完整记忆</span>
                      {e.memory_id && !isInactive && <Button size="sm" onClick={() => beginEdit(e)}><IconEdit size={14} aria-hidden="true" />修改记忆</Button>}
                    </div>
                    {e.content && <pre className="memory-body-text">{e.content}</pre>}
                    {e.superseded_by && <div className="memory-revision-note">已被新版本替换：{e.superseded_by}</div>}
                    {meta.supersedes_memory_id ? <div className="memory-revision-note">替换原记录：{String(meta.supersedes_memory_id)}</div> : null}
                    {needsReview && e.memory_id && (
                      <div className="memory-review">
                        <p>{e.status === "conflict" ? "这条建议与已启用的记忆冲突，确认后才会生效。" : "这条记忆由系统整理，确认后才会生效。"}</p>
                        <div className="actions">
                          <Button variant="primary" size="sm" onClick={() => void handleReview(e.memory_id!, "confirm")}>
                            <IconCheck size={12} aria-hidden="true" />{meta.proposed_action === "expire" ? "确认停用原记忆" : "确认并启用"}
                          </Button>
                          <Button size="sm" onClick={() => void handleReview(e.memory_id!, "reject")}>
                            <IconClose size={12} aria-hidden="true" />拒绝
                          </Button>
                        </div>
                      </div>
                    )}
                    {e.tags && e.tags.length > 0 && (
                      <div className="tags">
                        {e.tags.map((t: string) => <Badge key={t} kind="accent">{t}</Badge>)}
                      </div>
                    )}
                    <details className="memory-provenance"><summary>来源与记录</summary>
                      <dl className="memory-record-facts">
                        <dt>记录身份</dt><dd>{e.memory_id}</dd>
                        <dt>所属项目</dt><dd>{e.workspace_id || wsId}</dd>
                        {e.updated_at && <><dt>更新时间</dt><dd title={e.updated_at}>{memoryDateLabel(e.updated_at)}</dd></>}
                        {origin && <><dt>记忆来源</dt><dd>{memoryOriginLabel(origin)}</dd></>}
                        {authority && <><dt>审核依据</dt><dd>{memoryAuthorityLabel(authority)}</dd></>}
                        {reason && <><dt>记录原因</dt><dd>{memoryReasonLabel(reason)}</dd></>}
                        {evidenceSource && <><dt>证据来源</dt><dd>{evidenceSource}</dd></>}
                        {memoryKey && <><dt>记忆主题</dt><dd>{memoryKey}</dd></>}
                        {evidenceEventIds.length > 0 && <><dt>经历证据</dt><dd>{evidenceEventIds.length} 条</dd></>}
                        {mergedFrom.length > 0 && <><dt>合并来源</dt><dd>{mergedFrom.join(" + ")}</dd></>}
                        {score != null && Number.isFinite(score) && <><dt>建议分</dt><dd>{score}</dd></>}
                        {confidence != null && Number.isFinite(confidence) && !["user", "manual_confirm"].includes(e.source || "") && <><dt>模型自评</dt><dd>{Math.round(confidence * 100)}%</dd></>}
                      </dl>
                      {e.citations?.length ? <details><summary>查看来源与证据</summary><pre>{JSON.stringify(e.citations, null, 2)}</pre></details> : null}
                    </details>
                  </div>
                )}
              </div>
            );
          })}
        </section>
        {nextOffset !== null && <div className="memory-more"><Button size="sm" onClick={() => void load(nextOffset)} disabled={loading}>{loading ? "加载中…" : "加载更多"}</Button></div>}
      </div>

      {toast && (
        <div className={`toast-notification ${toast.kind}`} role={toast.kind === "err" ? "alert" : "status"}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function memoryOriginLabel(origin: string): string {
  const value = String(origin || "");
  const labels: Record<string, string> = { agent_suggestion: "智能体建议", memory_tool_update: "智能体修改建议", memory_tool_profile: "智能体档案建议", manual_confirm: "人工确认", operator_confirm: "显式工具审核", tool: "工具观察", file: "文件资料", subagent: "子智能体建议" };
  if (labels[value]) return labels[value];
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

function memoryDateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
