import { FilePreview } from "./FilePreview";
import { useState } from "react";
import { FactSummary } from "../../kit/factSummary";
import { api, bodyOf, describeFailure, enc, uploadMultipart } from "../../api/client";
import { useShell } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/EmptyState";
import type { HttpOutcome } from "../../contracts/auth";
import { NAMES } from "../../contracts/naming";
import { MemoryWriteView } from "../../kit/MemoryWriteView";
import { reviewMemory, stableMemoryId, writeMemory, type MemoryWriteState } from "../../kit/memoryWrite";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, ConfirmDialog, Drawer, FailureNote, KeyValues, LoadState, PreviewApply, RawData, ReceiptNote, Table, Tabs, fmtTime } from "../../kit/ui";
import { useLocation, useNavigate } from "../../router";
import { withWorkspace } from "../../app/shellContext";

type LibTab = "files" | "knowledge" | "memory";
const TAB_LABEL: Record<LibTab, string> = { files: NAMES.files, knowledge: NAMES.knowledge, memory: NAMES.memory };

/** 资料：文件 / 知识 / 记忆统一页头 + 表格；tab 即路径（/library/<tab>），可深链。 */
export function LibraryPage() {
  const { workspaceId: ws } = useShell();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab: LibTab = pathname.endsWith("/knowledge") ? "knowledge" : pathname.endsWith("/memory") ? "memory" : "files";
  if (!ws) return <div className="page"><p role="status">正在确定工作区…</p></div>;
  return (
    <div className="page" data-testid={`library-${tab}`}>
      <PageHeader title={`${NAMES.library} / ${TAB_LABEL[tab]}`} subtitle="文件、知识与记忆统一管理。" />
      <Tabs label="资料分类" current={tab} onChange={(t: LibTab) => navigate(withWorkspace(`/library/${t}`, ws))} tabs={(["files", "knowledge", "memory"] as const).map((k) => ({ key: k, label: TAB_LABEL[k] }))} />
      {tab === "files" ? <FilesView ws={ws} /> : null}
      {tab === "knowledge" ? <KnowledgeView ws={ws} /> : null}
      {tab === "memory" ? <MemoryView ws={ws} /> : null}
    </div>
  );
}

interface FileRec { file_id: string; original_name?: string; name?: string; filename?: string; folder?: string; metadata?: { folder?: string }; size_bytes?: number; mime_type?: string; lifecycle?: string; created_at?: string; updated_at?: string; logical_type?: string }
const FILE_TYPE_ZH: Record<string, string> = {
  knowledge_source: "知识来源", report: "报告", chat_attachment: "对话附件", user_upload: "用户上传",
  artifact_output: "运行产出", message_large_content: "长消息正文", tmp: "临时文件",
};
/** 中文类型名 + 原值；未知取值原样显示。 */
function fileType(f: { logical_type?: string; mime_type?: string }) {
  const t = f.logical_type;
  return t ? (FILE_TYPE_ZH[t] ? `${FILE_TYPE_ZH[t]}（${t}）` : t) : f.mime_type;
}
const fileName = (f: FileRec) => f.original_name ?? f.name ?? f.filename ?? f.file_id;
/** 后端 PATCH 把文件夹写在 metadata.folder（storage/managed_files），顶层 folder 只作兼容。 */
export const fileFolder = (f: FileRec) => f.metadata?.folder ?? f.folder ?? "";

