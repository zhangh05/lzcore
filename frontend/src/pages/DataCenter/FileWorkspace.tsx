import './FileWorkspace.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileGovernance } from './FileGovernance';
import { SourceBrowser } from './SourceBrowser';
import { FileInspection } from './FileInspection';
import { knowledgeApi, storageApi } from '../../api';
import { apiRequest } from '../../api/client';
import { Button, DetailPanel, FileKindBadge, FilterSelect, InfoList, OperationResults, SearchInput, SelectionBar, type OperationResult } from '../../components/ui';
import { CodeBlock, EmptyState } from '../../components/common';
import { confirm } from '../../components/ConfirmDialog';
import { useToastStore } from '../../stores/toast';
import { useSessionStore } from '../../stores/session';
import { useNavigate } from '../../router';
import { IconAlert, IconDownload, IconFolder, IconPlus, IconRefresh, IconTrash, IconUndo } from '../../components/Icon';
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
  const [operationResults, setOperationResults] = useState<OperationResult[]>([]);
  const [dragging, setDragging] = useState(false);
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
  const pageIds = files.map(file => file.file_id);
  const allChecked = pageIds.length > 0 && pageIds.every(id => checked.includes(id));
  const someChecked = !allChecked && pageIds.some(id => checked.includes(id));
  const continueReading = () => {
    if (!selected || offset === null) return;
    const identity = selectedIdentity.current;
    apiRequest<{ content: string; next_offset?: number }>({ method: 'GET', url: `/storage/files/${selected.file_id}/content`, params: { workspace_id: workspaceId, offset } })
      .then(result => { if (selectedIdentity.current === identity) { setContent(value => value + result.content); setOffset(result.next_offset ?? null); } })
      .catch(reason => { if (selectedIdentity.current === identity) setError(String(reason.message || reason)); });
  };
  const viewButton = ([key, label]: [string, string]) => (
    <Button key={key} size="sm" variant={view === key ? 'selected' : 'default'} aria-pressed={view === key} onClick={() => setView(key)}>{label}</Button>
  );
  return <section className="file-workspace" data-testid="file-workspace">
    <nav className="file-space-nav" aria-label="文件视图">
      <div className="file-space-nav-group" role="group" aria-label="文件集合">{PRIMARY_VIEWS.map(viewButton)}</div>
      <span className="file-space-nav-sep" aria-hidden="true" />
      <div className="file-space-nav-group" role="group" aria-label="维护">{MAINTENANCE_VIEWS.map(viewButton)}</div>
    </nav>
    {view === "sources" ? <SourceBrowser workspaceId={workspaceId} /> : view === "governance" ? <FileGovernance workspaceId={workspaceId} /> : <>
    <div className="file-space-toolbar" role="search" aria-label="查找文件">
      <SearchInput className="file-space-search" value={query} onClear={() => setQuery('')} onChange={event => setQuery(event.target.value)} placeholder={searchMode === 'content' ? '搜索正文（原文／已建索引文档）' : '搜索名称、路径或来源'} aria-label={searchMode === 'content' ? '搜索文件正文' : '搜索文件'} />
      <FilterSelect label="范围" aria-label="搜索范围" value={searchMode} onChange={event => setSearchMode(event.target.value)}><option value="metadata">名称与路径</option><option value="content">正文</option></FilterSelect>
      <FilterSelect label="目录" aria-label="文件目录" value={directory} onChange={event => setDirectory(event.target.value)}><option value="*">所有目录</option>{directories.map(folder => <option key={folder} value={folder}>{folder || '工作区根目录'}</option>)}</FilterSelect>
      <FilterSelect label="排序" aria-label="文件排序" value={sort} onChange={event => setSort(event.target.value)}><option value="created">最近创建</option><option value="name">文件名</option><option value="size">文件大小</option></FilterSelect>
      <div className="file-space-actions">
        <Button size="sm" iconOnly aria-label="刷新" title="刷新" onClick={refresh}><IconRefresh size={15} aria-hidden="true" /></Button>
        <label className={`btn sm primary file-space-import${busy ? ' is-busy' : ''}`}><IconPlus size={14} aria-hidden="true" />{busy ? '正在处理…' : '导入多个文件'}<input type="file" multiple disabled={busy} className="file-upload-input" onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} /></label>
      </div>
    </div>
    {error && <div className="callout err file-space-error" role="alert"><IconAlert size={16} aria-hidden="true" /><span>{error}</span><Button size="sm" onClick={() => { setError(''); refresh(); }}>重试</Button></div>}
    <OperationResults items={operationResults} busy={busy} onDismiss={() => setOperationResults([])} />
    <div className={`split-shell data-split file-space-split${dragging ? ' is-dragging' : ''}`}
      onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void upload(Array.from(event.dataTransfer.files)); }}>
      <aside className="data-list file-space-list" aria-label="文件空间列表">
        <div className="file-list-head">
          <input type="checkbox" aria-label="选择当前页全部文件" disabled={!files.length} checked={allChecked}
            ref={element => { if (element) element.indeterminate = someChecked; }}
            onChange={() => setChecked(items => allChecked ? items.filter(id => !pageIds.includes(id)) : Array.from(new Set([...items, ...pageIds])))} />
          <strong>{recycle ? "回收站" : "文件列表"}</strong><span>{total} 个文件</span>
        </div>
        <div className="file-list-scroll">
        {files.map(file => {
          const isSelected = selected?.file_id === file.file_id;
          return <div key={file.file_id} className={`data-row file-space-row${isSelected ? ' selected' : ''}${checked.includes(file.file_id) ? ' checked' : ''}`}>
            <input type="checkbox" aria-label={`选择 ${file.original_name}`} checked={checked.includes(file.file_id)} onChange={event => setChecked(items => event.target.checked ? [...items, file.file_id] : items.filter(id => id !== file.file_id))} />
            <FileKindBadge kind={file.file_kind} name={file.original_name} />
            <button type="button" className="file-space-select" aria-current={isSelected ? 'true' : undefined} onClick={() => setSelected(file)}>
              <b>{file.original_name}</b>
              <small>{file.file_kind.toUpperCase()} · {formatFileSize(file.size_bytes)}{file.reference_count > 0 ? ` · ${file.reference_count} 处使用` : ''}</small>
              {Boolean(file.metadata.folder) && <span className="file-row-folder"><IconFolder size={12} aria-hidden="true" />{String(file.metadata.folder)}</span>}
              {file.search_hit && <small className="file-row-hit">第 {file.search_hit.line} 行：{file.search_hit.snippet}</small>}
            </button>
          </div>;
        })}
        {!files.length && <EmptyState text={query || directory !== '*' ? "没有符合条件的文件" : recycle ? "回收站是空的" : "没有符合条件的文件"} hint={recycle ? "移入回收站的文件会在这里保留，可以恢复或永久清除" : "导入资料、把文件拖到这里，或切换筛选条件"} />}
        </div>
        <SelectionBar count={checked.length} note={recycle ? '将永久清除原件' : '将移入回收站，可恢复'} onClear={() => setChecked([])}>
          <Button size="sm" variant={recycle ? 'danger' : 'default'} disabled={busy} onClick={() => void remove(recycle)}>处理已选 {checked.length} 项</Button>
        </SelectionBar>
        <div className="file-list-pagination"><Button size="sm" disabled={!cursor} onClick={() => setCursor('')}>首页</Button><span>{files.length ? `本页 ${files.length} 项` : ''}</span><Button size="sm" disabled={!nextCursor} onClick={() => setCursor(nextCursor)}>下一页</Button></div>
      </aside>
      {!selected ? <DetailPanel className="file-preview-empty" empty={{ text: '选择文件', hint: '预览、下载、组织资料并查看来源。也可以把文件直接拖到列表中导入。' }} /> : <DetailPanel className="file-preview-panel" title={selected.original_name} subtitle={`${selected.file_kind.toUpperCase()} · ${formatFileSize(selected.size_bytes)}${selected.metadata.folder ? ` · ${String(selected.metadata.folder)}` : ''}`} onClose={() => setSelected(null)} actions={<>
        {recycle ? <><Button size="sm" variant="primary" onClick={() => void restore()}><IconUndo size={14} aria-hidden="true" />恢复</Button><Button size="sm" variant="danger-ghost" onClick={() => void remove(true)}><IconTrash size={14} aria-hidden="true" />永久清除</Button></> : <>
          <a className="btn sm primary" href={fileUrl(selected, 'download')}><IconDownload size={14} aria-hidden="true" />下载原件</a><Button size="sm" disabled={busy} onClick={() => void addToKnowledge()}>加入知识库</Button><Button size="sm" variant="danger-ghost" onClick={() => void remove()}><IconTrash size={14} aria-hidden="true" />移入回收站</Button>
        </>}
      </>}>
        <InfoList className="file-preview-facts" items={[
          ['路径', selected.path || '托管文件', true],
          ['来源', fileSourceLabel(selected.source)],
          ['使用关系', selected.reference_count ? `${selected.reference_count} 处` : '暂无使用'],
        ]} />
        {recycle ? <p className="callout warn file-space-note">文件在回收站中，使用方暂时无法读取原件。恢复后来源与使用记录保持不变。</p> : <section className="file-preview-content" aria-label="内容预览">
          {selected.capabilities?.preview === 'image' && <img className="file-space-preview" src={fileUrl(selected, 'preview')} alt={selected.original_name} />}
          {selected.capabilities?.preview === 'pdf' && <iframe className="file-space-pdf" src={fileUrl(selected, 'preview')} title={selected.original_name} />}
          {selected.capabilities?.media === 'audio' && <audio controls src={fileUrl(selected, 'preview')} />}
          {selected.capabilities?.media === 'video' && <video className="file-space-preview" controls src={fileUrl(selected, 'preview')} />}
          {['csv', 'xlsx', 'docx', 'pptx', 'pdf', 'zip', 'tar'].includes(selected.file_kind) && <FileInspection key={selected.file_id} workspaceId={workspaceId} fileId={selected.file_id} kind={selected.file_kind} />}
          {content && <><h4>内容预览</h4><CodeBlock>{content}</CodeBlock></>}
          {offset !== null && <Button size="sm" onClick={continueReading}>继续读取</Button>}
          {selected.binary && !selected.capabilities?.preview && !selected.capabilities?.media && <p className="dm-muted">二进制原件不提供文本预览，可以下载后使用专用工具查看。</p>}
        </section>}
        {(selected.references.length > 0 || selected.run_id || selected.session_id) && <section className="file-space-usage" aria-label="使用关系">
          <h4>使用关系</h4>
          <ul>
            {selected.references.map((ref, index) => <li key={index}>
              <span><b>{referenceOwnerLabel(ref.owner_type)}</b><small>{ref.relation} · {ref.owner_id}</small></span>
              {ref.owner_type === 'message' && typeof ref.metadata?.session_id === 'string' && <Button size="sm" variant="ghost" onClick={() => { useSessionStore.getState().setCurrentSession(String(ref.metadata?.session_id)); navigate('/workbench'); }}>打开使用会话</Button>}
              {ref.owner_type === 'knowledge_source' && <Button size="sm" variant="ghost" onClick={() => navigate(`/knowledge?source_id=${encodeURIComponent(ref.owner_id)}`)}>打开知识来源</Button>}
              {ref.owner_type === 'artifact' && <Button size="sm" variant="ghost" onClick={() => navigate(`/data?artifact_id=${encodeURIComponent(ref.owner_id)}`)}>打开产出记录</Button>}
            </li>)}
          </ul>
          {(selected.run_id || selected.session_id) && <div className="file-space-origin">
            {selected.run_id && <Button size="sm" onClick={() => navigate(`/runs?focus=${encodeURIComponent(selected.run_id)}`)}>查看来源任务</Button>}
            {selected.session_id && <Button size="sm" onClick={() => { useSessionStore.getState().setCurrentSession(selected.session_id); navigate("/workbench"); }}>查看来源会话</Button>}
          </div>}
        </section>}
        {!recycle && <fieldset className="file-space-organize"><legend>名称与目录</legend><label>文件名<input className="input" value={name} onChange={event => setName(event.target.value)} /></label><label>目录<input className="input" value={folder} placeholder="例如 项目/资料" onChange={event => setFolder(event.target.value)} /></label><Button size="sm" disabled={!name.trim() || (name === selected.original_name && folder === String(selected.metadata.folder || ''))} onClick={() => void organize()}>保存</Button></fieldset>}
        <details className="file-space-metadata"><summary>文件信息与来源 · {selected.reference_count} 处使用</summary><InfoList className="file-space-properties" items={[['文件身份', selected.file_id, true], ['来源', fileSourceLabel(selected.source)], ['使用关系', `${selected.reference_count} 处`]]} /></details>
      </DetailPanel>}
    </div></>}
  </section>;
}

const PRIMARY_VIEWS: Array<[string, string]> = [['files', '资料与文件'], ['deliverables', '交付物'], ['history', '历史版本'], ['evidence', '过程资料']];
const MAINTENANCE_VIEWS: Array<[string, string]> = [['sources', '工作目录'], ['recycle', '回收站'], ['governance', '核对与备份']];

function referenceOwnerLabel(type: string): string {
  return ({ message: '会话消息', session: '会话', run: '执行任务', artifact: '任务产出', knowledge_source: '知识来源', job: '定时任务' } as Record<string, string>)[type] || type;
}

function fileSourceLabel(source: string): string {
  return ({ user_upload: "用户导入", upload: "用户导入", artifact_upload: "用户导入", knowledge_import: "知识库导入", module_output: "模块产出", agent: "智能体生成", task: "任务产出", knowledge: "知识资料", workspace: "工作目录" } as Record<string, string>)[source] || source;
}
