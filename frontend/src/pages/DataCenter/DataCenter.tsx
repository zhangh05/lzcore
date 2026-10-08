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
import { Button, DetailPanel, FileKindBadge, FilterBar, InfoList, PageHeader, SearchInput, StatStrip, TabButton } from "../../components/ui";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import type { ArchivedDataItem, Artifact, DataOverview, ManagedFile } from "../../types";
import { isApiError } from "../../types";
import { formatFileSize, formatDate } from "../../utils/format";
import { shortId } from "../../utils/displayText";
import { IconAlert, IconArchive, IconChevronRight, IconDocument, IconDownload, IconGauge, IconLayers, IconLink, IconPlus, IconRefresh, IconShield, IconTrash } from "../../components/Icon";

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

  const reload = () => { void loadData(); void loadArtifacts(); };
  const openFile = (file: ManagedFile) => { setFileFocus(file); setTab("files"); };

  return (
    <div className={`page data-center dm-page${tab === "files" ? " data-center-files" : ""}`} data-testid="page-data-center">
      <PageHeader title="数据管理" subtitle="管理文件、任务产出、数据关联、归档和清理">
        <input ref={uploadRef} type="file" className="file-upload-input" tabIndex={-1} aria-hidden="true" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        {tab !== "files" && <>
          <Button size="sm" iconOnly aria-label="刷新" title="刷新" onClick={reload}><IconRefresh size={15} aria-hidden="true" /></Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => uploadRef.current?.click()}>
            <IconPlus size={14} aria-hidden="true" />{busy ? "处理中…" : "导入数据"}
          </Button>
        </>}
      </PageHeader>

      <FilterBar className="data-center-tabs" role="tablist" aria-label="数据管理视图">
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
        {overview && <span className={`dm-health-chip ${overview.health.ok ? "is-ok" : "is-err"}`} title={`断链 ${overview.health.missing_on_disk} · 未登记路径 ${overview.health.orphan_files}`}>
          <span className="dm-dot" aria-hidden="true" />{overview.health.ok ? "文件存在性检查通过" : "发现数据问题"}
        </span>}
      </FilterBar>

      {error && <div className="callout err dm-callout" role="alert">
        <IconAlert size={16} aria-hidden="true" /><span>{error}</span>
        <Button size="sm" onClick={reload}>重新加载</Button>
      </div>}

      {tab === "overview" && (loading && !overview
        ? <div className="dm-scroll"><div className="dm-section"><LoadingState text="正在读取数据…" skeleton="table" /></div></div>
        : <Overview
          overview={overview}
          files={files}
          pending={{ total: pendingTotal, retention: retentionCount, archive: archiveCount }}
          onImport={() => uploadRef.current?.click()}
          onOpenFiles={() => setTab("files")}
          onOpenFile={openFile}
          onOpenLifecycle={() => setTab("lifecycle")}
        />)}
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
      {tab === "relations" && <RelationsView files={filteredFiles} search={search} onSearch={setSearch} onSelect={openFile} />}
      {tab === "lifecycle" && (
        <LifecycleView retention={retention} archive={archive} archivedItems={archivedItems} busy={busy} onApply={applyLifecycle} onRestore={restoreArchived} />
      )}
    </div>
  );
}