function FilesView({ ws }: { ws: string }) {
  const [lifecycle, setLifecycle] = useState<"active" | "trash">("active");
  const [q, setQ] = useState("");
  const [files, reload] = useApi("/api/storage/files", { workspace_id: ws, lifecycle, q });
  const [open, setOpen] = useState<FileRec | null>(null);
  const [view, setView] = useState<"list" | "sources" | "governance">("list");
  return (
    <>
      <div className="row-actions">
        <Tabs label="文件视图" variant="segmented" current={view} onChange={setView} tabs={[{ key: "list", label: "托管文件" }, { key: "sources", label: "来源浏览" }, { key: "governance", label: "治理" }]} />
      </div>
      {view === "list" ? (
        <>
          <div className="row-actions">
            <input className="input" placeholder="按名称筛选" value={q} onChange={(e) => setQ(e.target.value)} aria-label="按名称筛选" />
            <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as "active" | "trash")} aria-label="生命周期"><option value="active">在用</option><option value="trash">回收站</option></select>
          </div>
          <LoadState value={files} onReload={reload}>{() => (
            <Table testId="files-table" rows={listOf<FileRec>(files, "files")} rowKey={(f) => f.file_id} onRowOpen={setOpen} empty={<p className="muted">{lifecycle === "trash" ? "回收站为空。" : "还没有文件。"}</p>}
              columns={[
                { key: "name", label: "名称", render: fileName, sortValue: fileName },
                { key: "folder", label: "文件夹", render: (f) => fileFolder(f) || "—", sortValue: fileFolder },
                { key: "type", label: "类型", render: (f) => fileType(f) ?? "—" },
                { key: "size", label: "大小", render: (f) => (typeof f.size_bytes === "number" ? `${Math.ceil(f.size_bytes / 1024)} KB` : "—"), sortValue: (f) => f.size_bytes ?? 0 },
                { key: "time", label: "创建", render: (f) => fmtTime(f.created_at), sortValue: (f) => f.created_at ?? "" },
              ]} />
          )}</LoadState>
        </>
      ) : null}
      {view === "sources" ? <SourcesBrowser ws={ws} /> : null}
      {view === "governance" ? <FileGovernance ws={ws} /> : null}
      {open ? <FileDetail ws={ws} file={open} trash={lifecycle === "trash"} onClose={() => { setOpen(null); reload(); }} /> : null}
    </>
  );
}

function FileDetail({ ws, file, trash, onClose }: { ws: string; file: FileRec; trash: boolean; onClose: () => void }) {
  const base = `/api/storage/files/${enc(file.file_id)}`;
  const [meta, reloadMeta] = useApi(base, { workspace_id: ws });
  const [view, setView] = useState<"preview" | "inspect" | "edit">("preview");
  const [inspect] = useApi(view === "inspect" ? `${base}/inspect` : null, { workspace_id: ws });
  // 标题 / 表单 / 回读都以 GET /api/storage/files/<id> 的回读为准，而不是列表里打开时的旧快照。
  const current: FileRec = (meta.state === "ok" ? (meta.data as { file?: FileRec }).file : undefined) ?? file;
  const [name, setName] = useState(fileName(file));
  const [folder, setFolder] = useState(fileFolder(file));
  const [result, setResult] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [readback, setReadback] = useState<{ name: string; folder: string; at?: string } | { error: HttpOutcome } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async () => {
    setReadback(null);
    const o = await api.patch(base, { workspace_id: ws, name, folder });
    setResult({ label: "整理", o });
    if (o.kind !== "http" || o.status >= 300) return;
    const r = await api.get(base, { workspace_id: ws });
    const f = bodyOf<{ file?: FileRec }>(r)?.file;
    if (r.kind === "http" && r.status === 200 && f) {
      setReadback({ name: fileName(f), folder: fileFolder(f), at: f.updated_at });
      setName(fileName(f)); setFolder(fileFolder(f));
    } else setReadback({ error: r });
    reloadMeta();
  };
  return (
    <Drawer title={fileName(current)} onClose={onClose} testId="file-detail">
      <LoadState value={meta} onReload={reloadMeta}>{() => <KeyValues items={[
        ["名称", <span key="n" data-testid="file-detail-name">{fileName(current)}</span>],
        ["文件夹", <span key="f" data-testid="file-detail-folder">{fileFolder(current) || "（根目录）"}</span>],
        ["状态", current.lifecycle === "trash" ? "回收站" : current.lifecycle === "active" ? "在用" : current.lifecycle ?? "未上报"],
        ["类型", fileType(current) ?? "未上报"],
        ["大小", typeof current.size_bytes === "number" ? `${Math.ceil(current.size_bytes / 1024)} KB` : "未上报"],
        ["更新", fmtTime(current.updated_at ?? current.created_at)],
        ["file_id", <code key="i">{file.file_id}</code>],
      ]} />}</LoadState>
      <div className="row-actions">
        <a className="btn" href={`${base}/download?workspace_id=${enc(ws)}`}>下载</a>
        {trash
          ? <Button onClick={async () => { setResult({ label: "恢复", o: await api.post(`${base}/restore`, { workspace_id: ws }) }); reloadMeta(); }}>从回收站恢复</Button>
          : <Button variant="danger" onClick={() => setConfirmDelete(true)}>移入回收站</Button>}
      </div>
      {result ? (result.o.kind === "http" && result.o.status < 300 ? (readback && !("error" in readback) ? null : <ReceiptNote text={`${result.label}请求已受理`} />) : <FailureNote outcome={result.o} />) : null}
      {readback ? ("error" in readback ? <FailureNote outcome={readback.error} /> : (
        <p className="readback-note" role="status" data-testid="file-readback">保存后回读：名称「{readback.name}」 · 文件夹「{readback.folder || "（根目录）"}」{readback.at ? ` · ${fmtTime(readback.at)}` : ""}</p>
      )) : null}
      <Tabs label="文件详情" current={view} onChange={setView} tabs={[{ key: "preview", label: "预览" }, { key: "inspect", label: "检查" }, { key: "edit", label: "整理" }]} />
      {view === "preview" ? <FilePreview ws={ws} fileId={file.file_id} mime={current.mime_type} name={fileName(current)} active={(current.lifecycle ?? "active") === "active"} /> : null}
      {view === "inspect" ? <LoadState value={inspect}>{(d) => <FactSummary value={(d as { inspect?: unknown }).inspect ?? d} testId="file-inspect" />}</LoadState> : null}
      {view === "edit" ? (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="file-edit-form">
          <p className="muted">后端只支持改名与移动文件夹（PATCH name / folder），不支持在线改写文件内容。保存后会重新读取文件记录并显示服务端的值。</p>
          <label className="field"><span>名称</span><input value={name} onChange={(e) => setName(e.target.value)} data-testid="file-edit-name" /></label>
          <label className="field"><span>文件夹</span><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="例如 合成/巡检" data-testid="file-edit-folder" /></label>
          <Button type="submit" variant="primary" data-testid="file-edit-save">保存并回读</Button>
        </form>
      ) : null}
      {confirmDelete ? <ConfirmDialog title="移入回收站？" details={<p>「{fileName(current)}」将移入回收站，可从回收站恢复。</p>} confirmLabel="移入回收站"
        onCancel={() => setConfirmDelete(false)} onConfirm={async () => { setConfirmDelete(false); setResult({ label: "删除", o: await api.del(base, undefined, { workspace_id: ws, confirm: true }) }); reloadMeta(); }} /> : null}
    </Drawer>
  );
}

