import './FileWorkspace.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileGovernance } from './FileGovernance';
import { SourceBrowser } from './SourceBrowser';
import { FileInspection } from './FileInspection';
import { knowledgeApi, storageApi } from '../../api';
import { apiRequest } from '../../api/client';
import { Button, DetailPanel, FilterBar, SearchInput } from '../../components/ui';
import { CodeBlock, EmptyState } from '../../components/common';
import { confirm } from '../../components/ConfirmDialog';
import { useToastStore } from '../../stores/toast';
import { useSessionStore } from '../../stores/session';
import { useNavigate } from '../../router';
import { formatFileSize } from '../../utils/format';
import type { ManagedFile } from '../../types';

export function FileWorkspace({ workspaceId, initialFile }: { workspaceId: string; initialFile?: ManagedFile | null }) {
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState('metadata');
  const [directory, setDirectory] = useState('*');
  const [directories, setDirectories] = useState<string[]>([]);
  const [sort, setSort] = useState('created');
  const [view, setView] = useState('files');
  const [cursor, setCursor] = useState('');
  const [nextCursor, setNextCursor] = useState('');
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ManagedFile | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [content, setContent] = useState('');
  const [offset, setOffset] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [operationResults, setOperationResults] = useState<Array<{ name: string; error?: string; result?: string }>>([]);
  const toast = useToastStore(state => state.show);
  const navigate = useNavigate();
  const recycle = view === 'recycle';
  const selectedIdentity = useRef('');
  selectedIdentity.current = `${workspaceId}/${selected?.file_id || ''}/${view}`;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { setSelected(null); setChecked([]); setCursor(''); setFiles([]); }, [workspaceId, query, view, searchMode, directory, sort]);
  useEffect(() => { if (initialFile) setSelected(initialFile); }, [initialFile]);
  useEffect(() => {
    if (["sources", "governance"].includes(view)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError('');
      const request = searchMode === 'content' && query.trim() && !recycle ? apiRequest<{ files: ManagedFile[]; total: number; next_cursor: string; folders?: string[] }>({ method: 'GET', url: '/storage/search', params: { workspace_id: workspaceId, q: query, cursor, limit: 50, view: recycle ? 'all' : view, folder: directory === '*' ? undefined : directory }, signal: controller.signal }) : storageApi.page(workspaceId, { sort, folder: directory === '*' ? undefined : directory, q: query, view: recycle ? 'all' : view, lifecycle: recycle ? 'soft_deleted' : 'active', cursor, limit: 50 }, controller.signal);
      request
        .then(result => { if (!controller.signal.aborted) {
          setFiles(result.files); setTotal(result.total); setNextCursor(result.next_cursor); if (result.folders) setDirectories(result.folders);
          setSelected(current => { const fresh = result.files.find(file => file.file_id === current?.file_id); return fresh && JSON.stringify(fresh) !== JSON.stringify(current) ? fresh : current; });
        } })
        .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, query, view, recycle, cursor, revision, searchMode, directory, sort]);
  useEffect(() => {
    const events = storageApi.events(workspaceId);
    events.addEventListener('storage_changed', refresh);
    return () => events.close();
  }, [workspaceId, refresh]);
  useEffect(() => {
    setContent(''); setOffset(null); setName(selected?.original_name || ''); setFolder(String(selected?.metadata.folder || ''));
    if (!selected || selected.binary || recycle) return;
    const controller = new AbortController();
    storageApi.content(workspaceId, selected.file_id, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setContent(result.content); setOffset(result.next_offset ?? null); } })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [selected, workspaceId, recycle]);
  async function upload(batch: File[]) {
    setBusy(true); setOperationResults([]);
    for (const file of batch) {
      const form = new FormData(); form.append('file', file); form.append('artifact_type', 'user_upload');
      try {
        await apiRequest({ method: 'POST', url: `/workspaces/${workspaceId}/artifacts/upload`, data: form });
        setOperationResults(items => [...items, { name: file.name, result: '已导入' }]);
      } catch (reason) { setOperationResults(items => [...items, { name: file.name, error: String((reason as Error).message || reason) }]); }
    }
    setBusy(false); refresh();
  }
  async function remove(permanent = false) {
    const ids = checked.length ? checked : selected ? [selected.file_id] : [];
    if (!ids.length) return;
    setBusy(true); setError('');
    let impact: ManagedFile[];
    try { impact = (await Promise.all(ids.map(id => storageApi.metadata(workspaceId, id)))).map(result => result.file); }
    catch (reason) { setError(`无法核对操作影响：${String((reason as Error).message || reason)}`); setBusy(false); return; }
    const uses = impact.reduce((total, file) => total + file.reference_count, 0);
    if (!await confirm({ title: permanent ? '永久清除原件？' : '移入回收站？',
      body: `${ids.length} 个文件，涉及 ${uses} 处使用关系。${permanent ? '原始字节将无法恢复；历史使用记录保留并显示原件已清除。' : '文件可以恢复，来源与使用记录保留；回收期间使用方无法读取原件。'}`,
      confirmLabel: permanent ? '永久清除' : '移入回收站', destructive: true })) { setBusy(false); return; }
    setOperationResults([]);
    setBusy(true);
    const results = await Promise.allSettled(ids.map(id => storageApi.delete(workspaceId, id, permanent)));
    setOperationResults(results.map((result, index) => ({ name: impact[index].original_name, result: result.status === 'fulfilled' ? (permanent ? '已永久清除' : '已移入回收站') : undefined, error: result.status === 'rejected' ? String(result.reason.message || result.reason) : undefined })));
    const done = ids.filter((_id, index) => results[index].status === 'fulfilled');
    setChecked(items => items.filter(id => !done.includes(id)));
    if (selected && done.includes(selected.file_id)) setSelected(null);
    toast({ kind: done.length === ids.length ? 'success' : 'warning', title: '文件处理结果', body: `${done.length} 个完成，${ids.length - done.length} 个失败` });
    setBusy(false); refresh();
  }
  async function restore() {
    if (!selected) return;
    try { await storageApi.restore(workspaceId, selected.file_id); setSelected(null); refresh(); }
    catch (reason) { setError(String((reason as Error).message || reason)); }
  }
  async function organize() {
    if (!selected) return;
    try { await storageApi.organize(workspaceId, selected.file_id, { name, folder }); setSelected(null); refresh(); }
    catch (reason) { setError(String((reason as Error).message || reason)); }
  }
  async function addToKnowledge() {
    if (!selected || busy) return;
    const identity = selectedIdentity.current;
    setBusy(true); setError('');
    try {
      const result = await knowledgeApi.upload(workspaceId, { file_id: selected.file_id }, { title: selected.original_name });
      if (selectedIdentity.current === identity) {
        toast({ kind: 'success', title: '已加入知识库', body: '知识来源复用当前原件' });
        navigate(`/knowledge?source_id=${encodeURIComponent(result.source.source_id)}`);
      }
    } catch (reason) { if (selectedIdentity.current === identity) setError(String((reason as Error).message || reason)); }
    finally { setBusy(false); refresh(); }
  }
  const fileUrl = (file: ManagedFile, action: string) => `/api/storage/files/${encodeURIComponent(file.file_id)}/${action}?workspace_id=${encodeURIComponent(workspaceId)}`;
  return <section className="file-workspace" data-testid="file-workspace">
    <FilterBar>
      {Object.entries({ files: '资料与文件', sources: '工作目录', deliverables: '交付物', history: '历史版本', evidence: '过程资料', recycle: '回收站', governance: '核对与备份' }).map(([key, label]) =>
        <Button key={key} size="sm" variant={view === key ? 'selected' : 'default'} onClick={() => setView(key)}>{label}</Button>)}
      <div className="spacer" /><span>{total} 个文件</span>
    </FilterBar>
    {view === "sources" ? <SourceBrowser workspaceId={workspaceId} /> : view === "governance" ? <FileGovernance workspaceId={workspaceId} /> : <>
    <FilterBar><SearchInput value={query} onChange={event => setQuery(event.target.value)} placeholder={searchMode === 'content' ? '搜索正文（原文／已建索引文档）' : '搜索名称、路径或来源'} />
      <select className="select" aria-label="搜索范围" value={searchMode} onChange={event => setSearchMode(event.target.value)}><option value="metadata">名称与路径</option><option value="content">正文</option></select>
      <select className="select" aria-label="文件目录" value={directory} onChange={event => setDirectory(event.target.value)}><option value="*">所有目录</option>{directories.map(folder => <option key={folder} value={folder}>{folder || '工作区根目录'}</option>)}</select>
      <select className="select" aria-label="文件排序" value={sort} onChange={event => setSort(event.target.value)}><option value="created">最近创建</option><option value="name">文件名</option><option value="size">文件大小</option></select>
      <label className="btn sm">导入多个文件<input type="file" multiple disabled={busy} className="file-upload-input" onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} /></label>
      <Button size="sm" disabled={!checked.length || busy} onClick={() => void remove(recycle)}>处理已选 {checked.length} 项</Button>
      <Button size="sm" onClick={refresh}>刷新</Button>
    </FilterBar>
    {error && <div className="callout err" role="alert">{error}</div>}
    {operationResults.length > 0 && <ul aria-label="逐项处理结果">{operationResults.map((item, index) => <li key={index}>{item.name}：{item.error || item.result}</li>)}</ul>}
    <div className="split-shell data-split" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void upload(Array.from(event.dataTransfer.files)); }}>
      <aside className="data-list" aria-label="文件空间列表">
        {files.map(file => <div key={file.file_id} className={`data-row file-space-row ${selected?.file_id === file.file_id ? 'selected' : ''}`}>
          <input type="checkbox" aria-label={`选择 ${file.original_name}`} checked={checked.includes(file.file_id)} onChange={event => setChecked(items => event.target.checked ? [...items, file.file_id] : items.filter(id => id !== file.file_id))} />
          <button type="button" className="file-space-select" onClick={() => setSelected(file)}><b>{file.original_name}</b><small>{String(file.metadata.folder || '工作区')} · {file.file_kind} · {formatFileSize(file.size_bytes)}</small>{file.search_hit && <small>第 {file.search_hit.line} 行：{file.search_hit.snippet}</small>}</button>
        </div>)}
        {!files.length && <EmptyState text="没有符合条件的文件" hint="导入资料或切换筛选条件" />}
        <div className="actions-row"><Button size="sm" disabled={!cursor} onClick={() => setCursor('')}>首页</Button><Button size="sm" disabled={!nextCursor} onClick={() => setCursor(nextCursor)}>下一页</Button></div>
      </aside>
      {!selected ? <DetailPanel empty={{ text: '选择文件', hint: '预览、下载、组织资料并查看来源' }} /> : <DetailPanel title={selected.original_name} onClose={() => setSelected(null)} actions={<>
        {recycle ? <><Button size="sm" onClick={() => void restore()}>恢复</Button><Button size="sm" variant="danger-ghost" onClick={() => void remove(true)}>永久清除</Button></> : <>
          <a className="btn sm" href={fileUrl(selected, 'download')}>下载原件</a><Button size="sm" disabled={busy} onClick={() => void addToKnowledge()}>加入知识库</Button><Button size="sm" variant="danger-ghost" onClick={() => void remove()}>移入回收站</Button>
        </>}
      </>}>
        <dl className="file-space-properties"><dt>路径</dt><dd>{selected.path || '托管文件'}</dd><dt>文件身份</dt><dd>{selected.file_id}</dd><dt>来源</dt><dd>{selected.source}</dd><dt>使用关系</dt><dd>{selected.reference_count} 处</dd></dl>
        {!recycle && <>
          {selected.capabilities?.preview === 'image' && <img className="file-space-preview" src={fileUrl(selected, 'preview')} alt={selected.original_name} />}
          {selected.capabilities?.preview === 'pdf' && <iframe className="file-space-pdf" src={fileUrl(selected, 'preview')} title={selected.original_name} />}
          {selected.capabilities?.media === 'audio' && <audio controls src={fileUrl(selected, 'preview')} />}
          {selected.capabilities?.media === 'video' && <video className="file-space-preview" controls src={fileUrl(selected, 'preview')} />}
          {['csv', 'xlsx', 'docx', 'pptx', 'pdf', 'zip', 'tar'].includes(selected.file_kind) && <FileInspection key={selected.file_id} workspaceId={workspaceId} fileId={selected.file_id} kind={selected.file_kind} />}
          {content && <CodeBlock>{content}</CodeBlock>}
          {offset !== null && <Button size="sm" onClick={() => { const identity = selectedIdentity.current; apiRequest<{ content: string; next_offset?: number }>({ method: 'GET', url: `/storage/files/${selected.file_id}/content`, params: { workspace_id: workspaceId, offset } }).then(result => { if (selectedIdentity.current === identity) { setContent(value => value + result.content); setOffset(result.next_offset ?? null); } }).catch(reason => { if (selectedIdentity.current === identity) setError(String(reason.message || reason)); }); }}>继续读取</Button>}
          <fieldset className="file-space-organize"><legend>名称与目录</legend><label>文件名<input value={name} onChange={event => setName(event.target.value)} /></label><label>目录<input value={folder} placeholder="例如 项目/资料" onChange={event => setFolder(event.target.value)} /></label><Button size="sm" onClick={() => void organize()}>保存</Button></fieldset>
        </>}
        {selected.references.map((ref, index) => <p key={index}>{ref.owner_type} · {ref.relation} · {ref.owner_id}
          {ref.owner_type === 'message' && typeof ref.metadata?.session_id === 'string' && <Button size="sm" onClick={() => { useSessionStore.getState().setCurrentSession(String(ref.metadata?.session_id)); navigate('/workbench'); }}>打开使用会话</Button>}
          {ref.owner_type === 'knowledge_source' && <Button size="sm" onClick={() => navigate(`/knowledge?source_id=${encodeURIComponent(ref.owner_id)}`)}>打开知识来源</Button>}
          {ref.owner_type === 'artifact' && <Button size="sm" onClick={() => navigate(`/data?artifact_id=${encodeURIComponent(ref.owner_id)}`)}>打开产出记录</Button>}
        </p>)}
        {selected.run_id && <Button size="sm" onClick={() => navigate(`/runs?focus=${encodeURIComponent(selected.run_id)}`)}>查看来源任务</Button>}
        {selected.session_id && <Button size="sm" onClick={() => { useSessionStore.getState().setCurrentSession(selected.session_id); navigate("/workbench"); }}>查看来源会话</Button>}
      </DetailPanel>}
    </div></>}
  </section>;
}
