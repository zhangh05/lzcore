import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { useSearchParams } from "../../router";
import { FileWorkspace } from "./FileWorkspace";
import { apiRequest } from "../../api/client";
import {
  archiveApi,
  artifactsApi,
  retentionApi,
  storageApi,
  type ArtifactGovernanceSummary,
  type LifecyclePreview,
} from "../../api";
import { Badge, CodeBlock, EmptyState, LoadingState } from "../../components/common";
import { confirm } from "../../components/ConfirmDialog";
import { Button, DetailPanel, FilterBar, PageHeader, SearchInput, TabButton } from "../../components/ui";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import type { ArchivedDataItem, Artifact, DataOverview, ManagedFile } from "../../types";
import { isApiError } from "../../types";
import { formatFileSize, formatDate } from "../../utils/format";
import { shortId } from "../../utils/displayText";
import { IconArchive, IconDocument, IconGauge, IconLayers, IconLink, IconPlus } from "../../components/Icon";

type DataTab = "overview" | "files" | "artifacts" | "relations" | "lifecycle";
type ArtifactView = "" | "current" | "history" | "deliverables";

// 每个 tab 配一个图标：跟顶栏分组同一套 duotone 语言，激活时图标也一起加深，
// 让"当前在哪一页"在扫视时就能分辨，而不是只能读文字。
const TAB_LABELS: Array<[DataTab, string, ComponentType<IconProps>]> = [
  ["overview", "概览", IconGauge],
  ["files", "文件", IconDocument],
  ["artifacts", "任务产出", IconLayers],
  ["relations", "数据关联", IconLink],
  ["lifecycle", "归档与清理", IconArchive],
];

const TYPE_LABELS: Record<string, string> = {
  user_upload: "上传文件",
  chat_attachment: "会话附件",
  document_input: "文档",
  data_input: "数据",
  knowledge_normalized: "知识文档",
  artifact_output: "任务产出",
  report: "报告",
  message_large_content: "大消息",
};

const SOURCE_LABELS: Record<string, string> = {
  artifact_upload: "用户上传",
  knowledge_import: "知识库",
  agent: "智能体",
  module_output: "模块产出",
};