function SourcesBrowser({ ws }: { ws: string }) {
  const [path, setPath] = useState("files/data");
  const [entries, reload] = useApi("/api/storage/sources", { workspace_id: ws, filepath: path });
  const [open, setOpen] = useState<string | null>(null);
  const [content] = useApi(open ? "/api/storage/sources/content" : null, { workspace_id: ws, filepath: open ?? "" });
  return (
    <section data-testid="sources-browser">
      <p className="muted">路径：<code>{path}</code> {path !== "files/data" ? <Button variant="ghost" onClick={() => setPath(path.split("/").slice(0, -1).join("/") || "files/data")}>上一级</Button> : null}</p>
      <LoadState value={entries} onReload={reload}>{() => (
        <ul className="nav-list">{listOf<{ name: string; path: string; is_dir?: boolean; kind?: string }>(entries, "entries").map((e) => (
          <li key={e.path}><button type="button" className="btn ghost" onClick={() => (e.is_dir || e.kind === "dir" ? setPath(e.path) : setOpen(e.path))}>{e.is_dir || e.kind === "dir" ? "📁" : "📄"} {e.name}</button></li>
        ))}</ul>
      )}</LoadState>
      {open ? <Drawer title={open} onClose={() => setOpen(null)}><LoadState value={content}>{(d) => <pre className="json-block">{String((d as { content?: string }).content ?? "")}</pre>}</LoadState></Drawer> : null}
    </section>
  );
}

function FileGovernance({ ws }: { ws: string }) {
  const [health, reload] = useApi("/api/storage/health", { workspace_id: ws });
  return (
    <section data-testid="file-governance">
      <h3>存储健康（回读）</h3>
      <LoadState value={health} onReload={reload}>{(d) => <StorageHealth value={(d as { health?: StorageHealthBody }).health ?? (d as StorageHealthBody)} />}</LoadState>
      <PreviewApply label="提交对账（reconcile）" testId="reconcile"
        preview={() => api.post("/api/storage/reconcile", { workspace_id: ws, apply: false })}
        apply={() => api.post("/api/storage/reconcile", { workspace_id: ws, apply: true })}
        renderPreview={(b) => <PlanPreview value={b} />} />
      <PreviewApply label="引用迁移（migration）" testId="migration"
        preview={() => api.post("/api/storage/migration", { workspace_id: ws, apply: false })}
        apply={() => api.post("/api/storage/migration", { workspace_id: ws, apply: true })}
        renderPreview={(b) => <PlanPreview value={b} />} />
      <p className="muted">「封存（seal）」在基线后端没有独立接口；对账 / 迁移的 apply 前必须先预览。</p>
    </section>
  );
}