function Overview({ overview, files, pending, onImport, onOpenFiles, onOpenFile, onOpenLifecycle }: {
  overview: DataOverview | null;
  files: ManagedFile[];
  pending: { total: number; retention: number; archive: number };
  onImport: () => void;
  onOpenFiles: () => void;
  onOpenFile: (file: ManagedFile) => void;
  onOpenLifecycle: () => void;
}) {
  if (!overview) return <div className="dm-scroll"><div className="dm-section"><EmptyState text="暂无数据概览" hint="数据服务暂时没有返回概览，可稍后刷新。" /></div></div>;
  const typeEntries = Object.entries(overview.types).sort((a, b) => b[1] - a[1]);
  const typeTotal = typeEntries.reduce((sum, [, count]) => sum + count, 0) || 1;
  return <div className="dm-scroll"><div className="dm-section dm-overview">
    <StatStrip testId="data-stats" label="数据概况" items={[
      { label: "活跃文件", value: overview.files.active, hint: `独立 ${overview.files.unreferenced}` },
      { label: "任务产出", value: overview.artifacts.active },
      { label: "已有引用", value: overview.files.referenced, hint: "受关系保护" },
      { label: "待处理", value: pending.total, tone: pending.total ? "warning" : "default", hint: pending.total ? "到期、归档或回收" : "没有堆积" },
      { label: "已归档", value: overview.files.archived, hint: "可恢复" },
      { label: "总存储", value: formatFileSize(overview.files.size_bytes) },
    ]} />

    <div className="dm-overview-grid">
      <section className="dm-panel" aria-labelledby="dm-recent-title">
        <header className="dm-panel-head">
          <div><h2 id="dm-recent-title">最近数据</h2><p>最近进入当前工作区的文件，点击可直接预览。</p></div>
          {files.length > 0 && <Button size="sm" variant="ghost" onClick={onOpenFiles}>查看全部文件<IconChevronRight size={13} aria-hidden="true" /></Button>}
        </header>
        {files.length > 0 ? <ul className="dm-recent-list">
          {files.slice(0, 8).map((file) => <li key={file.file_id}>
            <button type="button" className="dm-recent-row" onClick={() => onOpenFile(file)}>
              <FileKindBadge kind={file.file_kind} name={file.original_name} />
              <span className="dm-recent-main"><b>{file.original_name || file.file_id}</b><small>{typeLabel(file.logical_type)} · {sourceLabel(file.source)}</small></span>
              <span className="dm-recent-size">{formatFileSize(file.size_bytes)}</span>
              <span className="dm-recent-date">{formatDate(file.created_at, "short")}</span>
            </button>
          </li>)}
        </ul> : <EmptyState
          variant="onboarding"
          icon={<IconPlus size={18} aria-hidden="true" />}
          text="还没有数据"
          hint="导入文件，或运行一次会生成结果文件的任务。"
          action={<Button size="sm" variant="primary" onClick={onImport}>导入第一份数据</Button>}
        />}
      </section>

      <div className="dm-side">
        <section className="dm-panel" aria-labelledby="dm-health-title">
          <header className="dm-panel-head"><div><h2 id="dm-health-title">数据健康</h2><p>登记记录与磁盘原件逐项比对</p></div></header>
          <div className="dm-panel-body">
            <p className={`dm-health-line ${overview.health.ok ? "is-ok" : "is-err"}`}><span className="dm-dot" aria-hidden="true" />{overview.health.ok ? "文件存在性检查通过" : "发现数据问题"}</p>
            <InfoList items={[
              ["断链记录", overview.health.missing_on_disk],
              ["未登记路径", overview.health.orphan_files],
              ["待清理文件", overview.health.soft_deleted],
            ]} />
          </div>
        </section>
        <section className="dm-panel" aria-labelledby="dm-types-title">
          <header className="dm-panel-head"><div><h2 id="dm-types-title">数据构成</h2><p>按登记类型汇总</p></div><span className="dm-count">{overview.files.active} 项</span></header>
          <div className="dm-panel-body">
            {typeEntries.length ? <ul className="dm-breakdown">{typeEntries.map(([type, count]) => (
              <li key={type}>
                <span className="dm-breakdown-label">{typeLabel(type)}</span><b>{count}</b>
                <span className="dm-breakdown-bar" aria-hidden="true"><span style={{ inlineSize: `${Math.max(4, Math.round((count / typeTotal) * 100))}%` }} /></span>
              </li>
            ))}</ul> : <p className="dm-muted">导入数据后将在这里显示类型分布。</p>}
          </div>
        </section>
        <section className="dm-panel" aria-labelledby="dm-life-title">
          <header className="dm-panel-head"><div><h2 id="dm-life-title">归档与清理</h2><p>到期、历史和回收中的数据</p></div></header>
          <div className="dm-panel-body">
            <InfoList items={[
              ["到期候选", pending.retention],
              ["归档候选", pending.archive],
              ["回收中文件", overview.files.soft_deleted],
              ["已归档文件", overview.files.archived],
            ]} />
            <Button size="sm" onClick={onOpenLifecycle}>打开归档与清理</Button>
          </div>
        </section>
      </div>
    </div>
  </div></div>;
}