export function DataCenter() {
  const workspaceId = useSessionStore((state) => state.currentWorkspaceId);
  const toast = useToastStore((state) => state.show);
  const [searchParams, setSearchParams] = useSearchParams();
  const producerId = searchParams.get("producer_id") || "";
  const artifactFocus = searchParams.get('artifact_id') || '';
  const [tab, setTab] = useState<DataTab>(producerId ? "artifacts" : "overview");
  const [overview, setOverview] = useState<DataOverview | null>(null);
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [governance, setGovernance] = useState<ArtifactGovernanceSummary | null>(null);
  const [retention, setRetention] = useState<LifecyclePreview | null>(null);
  const [archive, setArchive] = useState<LifecyclePreview | null>(null);
  const [archivedItems, setArchivedItems] = useState<ArchivedDataItem[]>([]);
  useEffect(() => { setFileFocus(null); }, [workspaceId]);
  const [artifactView, setArtifactView] = useState<ArtifactView>("");
  const [fileFocus, setFileFocus] = useState<ManagedFile | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentNote, setContentNote] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const contentAbort = useRef<AbortController | null>(null);

  // 把"待处理"集中到一个数：到期待清理 + 待归档 + 已软删。这三个都表示
  // "工作区有需要处理的堆积"，跨 tab 共享 stat 条上自动染色。
  const retentionCount = sumCounts(retention?.candidate_counts);
  const archiveCount = sumCounts(archive?.candidate_counts);
  const pendingTotal = retentionCount + archiveCount + (overview?.files.soft_deleted ?? 0);

  // tab 上的计数徽章：让用户切之前就知道每个 tab 有多少东西。
  // "概览"不计数（它本身就是汇总），"数据关联"用已被引用的文件数。
  const tabCounts: Partial<Record<DataTab, number>> = {
    files: overview?.files.active ?? 0,
    artifacts: artifacts.length,
    relations: overview?.files.referenced ?? 0,
    lifecycle: pendingTotal,
  };

  const loadData = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const results = await Promise.allSettled([
      storageApi.overview(workspaceId, signal),
      storageApi.files(workspaceId, "active", signal),
      retentionApi.preview(workspaceId, signal),
      archiveApi.preview(workspaceId, signal),
      archiveApi.items(workspaceId, signal),
    ]);
    if (signal?.aborted) return;
    const [overviewResult, filesResult, retentionResult, archiveResult, archivedResult] = results;
    if (overviewResult.status === "fulfilled") setOverview(overviewResult.value.overview);
    if (filesResult.status === "fulfilled") setFiles(filesResult.value.files || []);
    if (retentionResult.status === "fulfilled") setRetention(retentionResult.value);
    if (archiveResult.status === "fulfilled") setArchive(archiveResult.value);
    if (archivedResult.status === "fulfilled") setArchivedItems(archivedResult.value.items || []);
    const failures = results.filter((item) => item.status === "rejected") as PromiseRejectedResult[];
    if (failures.length) setError(isApiError(failures[0].reason) ? failures[0].reason.message : String(failures[0].reason));
    setLoading(false);
  }, [workspaceId]);

  const loadArtifacts = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceId) return;
    try {
      const response = await artifactsApi.list(workspaceId, signal, artifactView, producerId);
      if (!signal?.aborted) {
        setArtifacts(response.artifacts || []);
        setGovernance(response.governance || null);
      }
    } catch (reason) {
      if (!signal?.aborted) setError(isApiError(reason) ? reason.message : String(reason));
    }
  }, [workspaceId, artifactView, producerId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  useEffect(() => {
    const controller = new AbortController();
    void loadArtifacts(controller.signal);
    return () => controller.abort();
  }, [loadArtifacts]);

  useEffect(() => {
    if (producerId) setTab("artifacts");
  }, [producerId]);

  useEffect(() => () => contentAbort.current?.abort(), []);

  useEffect(() => {
    if (!workspaceId || typeof fetch === "undefined") return;
    const stream = storageApi.events(workspaceId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void loadData();
        void loadArtifacts();
      }, 120);
    };
    stream.addEventListener("storage_changed", refresh);
    return () => {
      if (timer) clearTimeout(timer);
      stream.removeEventListener("storage_changed", refresh);
      stream.close();
    };
  }, [workspaceId, loadData, loadArtifacts]);

  const filteredFiles = useMemo(() => files.filter(file => !search ||
    [file.original_name, file.file_id, file.source, file.run_id].some(value => String(value || '').toLowerCase().includes(search.toLowerCase()))), [files, search]);

  const selectArtifact = async (artifact: Artifact) => {
    setSelectedArtifact(artifact);
    setContent("");
    setContentNote("正在读取内容…");
    contentAbort.current?.abort();
    if (!workspaceId) return;
    const controller = new AbortController();
    contentAbort.current = controller;
    try {
      if (artifact.file_id) {
        const file = await storageApi.metadata(workspaceId, artifact.file_id, controller.signal);
        if (file.file.binary) {
          if (!controller.signal.aborted) setContentNote('二进制原件可下载，文件空间提供结构或页面预览。');
          return;
        }
      }
      const result = await artifactsApi.content(workspaceId, artifact.artifact_id, controller.signal);
      if (!controller.signal.aborted) {
        setContent(result.content || "");
        setContentNote("");
      }
    } catch (reason) {
      if (!controller.signal.aborted) setContentNote(isApiError(reason) ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (!workspaceId || !artifactFocus) return;
    const controller = new AbortController();
    setTab('artifacts');
    artifactsApi.get(workspaceId, artifactFocus, controller.signal)
      .then(result => { if (!controller.signal.aborted) void selectArtifact(result.artifact); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  // selectArtifact consumes the current authenticated workspace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, artifactFocus]);

  const upload = async (file: File) => {
    if (!workspaceId) return;
    setBusy(true);
    const form = new FormData();
    form.append("workspace_id", workspaceId);
    form.append("file", file);
    form.append("artifact_type", "user_upload");
    form.append("title", file.name);
    try {
      await apiRequest({ method: "POST", url: `/workspaces/${workspaceId}/artifacts/upload`, data: form });
      toast({ kind: "success", title: "文件已导入", body: `${file.name} 已进入数据管理` });
      await Promise.all([loadData(), loadArtifacts()]);
      setTab("files");
    } catch (reason) {
      toast({ kind: "error", title: "导入失败", body: isApiError(reason) ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  };

  const deleteArtifact = async (artifact: Artifact) => {
    if (!workspaceId) return;
    const accepted = await confirm({
      title: "删除任务产出？",
      body: `将删除「${artifact.title || artifact.artifact_id}」及其关联文件。此操作无法恢复。`,
      confirmLabel: "确认删除",
      destructive: true,
    });
    if (!accepted) return;
    try {
      await artifactsApi.batchDelete(workspaceId, [artifact.artifact_id]);
      setSelectedArtifact(null);
      await Promise.all([loadData(), loadArtifacts()]);
      toast({ kind: "success", title: "任务产出已删除" });
    } catch (reason) {
      toast({ kind: "error", title: "删除失败", body: isApiError(reason) ? reason.message : String(reason) });
    }
  };

  const applyLifecycle = async (kind: "retention" | "archive") => {
    if (!workspaceId) return;
    const preview = kind === "retention" ? retention : archive;
    const count = sumCounts(preview?.candidate_counts);
    if (!count) return;
    const accepted = await confirm({
      title: kind === "retention" ? "清理到期数据？" : "归档历史数据？",
      body: kind === "retention"
        ? `将永久清理 ${count} 项已到期数据。系统会保护仍被会话和任务产出引用的内容。`
        : `将把 ${count} 项历史数据移入归档区，之后可在本页恢复。`,
      confirmLabel: kind === "retention" ? "确认清理" : "确认归档",
      destructive: kind === "retention",
    });
    if (!accepted) return;
    setBusy(true);
    try {
      if (kind === "retention") await retentionApi.apply(workspaceId);
      else await archiveApi.apply(workspaceId);
      await loadData();
      toast({ kind: "success", title: kind === "retention" ? "清理完成" : "归档完成" });
    } catch (reason) {
      toast({ kind: "error", title: "执行失败", body: isApiError(reason) ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  };

  const restoreArchived = async (item: ArchivedDataItem) => {
    if (!workspaceId) return;
    try {
      await archiveApi.restore(workspaceId, item);
      await loadData();
      toast({ kind: "success", title: "已恢复", body: item.name });
    } catch (reason) {
      toast({ kind: "error", title: "恢复失败", body: isApiError(reason) ? reason.message : String(reason) });
    }
  };

  return (
    <div className="page data-center" data-testid="page-data-center">
      <PageHeader title="数据管理" subtitle="管理文件、任务产出、数据关联、归档和清理">
        <input ref={uploadRef} type="file" className="file-upload-input" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        <Button variant={tab === "lifecycle" ? "default" : "primary"} size="sm" disabled={busy} onClick={() => uploadRef.current?.click()}>
          {busy ? "处理中…" : "导入数据"}
        </Button>
        <Button size="sm" onClick={() => { void loadData(); void loadArtifacts(); }}>刷新</Button>
      </PageHeader>

      <FilterBar className="data-center-tabs" role="tablist">
        {TAB_LABELS.map(([key, label, TabIcon]) => (
          <TabButton
            key={key}
            className="dc-tab"
            testId={`data-tab-${key}`}
            icon={TabIcon}
            label={label}
            count={tabCounts[key]}
            active={tab === key}
            onClick={() => { setTab(key); setFileFocus(null); setSelectedArtifact(null); }}
          />
        ))}
        <div className="spacer" />
        {overview && <Badge kind={overview.health.ok ? "ok" : "err"}>{overview.health.ok ? "文件存在性检查通过" : "发现数据问题"}</Badge>}
      </FilterBar>

      {/* 跨 tab 概览：把 overview 的关键数字 + 待处理数集中成 5 格 stat strip。
          "待处理"非 0 时自动上底色（warn），跟知识库的 counts 一致的语言。 */}
      <div className="stat-grid kl-stats" data-testid="data-stats">
        <div className="stat-card">
          <div className="stat-value">{overview?.files.active ?? "—"}</div>
          <div className="stat-label">活跃文件</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{overview?.artifacts.active ?? "—"}</div>
          <div className="stat-label">任务产出</div>
        </div>
        <div className="stat-card">
          <div className="stat-value stat-value-ok">{overview?.files.referenced ?? "—"}</div>
          <div className="stat-label">已有引用</div>
        </div>
        <div className={"stat-card" + (pendingTotal ? " kl-stat--warn" : "")}>
          <div className="stat-value">{pendingTotal}</div>
          <div className="stat-label">待处理</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {overview ? formatFileSize(overview.files.size_bytes) : "—"}
          </div>
          <div className="stat-label">总存储</div>
        </div>
      </div>

      {error && <div className="callout error">{error}</div>}
      {loading && !overview ? <LoadingState text="正在读取数据…" skeleton="table" /> : null}

      {tab === "overview" && <Overview
        overview={overview}
        files={files}
        onImport={() => uploadRef.current?.click()}
        onOpenFiles={() => setTab("files")}
        onOpenLifecycle={() => setTab("lifecycle")}
      />}
      {tab === "files" && workspaceId && <FileWorkspace key={workspaceId} workspaceId={workspaceId} initialFile={fileFocus} />}
      {tab === "artifacts" && (
        <ArtifactsView
          artifacts={artifacts} governance={governance} view={artifactView} onView={setArtifactView}
          producerId={producerId} onClearProducer={() => {
            setSearchParams({}, { replace: true });
          }}
          selected={selectedArtifact} onSelect={(artifact) => void selectArtifact(artifact)}
          detail={<ArtifactDetail artifact={selectedArtifact} content={content} note={contentNote} onDelete={deleteArtifact} workspaceId={workspaceId || ''} onOpenFile={async fid => {
            if (!workspaceId) return;
            try { const result = await storageApi.metadata(workspaceId, fid); setFileFocus(result.file); setTab('files'); }
            catch (reason) { setError(String((reason as Error).message || reason)); }
          }} />}
        />
      )}
      {tab === "relations" && <RelationsView files={filteredFiles} search={search} onSearch={setSearch} onSelect={(file) => { setTab("files"); setFileFocus(file); }} />}
      {tab === "lifecycle" && (
        <LifecycleView retention={retention} archive={archive} archivedItems={archivedItems} busy={busy} onApply={applyLifecycle} onRestore={restoreArchived} />
      )}
    </div>
  );
}

function Overview({ overview, files, onImport, onOpenFiles, onOpenLifecycle }: {
  overview: DataOverview | null;
  files: ManagedFile[];
  onImport: () => void;
  onOpenFiles: () => void;
  onOpenLifecycle: () => void;
}) {
  if (!overview) return <EmptyState text="暂无数据概览" />;
  const healthSummary = `断链 ${overview.health.missing_on_disk} · 未登记路径 ${overview.health.orphan_files}`;
  const typeEntries = Object.entries(overview.types).sort((a, b) => b[1] - a[1]);
  return <div className="data-overview">
    <section className="data-summary-panel" aria-label="数据摘要">
      <div className="data-summary-head">
        <div className="data-summary-title">
          <h2>工作区数据</h2>
          <span>{formatFileSize(overview.files.size_bytes)} 总存储</span>
        </div>
        <div className={`data-health-inline ${overview.health.ok ? "ok" : "err"}`}>
          <span className="data-health-dot" />
          <strong>{overview.health.ok ? "文件存在性检查通过" : "发现数据问题"}</strong>
          <small>{healthSummary}</small>
        </div>
      </div>
      <div className="data-metric-row">
        <Stat label="活跃文件" value={overview.files.active} hint="当前可用" />
        <Stat label="任务产出" value={overview.artifacts.active} hint="分析和报告" />
        <Stat label="已有引用" value={overview.files.referenced} hint="关系保护" />
        <Stat label="独立文件" value={overview.files.unreferenced} hint="可直接管理" />
        <Stat label="已归档" value={overview.files.archived} hint="可恢复" />
      </div>
    </section>

    <div className="data-overview-layout">
      <section className="data-main-panel">
        <div className="data-panel-head">
          <div><h3>最近数据</h3><p>最近进入当前工作区的文件与任务产出。</p></div>
          {files.length > 0 && <Button size="sm" onClick={onOpenFiles}>查看全部</Button>}
        </div>
        {files.length > 0 ? <div className="data-recent-list">
          {files.slice(0, 8).map((file) => <div className="data-recent-row" key={file.file_id}>
            <span><b>{file.original_name || file.file_id}</b><small>{typeLabel(file.logical_type)} · {sourceLabel(file.source)}</small></span>
            <span><b>{formatFileSize(file.size_bytes)}</b><small>{formatDate(file.created_at, "short")}</small></span>
          </div>)}
        </div> : <EmptyState
          variant="onboarding"
          icon={<IconPlus size={18} aria-hidden="true" />}
          text="还没有数据"
          hint="导入文件，或运行一次会生成结果文件的任务。"
          action={<Button size="sm" onClick={onImport}>导入第一份数据</Button>}
        />}
      </section>

      <aside className="data-governance-panel" aria-label="数据治理">
        <section className="data-governance-section">
          <div className="data-panel-head"><div><h3>数据构成</h3><p>按类型汇总</p></div><span className="metric-chip">{overview.files.active} 项</span></div>
          {typeEntries.length ? typeEntries.map(([type, count]) => (
            <div className="data-breakdown-row" key={type}><span>{typeLabel(type)}</span><b>{count}</b></div>
          )) : <p className="data-compact-empty">导入数据后将在这里显示类型分布。</p>}
        </section>
        <section className="data-governance-section">
          <div className="data-panel-head"><div><h3>归档与清理</h3><p>处理历史和到期数据</p></div></div>
          <div className="data-breakdown-row"><span>待处理软删除</span><b>{overview.files.soft_deleted}</b></div>
          <div className="data-breakdown-row"><span>已归档文件</span><b>{overview.files.archived}</b></div>
          <Button size="sm" onClick={onOpenLifecycle}>打开归档与清理</Button>
        </section>
      </aside>
    </div>
  </div>;
}

function Stat({ label, value, hint, tone = "" }: { label: string; value: string | number; hint: string; tone?: string }) {
  return <div className={`data-stat ${tone}`}><span className="data-stat-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function ArtifactsView({ artifacts, governance, view, onView, producerId, onClearProducer, selected, onSelect, detail }: {
  artifacts: Artifact[]; governance: ArtifactGovernanceSummary | null; view: ArtifactView; onView: (view: ArtifactView) => void;
  producerId: string; onClearProducer: () => void; selected: Artifact | null; onSelect: (artifact: Artifact) => void; detail: ReactNode;
}) {
  return <>
    <FilterBar>
      {([ ["", "全部"], ["current", "当前有效"], ["history", "历史或不完整"], ["deliverables", "交付结果"] ] as Array<[ArtifactView, string]>).map(([key, label]) => (
        <Button key={key || "all"} size="sm" variant={view === key ? "selected" : "default"} aria-pressed={view === key} onClick={() => onView(key)}>{label}</Button>
      ))}
      {producerId && <span className="metric-chip">任务 {shortId(producerId)} <button type="button" className="link-button" onClick={onClearProducer}>清除</button></span>}
      <div className="spacer" />
      {governance && <><Badge kind="ok">过程结果 {governance.evidence_streams || 0}</Badge><Badge kind="muted">交付结果 {governance.deliverables || 0}</Badge></>}
    </FilterBar>
    {!artifacts.length ? (
      <div className="data-empty-container">
        <EmptyState
          text={view || producerId ? "没有符合条件的任务产出" : "暂无任务产出"}
          hint={view || producerId ? "尝试切换筛选条件或清除任务筛选" : "分析、报告或智能体任务生成的结果会显示在这里"}
        />
      </div>
    ) : (
      <div className="split-shell data-split">
        <aside className="data-list" aria-label="任务产出列表">
          {artifacts.map((artifact) => <button key={artifact.artifact_id} type="button" className={`data-row ${selected?.artifact_id === artifact.artifact_id ? "selected" : ""}`} onClick={() => onSelect(artifact)}>
            <span className="data-row-main"><b>{artifact.title || artifact.artifact_id}</b><small>{artifact.artifact_type} · {sourceLabel(artifact.source)}</small></span>
            <span className="data-row-badges"><AuthorityBadge artifact={artifact} /></span>
            <span className="data-row-meta">{formatFileSize(artifact.size_bytes)} · {formatDate(artifact.created_at, "short")}</span>
          </button>)}
        </aside>
        {detail}
      </div>
    )}
  </>;
}

function ArtifactDetail({ artifact, content, note, onDelete, workspaceId, onOpenFile }: { artifact: Artifact | null; content: string; note: string; onDelete: (artifact: Artifact) => void; workspaceId: string; onOpenFile: (fid: string) => void }) {
  if (!artifact) return <DetailPanel empty={{ text: "选择一项任务产出", hint: "查看可信状态、来源和内容" }} />;
  return <DetailPanel title={artifact.title || artifact.artifact_id} subtitle={`${artifact.artifact_type} · ${formatFileSize(artifact.size_bytes)}`} actions={<Button size="sm" variant="danger-ghost" onClick={() => onDelete(artifact)}>删除</Button>}>
    <div className="info-grid-3 data-info-grid">
      <Info label="可信状态" value={authorityLabel(artifact)} />
      <Info label="来源" value={sourceLabel(artifact.source)} />
      <Info label="关联任务" value={artifact.run_id ? shortId(artifact.run_id) : "无"} />
      <Info label="文件 ID" value={artifact.file_id || "无"} mono />
      <Info label="敏感级别" value={artifact.sensitivity} />
      <Info label="数据状态" value={lifecycleLabel(artifact.lifecycle)} />
    </div>
    {artifact.governance?.authority_reason && <div className="callout info">{artifact.governance.authority_reason}</div>}
    {artifact.file_id && <div className="actions-row"><a className="btn sm" href={`/api/storage/files/${encodeURIComponent(artifact.file_id)}/download?workspace_id=${encodeURIComponent(workspaceId)}`}>下载原件</a><Button size="sm" onClick={() => onOpenFile(artifact.file_id!)}>打开文件空间</Button></div>}
    <section className="data-detail-section"><h4>内容预览</h4>{note && <p className="dim text-sm">{note}</p>}{content && <CodeBlock>{content}</CodeBlock>}</section>
    <details className="collapse"><summary>元数据</summary><CodeBlock language="json">{JSON.stringify(artifact.metadata || {}, null, 2)}</CodeBlock></details>
  </DetailPanel>;
}

function RelationsView({ files, search, onSearch, onSelect }: { files: ManagedFile[]; search: string; onSearch: (value: string) => void; onSelect: (file: ManagedFile) => void }) {
  return <>
    <FilterBar className="data-relation-filters"><SearchInput value={search} onChange={(event) => onSearch(event.target.value)} onClear={() => onSearch("")} placeholder="搜索关系中的文件或任务" aria-label="搜索数据关系" /><span className="metric-chip">{files.length} 个文件节点</span></FilterBar>
    <div className="data-relations-grid">
      {files.map((file) => <button type="button" className="card data-relation-card" key={file.file_id} onClick={() => onSelect(file)}>
        <span className="data-relation-file" title={file.original_name || file.file_id}><b>{file.original_name || file.file_id}</b><small>{typeLabel(file.logical_type)}</small></span>
        <span className="data-relation-flow">文件</span><span className="data-relation-arrow">→</span>
        <span className="data-relation-flow">{file.reference_count} 个引用</span><span className="data-relation-arrow">→</span>
        <span className="data-relation-flow">{file.artifacts.length} 个任务产出</span>
        <span className="data-relation-types">{file.reference_types.length ? file.reference_types.map(referenceTypeLabel).join("、") : "暂无业务引用"}</span>
      </button>)}
      {!files.length && <EmptyState text="暂无关系数据" />}
    </div>
  </>;
}

function LifecycleView({ retention, archive, archivedItems, busy, onApply, onRestore }: {
  retention: LifecyclePreview | null; archive: LifecyclePreview | null; archivedItems: ArchivedDataItem[]; busy: boolean;
  onApply: (kind: "retention" | "archive") => void; onRestore: (item: ArchivedDataItem) => void;
}) {
  const retentionCount = sumCounts(retention?.candidate_counts);
  const archiveCount = sumCounts(archive?.candidate_counts);
  return <div className="data-lifecycle-grid">
    <section className="card data-lifecycle-card dc-cleanup">
      <div className="data-lifecycle-head"><div><h3>到期清理</h3><p>永久清理超过保留期限且没有活跃引用的数据。</p></div><Badge kind={retentionCount ? "warn" : "ok"}>{retentionCount} 项候选</Badge></div>
      <CandidateCounts counts={retention?.candidate_counts} />
      {retention?.blocked_items?.length ? <p className="text-sm dim">已自动保护 {retention.blocked_items.length} 项仍在使用的数据。</p> : null}
      <Button variant="danger" size="sm" disabled={!retentionCount || busy} onClick={() => onApply("retention")}>清理到期数据</Button>
    </section>
    <section className="card data-lifecycle-card dc-archive-action">
      <div className="data-lifecycle-head"><div><h3>历史归档</h3><p>把历史执行记录、处理过程和任务移入可恢复归档区。</p></div><Badge kind={archiveCount ? "info" : "ok"}>{archiveCount} 项候选</Badge></div>
      <CandidateCounts counts={archive?.candidate_counts} />
      {archive?.blocked_items?.length ? <p className="text-sm dim">已自动保护 {archive.blocked_items.length} 项仍在使用的数据。</p> : null}
      <Button variant="primary" size="sm" disabled={!archiveCount || busy} onClick={() => onApply("archive")}>归档历史数据</Button>
    </section>
    <section className="card data-lifecycle-card dc-archive-area data-archive-list">
      <div className="data-lifecycle-head"><div><h3>归档区</h3><p>归档内容可恢复到原来的运行位置。</p></div><Badge kind="muted">{archivedItems.length} 项</Badge></div>
      {archivedItems.map((item) => <div className="data-archive-row" key={`${item.month}-${item.kind}-${item.name}`}>
        <span><b>{item.name}</b><small>{archiveKindLabel(item.kind)} · {item.month} · {formatFileSize(item.size_bytes)}</small></span>
        <Button size="sm" onClick={() => onRestore(item)}>恢复</Button>
      </div>)}
      {!archivedItems.length && <EmptyState text="归档区为空" />}
    </section>
  </div>;
}

function CandidateCounts({ counts }: { counts?: Record<string, number> }) {
  const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
  return <div className="data-candidate-counts">{entries.length ? entries.map(([key, count]) => <span key={key}><b>{count}</b>{candidateLabel(key)}</span>) : <p className="dim text-sm">当前没有需要处理的数据。</p>}</div>;
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="data-info-cell"><div className="stat-card-box-label">{label}</div><div className={`stat-card-box-value ${mono ? "mono" : ""}`}>{value}</div></div>;
}

function AuthorityBadge({ artifact }: { artifact: Artifact }) {
  const status = artifact.governance?.authority_status;
  if (status === "authoritative") return <Badge kind="ok">最新完整</Badge>;
  if (status === "provisional") return <Badge kind="warn">临时结果</Badge>;
  if (status === "incomplete") return <Badge kind="err">不完整</Badge>;
  if (status === "historical") return <Badge kind="muted">历史版本</Badge>;
  if (status === "contextual") return <Badge kind="info">参考结果</Badge>;
  return <Badge kind="muted">交付结果</Badge>;
}

function authorityLabel(artifact: Artifact): string {
  const status = artifact.governance?.authority_status;
  return status === "authoritative" ? "最新且完整" : status === "provisional" ? "临时结果" : status === "incomplete" ? "内容不完整" : status === "historical" ? "历史版本" : status === "contextual" ? "参考结果" : "交付结果";
}

function typeLabel(type: string): string { return TYPE_LABELS[type] || type || "未知类型"; }
function sourceLabel(source: string): string { return SOURCE_LABELS[source] || source || "系统"; }
function sumCounts(counts?: Record<string, number>): number { return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0); }
function archiveKindLabel(kind: string): string { return ({ runs: "执行记录", traces: "处理过程", jobs: "任务", tmp: "临时文件" } as Record<string, string>)[kind] || kind; }
function candidateLabel(kind: string): string { return ({ runs: "执行记录", traces: "处理过程", jobs: "任务", artifacts: "临时文件", sessions: "会话", memories: "长期记忆", temp: "临时文件" } as Record<string, string>)[kind] || kind; }
function referenceTypeLabel(type: string): string { return ({ run: "执行任务", session: "会话", artifact: "任务产出", knowledge_source: "知识来源", job: "定时任务" } as Record<string, string>)[type] || type || "业务对象"; }
function lifecycleLabel(value: string): string { return ({ active: "使用中", archived: "已归档", soft_deleted: "待清理", purged: "已清理" } as Record<string, string>)[value] || value; }
