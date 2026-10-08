import { useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';
import { Button, DetailPanel, InfoList } from '../../components/ui';
import { CodeBlock, EmptyState } from '../../components/common';
import { IconAlert, IconChevronLeft, IconDocument, IconFolder, IconLink } from '../../components/Icon';
import { formatFileSize } from '../../utils/format';
import { confirm } from '../../components/ConfirmDialog';

interface Entry { name: string; filepath: string; type: string; accessible: boolean; size_bytes?: number; }
interface Tree { entries: Entry[]; next_offset: number | null; total: number; }
export function SourceBrowser({ workspaceId }: { workspaceId: string }) {
  const [path, setPath] = useState('files/data');
  const [offset, setOffset] = useState(0);
  const [tree, setTree] = useState<Tree | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    apiRequest<Tree>({ method: 'GET', url: '/storage/sources', params: { workspace_id: workspaceId, filepath: path, offset }, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTree(data); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [workspaceId, path, offset, revision]);
  useEffect(() => {
    if (!selected || selected.type !== 'file') return;
    const controller = new AbortController();
    apiRequest<{ content: string; truncated: boolean }>({ method: 'GET', url: '/storage/sources/content', params: { workspace_id: workspaceId, filepath: selected.filepath }, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setText(data.content + (data.truncated ? '\n…预览为前 100,000 字符，完整读取可使用文件工具。' : '')); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [selected, workspaceId]);
  function open(entry: Entry) {
    if (entry.type === 'directory') { setPath(entry.filepath); setOffset(0); setSelected(null); return; }
    setSelected(entry); setDestination(entry.filepath); setText('');
  }
  async function move() {
    if (!selected || !await confirm({ title: '移动源码路径？', body: '实际文件会移动，引用它的源码 import 和构建配置需要另行核对。', confirmLabel: '移动' })) return;
    try {
      await apiRequest({ method: 'POST', url: '/storage/sources/move', data: { workspace_id: workspaceId, filepath: selected.filepath, destination } });
      setSelected(null); setRevision(value => value + 1);
    } catch (reason) { setError(String((reason as Error).message || reason)); }
  }
  const roots = ['files/data', 'files/tmp', 'inbox'];
  const atRoot = roots.includes(path);
  return <section className="file-source-browser" aria-label="工作目录">
    <div className="file-source-toolbar">
      <div className="dm-segmented" role="group" aria-label="根目录">
        {roots.map(root => <Button size="sm" key={root} variant={path === root || path.startsWith(root + '/') ? 'selected' : 'default'} aria-pressed={path === root || path.startsWith(root + '/')} onClick={() => { setPath(root); setOffset(0); setSelected(null); }}>{root}</Button>)}
      </div>
      <Button size="sm" disabled={atRoot} onClick={() => { setPath(path.slice(0, path.lastIndexOf('/'))); setOffset(0); }}><IconChevronLeft size={13} aria-hidden="true" />上级目录</Button>
      <span className="file-source-path mono" title={path}><IconFolder size={13} aria-hidden="true" />{path}</span>
      {tree && <span className="dm-toolbar-meta"><b>{tree.total}</b> 项</span>}
    </div>
    {error && <div className="callout err" role="alert"><IconAlert size={16} aria-hidden="true" /><span>{error}</span></div>}
    <div className="split-shell data-split file-space-split"><aside className="data-list file-space-list" aria-label="目录内容">
      <div className="file-list-scroll">
      {tree?.entries.map(entry => <div key={entry.filepath} className={`data-row file-source-row${selected?.filepath === entry.filepath ? ' selected' : ''}`}>
        <span className={`file-source-icon is-${entry.type}`} aria-hidden="true">{entry.type === 'directory' ? <IconFolder size={16} /> : entry.type === 'symlink' ? <IconLink size={16} /> : <IconDocument size={16} />}</span>
        <button className="file-space-select" disabled={!entry.accessible} onClick={() => open(entry)}>{entry.type === 'directory' ? '目录' : entry.type === 'symlink' ? '链接' : '文件'} · {entry.name}</button>
        {entry.type === 'directory' && <Button size="sm" variant="ghost" onClick={() => { setSelected(entry); setDestination(entry.filepath); }}>移动</Button>}
      </div>)}
      {!tree?.entries.length && <EmptyState text="此目录为空或尚未创建" hint="切换根目录，或返回上级目录" />}
      </div>
      <div className="file-list-pagination"><span>{tree?.entries.length ? `本页 ${tree.entries.length} 项` : ''}</span><Button size="sm" disabled={tree?.next_offset == null} onClick={() => setOffset(tree!.next_offset!)}>下一页</Button></div>
    </aside><DetailPanel className="file-source-detail" title={selected?.name} subtitle={selected ? (selected.type === 'directory' ? '目录' : selected.type === 'symlink' ? '链接' : '文件') : undefined} empty={!selected ? { text: '选择路径', hint: '浏览真实源码目录，不改变文件库身份' } : undefined}>
      {selected && <>
        <InfoList items={[['路径', selected.filepath, true], selected.size_bytes != null && ['大小', formatFileSize(selected.size_bytes)]]} />
        <fieldset className="file-space-organize file-source-move"><legend>移动或重命名</legend>
          <label>目标 workspace 路径<input className="input" value={destination} onChange={event => setDestination(event.target.value)} /></label>
          <Button size="sm" disabled={!destination.trim() || destination === selected.filepath} onClick={() => void move()}>移动或重命名</Button>
          <p className="dm-muted">路径以当前工作区根为基准。项目源码的构建引用不会自动重写。</p>
        </fieldset>
        {text && <section className="file-preview-content" aria-label="内容预览"><h4>内容预览</h4><CodeBlock>{text}</CodeBlock></section>}
      </>}
    </DetailPanel></div>
  </section>;
}