const ARTIFACT_VIEWS: Array<[ArtifactView, string]> = [["", "全部"], ["current", "当前有效"], ["history", "历史或不完整"], ["deliverables", "交付结果"]];

function ArtifactsView({ artifacts, governance, view, onView, producerId, onClearProducer, selected, onSelect, detail }: {
  artifacts: Artifact[]; governance: ArtifactGovernanceSummary | null; view: ArtifactView; onView: (view: ArtifactView) => void;
  producerId: string; onClearProducer: () => void; selected: Artifact | null; onSelect: (artifact: Artifact) => void; detail: ReactNode;
}) {
  return <div className="dm-workspace">
    <div className="dm-toolbar">
      <div className="dm-segmented" role="group" aria-label="任务产出筛选">
        {ARTIFACT_VIEWS.map(([key, label]) => (
          <Button key={key || "all"} size="sm" variant={view === key ? "selected" : "default"} aria-pressed={view === key} onClick={() => onView(key)}>{label}</Button>
        ))}
      </div>
      {producerId && <span className="dm-filter-chip">任务 {shortId(producerId)}<button type="button" className="link-button" onClick={onClearProducer}>清除</button></span>}
      <div className="spacer" />
      {governance && <span className="dm-toolbar-meta">过程结果 <b>{governance.evidence_streams || 0}</b><span aria-hidden="true">·</span>交付结果 <b>{governance.deliverables || 0}</b></span>}
    </div>
    {!artifacts.length ? (
      <div className="dm-frame dm-frame-empty">
        <EmptyState
          text={view || producerId ? "没有符合条件的任务产出" : "暂无任务产出"}
          hint={view || producerId ? "尝试切换筛选条件或清除任务筛选" : "分析、报告或智能体任务生成的结果会显示在这里"}
        />
      </div>
    ) : (
      <div className="split-shell data-split dm-frame">
        <aside className="dm-list" aria-label="任务产出列表">
          <div className="dm-list-head"><strong>任务产出</strong><span>{artifacts.length} 项</span></div>
          <ul className="dm-list-scroll">
            {artifacts.map((artifact) => {
              const isSelected = selected?.artifact_id === artifact.artifact_id;
              return <li key={artifact.artifact_id}>
                <button type="button" className={`dm-row${isSelected ? " selected" : ""}`} aria-current={isSelected ? "true" : undefined} onClick={() => onSelect(artifact)}>
                  <FileKindBadge kind={String(artifact.file_ext || "").replace(/^\./, "")} name={artifact.title} />
                  <span className="dm-row-main">
                    <b>{artifact.title || artifact.artifact_id}</b>
                    <small>{typeLabel(artifact.artifact_type)} · {sourceLabel(artifact.source)} · {formatFileSize(artifact.size_bytes)} · {formatDate(artifact.created_at, "short")}</small>
                  </span>
                  <span className="dm-row-badge"><AuthorityBadge artifact={artifact} /></span>
                </button>
              </li>;
            })}
          </ul>
        </aside>
        {detail}
      </div>
    )}
  </div>;
}