interface StorageHealthBody { ok?: boolean; file_count?: number; reference_count?: number; issues?: unknown[]; unresolved?: unknown[]; elapsed_ms?: number; checked?: { owner_types?: string[]; unchecked_owner_types?: string[]; hashes?: boolean } }
function StorageHealth({ value }: { value: StorageHealthBody }) {
  const issues = value.issues?.length ?? 0, unresolved = value.unresolved?.length ?? 0;
  return (
    <div data-testid="storage-health">
      <p><Chip tone={value.ok ? (issues || unresolved ? "warn" : "ok") : "danger"}>{value.ok ? (issues || unresolved ? "有待处理项" : "健康") : "检查未通过"}</Chip>{" "}
        <span className="muted">托管文件 {value.file_count ?? "未上报"} 个 · 引用 {value.reference_count ?? "未上报"} 条 · 问题 {issues} · 未解决 {unresolved}{typeof value.elapsed_ms === "number" ? ` · 耗时 ${value.elapsed_ms} ms` : ""}</span></p>
      <p className="muted">已检查：{(value.checked?.owner_types ?? []).join("、") || "未上报"}{value.checked?.hashes === false ? " · 未校验哈希" : ""}{(value.checked?.unchecked_owner_types ?? []).length ? ` · 未检查：${value.checked!.unchecked_owner_types!.join("、")}` : ""}</p>
      <RawData value={value} label="诊断原文" />
    </div>
  );
}
function PlanPreview({ value }: { value: unknown }) {
  const v = (value ?? {}) as { ok?: boolean; applied?: boolean; automatic_replay?: boolean; payload_writes?: number; results?: unknown[] };
  return (
    <div data-testid="plan-preview">
      <p>{v.applied ? "已执行" : "仅预览（未执行）"} · 计划变更 {v.results?.length ?? 0} 项 · 写入 {v.payload_writes ?? 0} 次 · 自动重放：{v.automatic_replay ? "是" : "否"}</p>
      <RawData value={value} label="诊断原文" />
    </div>
  );
}

interface KSource { source_id: string; name?: string; title?: string; status?: string; chunk_count?: number; updated_at?: string; error?: string }
export const KNOWLEDGE_STATUS_LABEL: Record<string, string> = { indexed: "已索引", pending: "待索引", indexing: "索引中", failed: "索引失败", disabled: "已停用" };

