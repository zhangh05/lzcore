import { useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';
import { Button } from '../../components/ui';
import { CodeBlock } from '../../components/common';

interface Inspection { units: Array<Record<string, unknown>>; coverage: Record<string, unknown>; warnings: string[]; next_offset: number | null; total_units: number; }
export function FileInspection({ workspaceId, fileId, kind }: { workspaceId: string; fileId: string; kind: string }) {
  const [result, setResult] = useState<Inspection | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [imageId, setImageId] = useState('');
  const [ocr, setOcr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOffset(0); setResult(null); setImageId(''); setOcr(''); setPage(1); }, [workspaceId, fileId]);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    apiRequest<Inspection>({ method: 'GET', url: `/storage/files/${fileId}/inspect`, params: { workspace_id: workspaceId, offset }, signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason.message || reason)); });
    return () => controller.abort();
  }, [workspaceId, fileId, offset]);
  async function render(performOcr = false) {
    setBusy(true); setError('');
    try {
      const data = await apiRequest<{ image_file_id: string; text: string }>({ method: 'POST', url: `/storage/files/${fileId}/page`, data: { workspace_id: workspaceId, page, ocr: performOcr } });
      setImageId(data.image_file_id); setOcr(data.text);
    } catch (reason) { setError(String((reason as Error).message || reason)); }
    finally { setBusy(false); }
  }
  // Delimited text arrives one unit per row; render it as one table instead of
  // a stack of single-row tables so columns line up.
  const rowTable = Boolean(result && kind !== 'xlsx' && result.units.length && result.units.every(unit => Array.isArray(unit.cells)));
  return <section className="file-inspection" aria-label="结构预览">
    <h4>结构预览</h4>{error && <p className="callout err" role="alert">{error}</p>}
    {result && <>
      <p className="dm-muted">共 {result.total_units} 个结构单元，当前 {offset + 1}–{offset + result.units.length}</p>
      {result.warnings.map(warning => <p key={warning} className="callout info">{warning}</p>)}
      {rowTable ? <div className="data-table-scroll file-structure-table">
        <table className="tbl"><tbody>{result.units.map((unit, index) => <tr key={offset + index}><th scope="row">第 {String(unit.row)} 行</th>{(unit.cells as unknown[]).map((cell, n) => <td key={n}>{String(cell ?? '')}</td>)}</tr>)}</tbody></table>
      </div> : result.units.map((unit, index) => <div key={offset + index} className="file-structure-unit">
        {Array.isArray(unit.cells) && kind === 'xlsx' ? <><b>{String(unit.sheet)} · 第 {String(unit.row)} 行</b><div className="data-table-scroll"><table className="tbl"><thead><tr><th>单元格</th><th>原内容／公式</th><th>已保存值</th></tr></thead><tbody>{(unit.cells as Array<{ cell: string; source_value: unknown; value: unknown }>).map(cell => <tr key={cell.cell}><td>{cell.cell}</td><td>{String(cell.source_value ?? '')}</td><td>{cell.value === null ? '没有缓存值' : String(cell.value)}</td></tr>)}</tbody></table></div></> :
          Array.isArray(unit.cells) ? <div className="data-table-scroll"><table className="tbl"><tbody><tr><th>第 {String(unit.row)} 行</th>{(unit.cells as unknown[]).map((cell, n) => <td key={n}>{String(cell ?? '')}</td>)}</tr></tbody></table></div> :
          Array.isArray(unit.rows) ? <div className="data-table-scroll"><table className="tbl"><tbody>{(unit.rows as unknown[][]).map((row, n) => <tr key={n}>{row.map((cell, c) => <td key={c}>{String(cell ?? '')}</td>)}</tr>)}</tbody></table></div> :
          Array.isArray(unit.shapes) ? <><h4>第 {String(unit.page)} 页</h4>{(unit.shapes as Array<{ name: string; text?: string; rows?: string[][] }>).map((shape, n) => <div key={n}>{shape.text && <p className="pre-wrap">{shape.text}</p>}{shape.rows && <div className="data-table-scroll"><table className="tbl"><tbody>{shape.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table></div>}</div>)}{Boolean(unit.notes) && <p>备注：{String(unit.notes)}</p>}</> :
          typeof unit.text === 'string' ? <><b>{unit.page ? `第 ${unit.page} 页` : unit.line ? `第 ${unit.line} 行` : unit.style as string}</b><p className="pre-wrap">{unit.text}</p></> :
          typeof unit.name === 'string' ? <p>{unit.name} · {String(unit.size_bytes || 0)} 字节{unit.directory ? ' · 目录' : ''}</p> : <CodeBlock language="json">{JSON.stringify(unit, null, 2)}</CodeBlock>}
      </div>)}
      <div className="actions-row file-inspection-pager"><Button size="sm" disabled={!offset} onClick={() => setOffset(0)}>首页</Button><Button size="sm" disabled={result.next_offset === null} onClick={() => setOffset(result.next_offset!)}>下一段</Button></div>
      {kind === 'pdf' && <><label>页码 <input type="number" min={1} max={Number(result.coverage.pages)} value={page} onChange={event => { setPage(Number(event.target.value)); setImageId(''); setOcr(''); }} /></label>
        <Button size="sm" disabled={busy} onClick={() => void render()}>读取页图</Button><Button size="sm" disabled={busy || !result.coverage.ocr_available} title={result.coverage.ocr_available ? '使用已安装的 Tesseract' : '当前未安装 OCR 处理器'} onClick={() => void render(true)}>OCR</Button>
        {imageId && <img className="file-space-preview" alt={`第 ${page} 页`} src={`/api/storage/files/${imageId}/preview?workspace_id=${encodeURIComponent(workspaceId)}`} />}
        {ocr && <CodeBlock>{ocr}</CodeBlock>}
      </>}
      <details><summary>读取覆盖范围</summary><CodeBlock language="json">{JSON.stringify(result.coverage, null, 2)}</CodeBlock></details>
    </>}
  </section>;
}