function ArtifactDetail({ artifact, content, note, onDelete, workspaceId, onOpenFile }: { artifact: Artifact | null; content: string; note: string; onDelete: (artifact: Artifact) => void; workspaceId: string; onOpenFile: (fid: string) => void }) {
  if (!artifact) return <DetailPanel empty={{ text: "选择一项任务产出", hint: "查看可信状态、来源和内容" }} />;
  return <DetailPanel className="dm-detail" title={artifact.title || artifact.artifact_id} subtitle={`${typeLabel(artifact.artifact_type)} · ${formatFileSize(artifact.size_bytes)}`} actions={<>
    {artifact.file_id && <a className="btn sm primary" href={`/api/storage/files/${encodeURIComponent(artifact.file_id)}/download?workspace_id=${encodeURIComponent(workspaceId)}`}><IconDownload size={14} aria-hidden="true" />下载原件</a>}
    {artifact.file_id && <Button size="sm" onClick={() => onOpenFile(artifact.file_id!)}>打开文件空间</Button>}
    <Button size="sm" variant="danger-ghost" onClick={() => onDelete(artifact)}><IconTrash size={14} aria-hidden="true" />删除</Button>
  </>}>
    {artifact.governance?.authority_reason && <div className="callout info">{artifact.governance.authority_reason}</div>}
    <section className="dm-detail-section" aria-label="产出信息">
      <InfoList items={[
        ["可信状态", authorityLabel(artifact)],
        ["来源", sourceLabel(artifact.source)],
        ["关联任务", artifact.run_id ? shortId(artifact.run_id) : "无"],
        ["数据状态", lifecycleLabel(artifact.lifecycle)],
        ["敏感级别", artifact.sensitivity],
        ["文件 ID", artifact.file_id || "无", true],
        ["创建时间", formatDate(artifact.created_at, "short")],
      ]} />
    </section>
    <section className="dm-detail-section"><h4>内容预览</h4>{note && <p className="dm-muted" role="status">{note}</p>}{content && <CodeBlock>{content}</CodeBlock>}</section>
    <details className="dm-disclosure"><summary>元数据</summary><CodeBlock language="json">{JSON.stringify(artifact.metadata || {}, null, 2)}</CodeBlock></details>
  </DetailPanel>;
}

function RelationsView({ files, search, onSearch, onSelect }: { files: ManagedFile[]; search: string; onSearch: (value: string) => void; onSelect: (file: ManagedFile) => void }) {
  return <div className="dm-scroll"><div className="dm-section">
    <div className="dm-toolbar dm-toolbar-card">
      <SearchInput className="dm-search" value={search} onChange={(event) => onSearch(event.target.value)} onClear={() => onSearch("")} placeholder="搜索关系中的文件或任务" aria-label="搜索数据关系" />
      <div className="spacer" />
      <span className="dm-toolbar-meta"><b>{files.length}</b> 个文件节点</span>
    </div>
    {files.length ? <div className="data-table-scroll dm-table-wrap">
      <table className="tbl dm-relations-table">
        <caption className="sr-only">文件与业务对象的关联</caption>
        <thead><tr><th scope="col">文件</th><th scope="col">类型</th><th scope="col" className="num">引用</th><th scope="col" className="num">任务产出</th><th scope="col">引用方</th></tr></thead>
        <tbody>
          {files.map((file) => <tr key={file.file_id}>
            <td><button type="button" className="dm-cell-link" onClick={() => onSelect(file)} title={file.original_name || file.file_id}>
              <FileKindBadge kind={file.file_kind} name={file.original_name} /><span>{file.original_name || file.file_id}</span>
            </button></td>
            <td>{typeLabel(file.logical_type)}</td>
            <td className="num">{file.reference_count}</td>
            <td className="num">{file.artifacts.length}</td>
            <td className={file.reference_types.length ? "" : "dm-muted"}>{file.reference_types.length ? file.reference_types.map(referenceTypeLabel).join("、") : "暂无业务引用"}</td>
          </tr>)}
        </tbody>
      </table>
    </div> : <div className="dm-frame dm-frame-empty"><EmptyState text={search ? "没有匹配的文件" : "暂无关系数据"} hint={search ? "换一个文件名、来源或任务编号再试" : "文件被会话、任务或知识库引用后会出现在这里"} /></div>}
  </div></div>;
}