function KnowledgeView({ ws }: { ws: string }) {
  const [sources, reload] = useApi("/api/knowledge/sources", { workspace_id: ws });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HttpOutcome | null>(null);
  const [del, setDel] = useState<KSource | null>(null);
  const [notice, setNotice] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [reindexState, setReindexState] = useState<Record<string, string>>({});
  const [reading, setReading] = useState<{ sourceId: string; chunkId?: string; title?: string } | null>(null);
  const [searched, setSearched] = useState("");

  const reindex = async (s: KSource) => {
    const o = await api.post(`/api/knowledge/sources/${enc(s.source_id)}/reindex`, { workspace_id: ws }, { workspace_id: ws });
    if (o.kind !== "http" || o.status >= 300) { setNotice({ label: "重建索引", o }); return; }
    // 受理 ≠ 成功：回读 source.status。
    const r = await api.get(`/api/knowledge/sources/${enc(s.source_id)}`, { workspace_id: ws });
    const st = bodyOf<{ source?: KSource }>(r)?.source?.status;
    setReindexState((m) => ({ ...m, [s.source_id]: st ? `重建已受理；回读状态：${KNOWLEDGE_STATUS_LABEL[st] ?? st}` : "重建已受理；回读未得到状态" }));
    reload();
  };
  return (
    <>
      <div className="row-actions">
        <label className="btn">上传到知识库<input type="file" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          setNotice({ label: "上传", o: await uploadMultipart("/api/knowledge/upload", { workspace_id: ws }, f) }); reload(); e.target.value = "";
        }} /></label>
        <form className="row-actions" onSubmit={async (e) => { e.preventDefault(); setSearched(q.trim()); setHits(await api.get("/api/knowledge/search", { workspace_id: ws, q: q.trim() })); }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="检索知识" aria-label="检索知识" />
          <Button type="submit" disabled={!q.trim()}>检索</Button>
        </form>
      </div>
      {notice ? (notice.o.kind === "http" && notice.o.status < 300 ? <ReceiptNote text={`${notice.label}已提交`} /> : <FailureNote outcome={notice.o} />) : null}
      {hits ? (hits.kind === "http" && hits.status === 200 ? (
        <KnowledgeHits q={searched} hits={bodyOf<{ results?: KHit[] }>(hits)?.results ?? []} onRead={(h) => setReading({ sourceId: h.source_id ?? "", chunkId: h.chunk_id, title: hitTitle(h) })} />
      ) : <FailureNote outcome={hits} />) : null}
      <LoadState value={sources} onReload={reload}>{() => (
        <Table testId="knowledge-table" rows={listOf<KSource>(sources, "sources")} rowKey={(s) => s.source_id} empty={<p className="muted">知识库为空。</p>}
          columns={[
            { key: "name", label: "来源", render: (s) => <button type="button" className="link-button" onClick={() => setReading({ sourceId: s.source_id, title: s.title ?? s.name })} data-testid="knowledge-open">{s.title ?? s.name ?? s.source_id}</button> },
            { key: "status", label: "索引状态", render: (s) => <><Chip tone={s.status === "failed" ? "danger" : s.status === "indexed" ? "ok" : "info"}>{KNOWLEDGE_STATUS_LABEL[s.status ?? ""] ?? s.status ?? "未上报"}</Chip>{reindexState[s.source_id] ? <span className="muted" data-testid="reindex-readback"> {reindexState[s.source_id]}</span> : null}</> },
            { key: "chunks", label: "片段", render: (s) => String(s.chunk_count ?? "—") },
            { key: "act", label: "", render: (s) => <span className="row-actions"><Button onClick={() => void reindex(s)}>重建索引</Button><Button variant="ghost" onClick={() => setDel(s)} data-testid="knowledge-delete">删除</Button></span> },
          ]} />
      )}</LoadState>
      {reading ? <KnowledgeReader ws={ws} sourceId={reading.sourceId} chunkId={reading.chunkId} title={reading.title} listStatus={listOf<KSource>(sources, "sources").find((x) => x.source_id === reading.sourceId)?.status} onClose={() => setReading(null)} /> : null}
      {del ? <ConfirmDialog title="删除知识来源？" details={<p>将删除「{del.title ?? del.name ?? del.source_id}」及其索引片段。</p>} confirmLabel="删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const s = del; setDel(null); setNotice({ label: "删除", o: await api.del(`/api/knowledge/sources/${enc(s.source_id)}`, { workspace_id: ws }, { workspace_id: ws }) }); reload(); }} /> : null}
    </>
  );
}

/** 检索命中的真实字段（backend/api/knowledge_routes）：title / artifact_name / summary / safe_excerpt / content，没有 text。 */
interface KHit { chunk_id?: string; source_id?: string; title?: string; artifact_name?: string; summary?: string; safe_excerpt?: string; content?: string; score?: number }
const hitTitle = (h: KHit) => h.title || h.artifact_name || h.source_id || "未命名来源";
const hitExcerpt = (h: KHit) => h.safe_excerpt || h.summary || (h.content ? h.content.slice(0, 240) : "");

function KnowledgeHits({ q, hits, onRead }: { q: string; hits: KHit[]; onRead: (h: KHit) => void }) {
  return (
    <section className="card" data-testid="knowledge-hits">
      <h3>检索结果 <span className="muted">「{q}」· {hits.length} 条</span></h3>
      {hits.length ? (
        <ol className="hit-list">
          {hits.map((h, i) => (
            <li key={h.chunk_id ?? i} className="hit-item" data-testid="knowledge-hit">
              <div className="hit-head">
                <button type="button" className="link-button" onClick={() => onRead(h)} data-testid="knowledge-hit-open">{hitTitle(h)}</button>
                {typeof h.score === "number" ? <span className="muted">相关度 {h.score.toFixed(2)}</span> : null}
              </div>
              <p className="hit-excerpt" data-testid="knowledge-hit-excerpt">{hitExcerpt(h) || <span className="muted">后端未返回摘录</span>}</p>
              <span className="muted">来源 <code>{h.source_id}</code>{h.chunk_id ? <> · 片段 <code>{h.chunk_id}</code></> : null}</span>
            </li>
          ))}
        </ol>
      ) : <p className="muted" data-testid="knowledge-hits-empty">没有命中「{q}」的内容。可以换个关键词，或确认来源已完成索引（状态为「已索引」）。</p>}
    </section>
  );
}

