import { useState } from "react";
import { api, bodyOf, describeFailure, enc, uploadMultipart } from "../../api/client";
import { useShell } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/EmptyState";
import type { HttpOutcome } from "../../contracts/auth";
import { NAMES } from "../../contracts/naming";
import { MemoryWriteView } from "../../kit/MemoryWriteView";
import { stableMemoryId, writeMemory, type MemoryWriteState } from "../../kit/memoryWrite";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, ConfirmDialog, Drawer, FailureNote, JsonBlock, KeyValues, LoadState, PreviewApply, ReceiptNote, Table, Tabs, fmtTime } from "../../kit/ui";
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

interface FileRec { file_id: string; original_name?: string; name?: string; filename?: string; folder?: string; size_bytes?: number; mime_type?: string; lifecycle?: string; created_at?: string; logical_type?: string }
const fileName = (f: FileRec) => f.original_name ?? f.name ?? f.filename ?? f.file_id;

function FilesView({ ws }: { ws: string }) {
  const [lifecycle, setLifecycle] = useState<"active" | "trash">("active");
  const [q, setQ] = useState("");
  const [files, reload] = useApi("/api/storage/files", { workspace_id: ws, lifecycle, q });
  const [open, setOpen] = useState<FileRec | null>(null);
  const [view, setView] = useState<"list" | "sources" | "governance">("list");
  return (
    <>
      <div className="row-actions">
        <Tabs label="文件视图" current={view} onChange={setView} tabs={[{ key: "list", label: "托管文件" }, { key: "sources", label: "来源浏览" }, { key: "governance", label: "治理" }]} />
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
                { key: "folder", label: "文件夹", render: (f) => f.folder ?? "—" },
                { key: "type", label: "类型", render: (f) => f.logical_type ?? f.mime_type ?? "—" },
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
  const [content] = useApi(view === "preview" ? `${base}/content` : null, { workspace_id: ws, limit: 20000 });
  const [inspect] = useApi(view === "inspect" ? `${base}/inspect` : null, { workspace_id: ws });
  const [name, setName] = useState(fileName(file));
  const [folder, setFolder] = useState(file.folder ?? "");
  const [result, setResult] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <Drawer title={fileName(file)} onClose={onClose} testId="file-detail">
      <LoadState value={meta} onReload={reloadMeta}>{(d) => <KeyValues items={[["file_id", <code key="i">{file.file_id}</code>], ["状态", String((d as { file?: { lifecycle?: string } }).file?.lifecycle ?? file.lifecycle ?? "未上报")]]} />}</LoadState>
      <div className="row-actions">
        <a className="btn" href={`${base}/download?workspace_id=${enc(ws)}`}>下载</a>
        {trash
          ? <Button onClick={async () => setResult({ label: "恢复", o: await api.post(`${base}/restore`, { workspace_id: ws }) })}>从回收站恢复</Button>
          : <Button variant="danger" onClick={() => setConfirmDelete(true)}>移入回收站</Button>}
      </div>
      {result ? (result.o.kind === "http" && result.o.status < 300 ? <ReceiptNote text={`${result.label}请求已提交`} /> : <FailureNote outcome={result.o} />) : null}
      <Tabs label="文件详情" current={view} onChange={setView} tabs={[{ key: "preview", label: "预览" }, { key: "inspect", label: "检查" }, { key: "edit", label: "整理" }]} />
      {view === "preview" ? <LoadState value={content}>{(d) => <pre className="json-block" data-testid="file-preview">{String((d as { content?: string }).content ?? JSON.stringify(d, null, 2))}</pre>}</LoadState> : null}
      {view === "inspect" ? <LoadState value={inspect}>{(d) => <JsonBlock value={d} />}</LoadState> : null}
      {view === "edit" ? (
        <form onSubmit={async (e) => { e.preventDefault(); const o = await api.patch(base, { workspace_id: ws, name, folder }); setResult({ label: "整理", o }); reloadMeta(); }}>
          <p className="muted">后端只支持改名与移动文件夹（PATCH name / folder），不支持在线改写文件内容。</p>
          <label className="field"><span>名称</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>文件夹</span><input value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
          <Button type="submit" variant="primary">保存并回读</Button>
        </form>
      ) : null}
      {confirmDelete ? <ConfirmDialog title="移入回收站？" details={<p>「{fileName(file)}」将移入回收站，可从回收站恢复。</p>} confirmLabel="移入回收站"
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
      <LoadState value={health} onReload={reload}>{(d) => <JsonBlock value={(d as { health?: unknown }).health ?? d} />}</LoadState>
      <PreviewApply label="提交对账（reconcile）" testId="reconcile"
        preview={() => api.post("/api/storage/reconcile", { workspace_id: ws, apply: false })}
        apply={() => api.post("/api/storage/reconcile", { workspace_id: ws, apply: true })}
        renderPreview={(b) => <JsonBlock value={b} />} />
      <PreviewApply label="引用迁移（migration）" testId="migration"
        preview={() => api.post("/api/storage/migration", { workspace_id: ws, apply: false })}
        apply={() => api.post("/api/storage/migration", { workspace_id: ws, apply: true })}
        renderPreview={(b) => <JsonBlock value={b} />} />
      <p className="muted">「封存（seal）」在基线后端没有独立接口；对账 / 迁移的 apply 前必须先预览。</p>
    </section>
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
        <form className="row-actions" onSubmit={async (e) => { e.preventDefault(); setHits(await api.get("/api/knowledge/search", { workspace_id: ws, q })); }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="检索知识" aria-label="检索知识" />
          <Button type="submit" disabled={!q.trim()}>检索</Button>
        </form>
      </div>
      {notice ? (notice.o.kind === "http" && notice.o.status < 300 ? <ReceiptNote text={`${notice.label}已提交`} /> : <FailureNote outcome={notice.o} />) : null}
      {hits ? (hits.kind === "http" && hits.status === 200 ? (
        <section className="card" data-testid="knowledge-hits"><h3>检索结果</h3>
          <ol>{(bodyOf<{ results?: { chunk_id?: string; text?: string; source_id?: string; score?: number }[] }>(hits)?.results ?? []).map((h, i) => <li key={h.chunk_id ?? i}><code>{h.source_id}</code> {h.text}</li>)}</ol>
        </section>
      ) : <FailureNote outcome={hits} />) : null}
      <LoadState value={sources} onReload={reload}>{() => (
        <Table testId="knowledge-table" rows={listOf<KSource>(sources, "sources")} rowKey={(s) => s.source_id} empty={<p className="muted">知识库为空。</p>}
          columns={[
            { key: "name", label: "来源", render: (s) => s.title ?? s.name ?? s.source_id },
            { key: "status", label: "索引状态", render: (s) => <><Chip tone={s.status === "failed" ? "danger" : s.status === "indexed" ? "ok" : "info"}>{KNOWLEDGE_STATUS_LABEL[s.status ?? ""] ?? s.status ?? "未上报"}</Chip>{reindexState[s.source_id] ? <span className="muted" data-testid="reindex-readback"> {reindexState[s.source_id]}</span> : null}</> },
            { key: "chunks", label: "片段", render: (s) => String(s.chunk_count ?? "—") },
            { key: "act", label: "", render: (s) => <span className="row-actions"><Button onClick={() => void reindex(s)}>重建索引</Button><Button variant="ghost" onClick={() => setDel(s)} data-testid="knowledge-delete">删除</Button></span> },
          ]} />
      )}</LoadState>
      {del ? <ConfirmDialog title="删除知识来源？" details={<p>将删除「{del.title ?? del.name ?? del.source_id}」及其索引片段。</p>} confirmLabel="删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const s = del; setDel(null); setNotice({ label: "删除", o: await api.del(`/api/knowledge/sources/${enc(s.source_id)}`, { workspace_id: ws }, { workspace_id: ws }) }); reload(); }} /> : null}
    </>
  );
}

interface MemRec { memory_id: string; summary?: string; content?: string; status?: string; scope?: string; memory_type?: string; updated_at?: string; metadata?: { conflict_memory_ids?: string[] } }
const MEMORY_STATUS_LABEL: Record<string, string> = { active: "生效中", pending: "待确认", conflict: "与已有记忆冲突", rejected: "已拒绝", expired: "已过期" };

function MemoryView({ ws }: { ws: string }) {
  const [list, reload] = useApi("/api/memory/list", { workspace_id: ws });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [writeState, setWriteState] = useState<MemoryWriteState>({ kind: "idle" });
  const [notice, setNotice] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [confirming, setConfirming] = useState<MemRec | null>(null);
  const records = listOf<MemRec>(list, "records");
  const draftKey = `${ws}:library:${draft.title}`;
  const blocked = writeState.kind === "unknown" || writeState.kind === "writing";
  return (
    <>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        setWriteState({ kind: "writing" });
        setWriteState(await writeMemory(ws, { memory_id: stableMemoryId(draftKey), title: draft.title, content: draft.content }));
        reload();
      }}>
        <h3>新增记忆</h3>
        <label className="field"><span>标题</span><input value={draft.title} onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setWriteState({ kind: "idle" }); }} /></label>
        <label className="field"><span>内容</span><textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={3} /></label>
        <Button type="submit" variant="primary" disabled={blocked || !draft.content.trim()} data-testid="memory-save">写入并回读</Button>
        <MemoryWriteView ws={ws} state={writeState} onState={setWriteState} />
      </form>
      {notice ? (notice.o.kind === "http" && notice.o.status < 300 ? <ReceiptNote text={`${notice.label}已提交`} /> : <FailureNote outcome={notice.o} />) : null}
      {sel.size ? <Button variant="danger" onClick={() => setBatch(true)} data-testid="memory-batch-delete">删除所选（{sel.size}）</Button> : null}
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="memory-table" rows={records} rowKey={(m) => m.memory_id} selectable selected={sel} onSelect={setSel} empty={<p className="muted">还没有记忆。</p>}
          columns={[
            { key: "summary", label: "记忆", render: (m) => m.summary || m.content?.slice(0, 60) || m.memory_id },
            { key: "status", label: "状态", render: (m) => <Chip tone={m.status === "conflict" ? "warn" : m.status === "active" ? "ok" : "info"}>{MEMORY_STATUS_LABEL[m.status ?? ""] ?? m.status ?? "未上报"}</Chip> },
            { key: "conflict", label: "冲突", render: (m) => m.status === "conflict" ? <span data-testid="memory-conflict-hint">与 {(m.metadata?.conflict_memory_ids ?? []).join("、") || "已有记忆"} 冲突 <Button onClick={() => setConfirming(m)}>采用这条</Button></span> : "—" },
            { key: "id", label: "memory_id", render: (m) => <code>{m.memory_id}</code> },
            { key: "time", label: "更新", render: (m) => fmtTime(m.updated_at), sortValue: (m) => m.updated_at ?? "" },
          ]} />
      )}</LoadState>
      {confirming ? <ConfirmDialog title="采用这条记忆？" danger={false} confirmLabel="确认采用" onCancel={() => setConfirming(null)}
        details={<><p>确认后这条将生效，冲突的记忆：{(confirming.metadata?.conflict_memory_ids ?? []).map((i) => <code key={i}>{i} </code>)}。</p><JsonBlock value={confirming} /></>}
        onConfirm={async () => { const m = confirming; setConfirming(null); setNotice({ label: "确认", o: await api.post("/api/memory/confirm", { workspace_id: ws, memory_id: m.memory_id }) }); reload(); }} /> : null}
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