function LifecycleView({ retention, archive, archivedItems, busy, onApply, onRestore }: {
  retention: LifecyclePreview | null; archive: LifecyclePreview | null; archivedItems: ArchivedDataItem[]; busy: boolean;
  onApply: (kind: "retention" | "archive") => void; onRestore: (item: ArchivedDataItem) => void;
}) {
  const retentionCount = sumCounts(retention?.candidate_counts);
  const archiveCount = sumCounts(archive?.candidate_counts);
  return <div className="dm-scroll"><div className="dm-section dm-lifecycle">
    <div className="dm-lifecycle-actions">
      <section className={`dm-panel dm-action-card is-danger${retentionCount ? " has-candidates" : ""}`} aria-labelledby="dm-retention-title">
        <header className="dm-panel-head">
          <div><h2 id="dm-retention-title">到期清理</h2><p>永久清理超过保留期限且没有活跃引用的数据。</p></div>
          <span className="dm-action-count"><b>{retentionCount}</b>项候选</span>
        </header>
        <div className="dm-panel-body">
          <CandidateCounts counts={retention?.candidate_counts} />
          {retention?.blocked_items?.length ? <p className="dm-muted"><IconShield size={13} aria-hidden="true" />已自动保护 {retention.blocked_items.length} 项仍在使用的数据。</p> : null}
        </div>
        <footer className="dm-panel-foot"><Button variant="danger" size="sm" disabled={!retentionCount || busy} onClick={() => onApply("retention")}>清理到期数据</Button></footer>
      </section>
      <section className={`dm-panel dm-action-card is-info${archiveCount ? " has-candidates" : ""}`} aria-labelledby="dm-archive-title">
        <header className="dm-panel-head">
          <div><h2 id="dm-archive-title">历史归档</h2><p>把历史执行记录、处理过程和任务移入可恢复归档区。</p></div>
          <span className="dm-action-count"><b>{archiveCount}</b>项候选</span>
        </header>
        <div className="dm-panel-body">
          <CandidateCounts counts={archive?.candidate_counts} />
          {archive?.blocked_items?.length ? <p className="dm-muted"><IconShield size={13} aria-hidden="true" />已自动保护 {archive.blocked_items.length} 项仍在使用的数据。</p> : null}
        </div>
        <footer className="dm-panel-foot"><Button variant="primary" size="sm" disabled={!archiveCount || busy} onClick={() => onApply("archive")}>归档历史数据</Button></footer>
      </section>
    </div>
    <section className="dm-panel" aria-labelledby="dm-archived-title">
      <header className="dm-panel-head"><div><h2 id="dm-archived-title">归档区</h2><p>归档内容可恢复到原来的运行位置。</p></div><span className="dm-count">{archivedItems.length} 项</span></header>
      {archivedItems.length ? <ul className="dm-archive-list">
        {archivedItems.map((item) => <li key={`${item.month}-${item.kind}-${item.name}`}>
          <span className="dm-archive-main"><b>{item.name}</b><small>{archiveKindLabel(item.kind)} · {item.month} · {formatFileSize(item.size_bytes)}</small></span>
          <Button size="sm" onClick={() => onRestore(item)}>恢复</Button>
        </li>)}
      </ul> : <EmptyState text="归档区为空" hint="执行历史归档后，归档内容会按月份列在这里。" />}
    </section>
  </div></div>;
}

function CandidateCounts({ counts }: { counts?: Record<string, number> }) {
  const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
  if (!entries.length) return <p className="dm-muted">当前没有需要处理的数据。</p>;
  return <ul className="dm-candidates">{entries.map(([key, count]) => <li key={key}><b>{count}</b>{candidateLabel(key)}</li>)}</ul>;
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