interface KChunk { chunk_id?: string; content?: string; text?: string; safe_excerpt?: string; summary?: string; chunk_type?: string; chapter?: string; section?: string; parent_chunk_id?: string }
const CHUNK_TYPE_ZH: Record<string, string> = { child: "检索片段", parent: "上下文段（父级）" };
function KnowledgeReader({ ws, sourceId, chunkId, title, listStatus, onClose }: { ws: string; sourceId: string; chunkId?: string; title?: string; listStatus?: string; onClose: () => void }) {
  const [src, reload] = useApi(`/api/knowledge/sources/${enc(sourceId)}`, { workspace_id: ws });
  return (
    <Drawer title={title || sourceId} onClose={onClose} testId="knowledge-reader">
      <LoadState value={src} onReload={reload}>{(d) => {
        const s = ((d as { source?: KSource & { chunks?: KChunk[]; artifact_name?: string; created_at?: string } }).source ?? {}) as KSource & { chunks?: KChunk[]; artifact_name?: string; created_at?: string };
        const chunks = s.chunks ?? [];
        return (
          <>
            <KeyValues items={[["来源", s.title ?? s.name ?? s.artifact_name ?? sourceId], ["索引状态", s.status ? (KNOWLEDGE_STATUS_LABEL[s.status] ?? s.status) : listStatus ? `${KNOWLEDGE_STATUS_LABEL[listStatus] ?? listStatus}（来源列表；详情未返回）` : "未上报"], ["片段", String(s.chunk_count ?? chunks.length)], ["更新", fmtTime(s.updated_at ?? s.created_at)], ["source_id", <code key="s">{sourceId}</code>]]} />
            {chunks.length ? (
              <ol className="chunk-list" data-testid="knowledge-chunks">
                {chunks.map((c, i) => (
                  <li key={c.chunk_id ?? i} className={c.chunk_id && c.chunk_id === chunkId ? "is-hit" : undefined} data-testid={c.chunk_id === chunkId ? "knowledge-chunk-hit" : "knowledge-chunk"}>
                    <span className="muted">片段 {i + 1}{c.chunk_type ? ` · ${CHUNK_TYPE_ZH[c.chunk_type] ?? c.chunk_type}` : ""}{c.chapter ? ` · ${c.chapter}` : ""}{c.chunk_id === chunkId ? " · 检索命中" : ""}</span>
                    <div className="chunk-body">{c.content ?? c.text ?? c.safe_excerpt ?? c.summary ?? ""}</div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">该来源没有可读片段（可能尚未索引完成）。</p>}
            <RawData value={s} label="来源记录原文" />
          </>
        );
      }}</LoadState>
    </Drawer>
  );
}

interface MemRec { memory_id: string; summary?: string; content?: string; status?: string; scope?: string; memory_type?: string; source?: string; created_at?: string; updated_at?: string; confidence?: number; metadata?: { conflict_memory_ids?: string[] } }
const MEMORY_STATUS_LABEL: Record<string, string> = { active: "生效中", pending: "待确认", conflict: "与已有记忆冲突", rejected: "已拒绝", expired: "已过期" };

function MemoryView({ ws }: { ws: string }) {
  const [list, reload] = useApi("/api/memory/list", { workspace_id: ws });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [writeState, setWriteState] = useState<MemoryWriteState>({ kind: "idle" });
  const [notice, setNotice] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [confirming, setConfirming] = useState<MemRec | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState(false);
  const records = listOf<MemRec>(list, "records");
  const draftKey = `${ws}:library:${draft.title}`;
  const blocked = writeState.kind === "unknown" || writeState.kind === "writing";
  return (
    <>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        setWriteState({ kind: "writing" });
        setWriteState(await writeMemory(ws, { memory_id: stableMemoryId(draftKey), title: draft.title, content: draft.content, user_confirmed: !pendingReview }));
        reload();
      }}>
        <h3>新增记忆</h3>
        <label className="field"><span>标题</span><input data-testid="memory-title" value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setWriteState({ kind: "idle" }); }} /></label>
        <label className="field"><span>内容</span><textarea data-testid="memory-content" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={3} /></label>
        <label className="check"><input type="checkbox" checked={pendingReview} onChange={(e) => setPendingReview(e.target.checked)} data-testid="memory-pending-toggle" /> 先放入待确认（不立即生效，稍后在详情里确认或驳回）</label>
        <Button type="submit" variant="primary" disabled={blocked || !draft.content.trim()} data-testid="memory-save">写入并回读</Button>
        <MemoryWriteView ws={ws} state={writeState} onState={setWriteState} />
      </form>
      {notice ? (notice.o.kind === "http" && notice.o.status < 300 ? <ReceiptNote text={`${notice.label}已提交`} /> : <FailureNote outcome={notice.o} />) : null}
      {sel.size ? <Button variant="danger" onClick={() => setBatch(true)} data-testid="memory-batch-delete">删除所选（{sel.size}）</Button> : null}
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="memory-table" rows={records} rowKey={(m) => m.memory_id} onRowOpen={(m) => setOpened(m.memory_id)} selectable selected={sel} onSelect={setSel} empty={<p className="muted">还没有记忆。</p>}
          columns={[
            { key: "summary", label: "记忆", render: (m) => <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); setOpened(m.memory_id); }} data-testid="memory-open">{m.summary || m.content?.slice(0, 60) || m.memory_id}</button> },
            { key: "status", label: "状态", render: (m) => <Chip tone={m.status === "conflict" ? "warn" : m.status === "active" ? "ok" : "info"}>{MEMORY_STATUS_LABEL[m.status ?? ""] ?? m.status ?? "未上报"}</Chip> },
            { key: "conflict", label: "冲突", render: (m) => m.status === "conflict" ? <span data-testid="memory-conflict-hint">与 {(m.metadata?.conflict_memory_ids ?? []).join("、") || "已有记忆"} 冲突 <Button onClick={() => setConfirming(m)}>采用这条</Button></span> : "—" },
            { key: "id", label: "memory_id", render: (m) => <code>{m.memory_id}</code> },
            { key: "time", label: "更新", render: (m) => fmtTime(m.updated_at), sortValue: (m) => m.updated_at ?? "" },
          ]} />
      )}</LoadState>
      {confirming ? <ConfirmDialog title="采用这条记忆？" danger={false} confirmLabel="确认采用" onCancel={() => setConfirming(null)}
        details={<><p>确认后这条将生效，冲突的记忆：{(confirming.metadata?.conflict_memory_ids ?? []).map((i) => <code key={i}>{i} </code>)}。</p><p className="memory-full">{confirming.content}</p><RawData value={confirming} label="记录原文" /></>}
        onConfirm={async () => { const m = confirming; setConfirming(null); setNotice({ label: "确认", o: await api.post("/api/memory/confirm", { workspace_id: ws, memory_id: m.memory_id }) }); reload(); }} /> : null}
      {opened ? <MemoryDetail ws={ws} memoryId={opened} onClose={() => setOpened(null)} onChanged={reload} /> : null}
      {batch ? <ConfirmDialog title={`删除 ${sel.size} 条记忆？`} confirmLabel="删除" testId="memory-batch-dialog" onCancel={() => setBatch(false)}
        details={<p>将删除：{[...sel].map((i) => <code key={i}>{i} </code>)}</p>}
        onConfirm={async () => {
          setBatch(false);
          const o = await api.post("/api/memory/batch-delete", { workspace_id: ws, memory_ids: [...sel], confirm: true });
          setNotice({ label: `删除（${String(bodyOf<{ deleted_count?: number }>(o)?.deleted_count ?? "?")} 条已删除）`, o });
          if (o.kind !== "http" || o.status >= 300) setNotice({ label: describeFailure(o), o });
          setSel(new Set()); reload();
        }} /> : null}
    </>
  );
}

