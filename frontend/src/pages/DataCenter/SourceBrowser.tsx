import { useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';
import { Button, DetailPanel, FilterBar } from '../../components/ui';
import { CodeBlock } from '../../components/common';
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
  return <section className="file-source-browser" aria-label="工作目录">
    <FilterBar>{['files/data', 'files/tmp', 'inbox'].map(root => <Button size="sm" key={root} onClick={() => { setPath(root); setOffset(0); setSelected(null); }}>{root}</Button>)}
      <Button size="sm" disabled={['files/data', 'files/tmp', 'inbox'].includes(path)} onClick={() => { setPath(path.slice(0, path.lastIndexOf('/'))); setOffset(0); }}>上级目录</Button>
      <span className="mono">{path}</span></FilterBar>
    {error && <p role="alert">{error}</p>}
    <div className="split-shell data-split"><aside className="data-list">
      {tree?.entries.map(entry => <div key={entry.filepath} className="data-row"><button className="file-space-select" disabled={!entry.accessible} onClick={() => open(entry)}>{entry.type === 'directory' ? '目录' : entry.type === 'symlink' ? '链接' : '文件'} · {entry.name}</button>
        {entry.type === 'directory' && <Button size="sm" onClick={() => { setSelected(entry); setDestination(entry.filepath); }}>移动</Button>}</div>)}
      {!tree?.entries.length && <p className="dim">此目录为空或尚未创建</p>}
      <Button size="sm" disabled={tree?.next_offset == null} onClick={() => setOffset(tree!.next_offset!)}>下一页</Button>
    </aside><DetailPanel title={selected?.name} empty={!selected ? { text: '选择路径', hint: '浏览真实源码目录，不改变文件库身份' } : undefined}>
      {selected && <><p className="mono">{selected.filepath}</p><label>目标 workspace 路径<input value={destination} onChange={event => setDestination(event.target.value)} /></label><Button size="sm" onClick={() => void move()}>移动或重命名</Button>
        <p className="dim">路径以当前工作区根为基准。项目源码的构建引用不会自动重写。</p>{text && <CodeBlock>{text}</CodeBlock>}</>}
    </DetailPanel></div>
  </section>;
}
