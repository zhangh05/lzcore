import './FileLibraryPicker.css';
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { storageApi } from '../api';
import { Button, ModalShell, SearchInput } from './ui';
import type { ManagedFile } from '../types';
import { formatFileSize } from '../utils/format';

export function FileLibraryPicker({ workspaceId, open, onClose, onChoose, maxCount = 8 }: {
  workspaceId: string; maxCount?: number; open: boolean; onClose: () => void; onChoose: (files: ManagedFile[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [selected, setSelected] = useState<ManagedFile[]>([]);
  const [cursor, setCursor] = useState('');
  const [more, setMore] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { setSelected([]); setFiles([]); setCursor(''); setQuery(''); }, [open, workspaceId]);
  useEffect(() => {
    if (!open) return;
    setFiles([]); setMore(''); setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError('');
      storageApi.page(workspaceId, { q: query, cursor, limit: 30 }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setFiles(result.files); setMore(result.next_cursor); } })
        .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, workspaceId, query, cursor]);
  return createPortal(<ModalShell open={open} onClose={onClose} title="选择已有文件" subtitle="复用当前工作区的资料，保留原件与来源"
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!selected.length} onClick={() => { onChoose(selected); onClose(); }}>添加 {selected.length} 个文件</Button></>}>
    <SearchInput value={query} onChange={event => { setQuery(event.target.value); setCursor(''); }} placeholder="搜索文件名或路径" />
    {error && <p role="alert">{error}</p>}
    <div className="file-picker-list">
      {files.map(file => <label key={file.file_id} className="file-picker-row">
        <input type="checkbox" disabled={selected.length >= maxCount && !selected.some(item => item.file_id === file.file_id)} checked={selected.some(item => item.file_id === file.file_id)} onChange={event => setSelected(items => event.target.checked ? [...items, file] : items.filter(item => item.file_id !== file.file_id))} />
        <span>{file.original_name}<small>{file.file_kind} · {formatFileSize(file.size_bytes)}</small></span>
      </label>)}
      {loading && <p role="status">正在读取文件…</p>}
      {!loading && !files.length && !error && <p className="dim">没有符合条件的文件</p>}
    </div>
    <div className="actions-row"><Button disabled={!cursor} onClick={() => setCursor('')}>回到首页</Button><Button disabled={!more} onClick={() => setCursor(more)}>下一页</Button></div>
  </ModalShell>, document.body);
}