/** 记忆详情：点标题读全文；待确认 / 冲突可「确认生效」，任何非已驳回记录可「驳回」；每次操作后回读 GET /api/memory/<id>，以服务端状态为准。 */
const MEMORY_TYPE_ZH: Record<string, string> = { knowledge_note: "知识笔记", preference: "偏好", fact: "事实", procedure: "操作规程", decision: "决定" };
const MEMORY_SCOPE_ZH: Record<string, string> = { workspace: "工作区", session: "会话", user: "用户", global: "全局" };
const MEMORY_SOURCE_ZH: Record<string, string> = { agent_suggestion: "Agent 建议", user: "用户手动", user_confirmed: "用户确认", import: "导入" };
/** 中文名在前，原值保留在括号里；未知取值原样显示。 */
function memZh(map: Record<string, string>, v?: string) { return !v ? "未上报" : map[v] ? `${map[v]}（${v}）` : v; }

function MemoryDetail({ ws, memoryId, onClose, onChanged }: { ws: string; memoryId: string; onClose: () => void; onChanged: () => void }) {
  const [rec, reload] = useApi(`/api/memory/${enc(memoryId)}`, { workspace_id: ws });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; outcome?: HttpOutcome } | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  /** 操作后 GET 回读到的状态：在详情重新加载完成前就用它，避免回读提示与状态胶囊短暂不一致。 */
  const [readbackStatus, setReadbackStatus] = useState<string | null>(null);
  const act = async (action: "confirm" | "reject") => {
    setBusy(true); setNote(null); setReadbackStatus(null);
    const r = await reviewMemory(ws, memoryId, action);
    const after = r.after.kind === "written" ? String(r.after.record.status ?? "未上报") : null;
    const label = action === "confirm" ? "确认" : "驳回";
    if (r.ok && after) setReadbackStatus(after);
    setNote(r.ok
      ? { ok: true, text: after ? `${label}已受理；回读状态：${MEMORY_STATUS_LABEL[after] ?? after}` : `${label}已受理；回读未拿到记录，状态未知` }
      : { ok: false, text: `${label}未生效：${r.message ?? "服务端拒绝"}`, outcome: r.outcome });
    setBusy(false); reload(); onChanged();
  };
  return (
    <Drawer title="记忆详情" onClose={onClose} testId="memory-detail">
      <LoadState value={rec} onReload={reload}>{(d) => {
        const m = ((d as { record?: MemRec; memory?: MemRec }).record ?? (d as { memory?: MemRec }).memory ?? {}) as MemRec;
        const st = readbackStatus ?? m.status ?? "";
        return (
          <>
            <h3 data-testid="memory-detail-title">{m.summary || "（无标题）"}</h3>
            <p><Chip tone={st === "conflict" ? "warn" : st === "active" ? "ok" : st === "rejected" ? "danger" : "info"}><span data-testid="memory-detail-status">{MEMORY_STATUS_LABEL[st] ?? (st || "未上报")}</span></Chip></p>
            <div className="memory-full" data-testid="memory-detail-content">{m.content || <span className="muted">内容为空</span>}</div>
            <KeyValues items={[["类型", memZh(MEMORY_TYPE_ZH, m.memory_type)], ["范围", memZh(MEMORY_SCOPE_ZH, m.scope)], ["来源", memZh(MEMORY_SOURCE_ZH, m.source)], ["创建", fmtTime(m.created_at)], ["更新", fmtTime(m.updated_at)], ["memory_id", <code key="i">{m.memory_id}</code>]]} />
            <div className="row-actions">
              {st === "pending" || st === "conflict" ? <Button variant="primary" disabled={busy} onClick={() => void act("confirm")} data-testid="memory-confirm">确认生效</Button> : null}
              {st && st !== "rejected" ? <Button disabled={busy} onClick={() => setConfirmReject(true)} data-testid="memory-reject">驳回</Button> : null}
            </div>
            {note ? (note.ok ? <p className="readback-note" role="status" data-testid="memory-review-readback">{note.text}</p> : <><p className="readback-note is-warn" role="alert" data-testid="memory-review-readback">{note.text}</p>{note.outcome ? <FailureNote outcome={note.outcome} /> : null}</>) : null}
            <RawData value={m} label="记录原文" />
            {confirmReject ? <ConfirmDialog title="驳回这条记忆？" confirmLabel="驳回" details={<p>驳回后这条记忆不再参与检索（状态变为「已拒绝」），记录保留可查。</p>}
              onCancel={() => setConfirmReject(false)} onConfirm={() => { setConfirmReject(false); void act("reject"); }} /> : null}
          </>
        );
      }}</LoadState>
    </Drawer>
  );
}
