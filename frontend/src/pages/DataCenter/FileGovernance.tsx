import { useState } from 'react';
import { apiRequest } from '../../api/client';
import { Button, FilterBar } from '../../components/ui';
import { CodeBlock } from '../../components/common';
import { confirm } from '../../components/ConfirmDialog';

export function FileGovernance({ workspaceId }: { workspaceId: string }) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [backup, setBackup] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function execute(config: Parameters<typeof apiRequest>[0]) {
    setBusy(true); setError('');
    try { setResult(await apiRequest<Record<string, unknown>>(config)); }
    catch (reason) { setError(String((reason as Error).message || reason)); }
    finally { setBusy(false); }
  }
  async function migrate() {
    if (await confirm({ title: '修复已核对的文件使用关系？', body: '只补充由消息、产出和知识来源证明的关系。保留修复前备份，无法确定的归属保持在报告中。', confirmLabel: '应用关系修复' })) {
      await execute({ method: 'POST', url: '/storage/migration', data: { workspace_id: workspaceId, apply: true } });
    }
  }
  async function restore(apply = false) {
    if (!backup) return;
    if (apply && !await confirm({ title: '恢复文件与使用记录？', body: '只恢复同一用户、同一工作区的备份。目标冲突会阻止写入，不覆盖已有内容。', confirmLabel: '恢复' })) return;
    const form = new FormData(); form.append('workspace_id', workspaceId); form.append('file', backup); form.append('apply', String(apply));
    await execute({ method: 'POST', url: '/storage/restore', data: form });
  }
  return <section className="file-governance" aria-label="文件核对与备份">
    <p>分别核对实际文件、摘要、引用目标以及消息／产出／知识来源。没有检查的 owner 类型会在报告中列出。</p>
    <FilterBar><Button disabled={busy} onClick={() => void execute({ method: 'GET', url: '/storage/health', params: { workspace_id: workspaceId } })}>核对关系与文件</Button>
      <Button disabled={busy} onClick={() => void execute({ method: 'GET', url: '/storage/health', params: { workspace_id: workspaceId, hashes: 'true' } })}>完整摘要核对</Button>
      <Button disabled={busy} onClick={() => void execute({ method: 'POST', url: '/storage/migration', data: { workspace_id: workspaceId } })}>预览历史关系修复</Button>
      <Button disabled={busy || !Array.isArray(result?.additions)} onClick={() => void migrate()}>应用已核对修复</Button></FilterBar>
    <FilterBar><Button disabled={busy} onClick={() => void execute({ method: 'POST', url: '/storage/reconcile', data: { workspace_id: workspaceId } })}>回查未完成文件提交</Button>
      <Button disabled={busy || !Array.isArray(result?.results)} onClick={async () => { if (await confirm({ title: '封存已核对的文件事实？', body: '只提交与真实字节摘要一致的记录，不重新执行文件生成或导入。', confirmLabel: '核对并封存' })) await execute({ method: 'POST', url: '/storage/reconcile', data: { workspace_id: workspaceId, apply: true } }); }}>封存核对结果</Button></FilterBar>
    <FilterBar><Button disabled={busy} onClick={() => void execute({ method: 'POST', url: '/storage/search/rebuild' , data: { workspace_id: workspaceId } })}>重建正文索引</Button>
      <a className="btn" href={`/api/storage/backup?workspace_id=${encodeURIComponent(workspaceId)}`}>导出文件与使用记录</a></FilterBar>
    <p className="dim">备份范围为原件、文件身份、产出和相关会话／知识记录；不包含模型配置、密钥和运行中的作业。</p>
    <label>选择备份 <input type="file" accept=".zip" disabled={busy} onChange={event => { setBackup(event.target.files?.[0] || null); setResult(null); }} /></label>
    <Button disabled={busy || !backup} onClick={() => void restore()}>预览恢复</Button><Button disabled={busy || !backup || result?.preview !== true || result?.ok !== true} onClick={() => void restore(true)}>应用恢复</Button>
    {busy && <p role="status">正在核对实际数据…</p>}{error && <p role="alert">{error}</p>}
    {result && <GovernanceReport result={result} />}
  </section>;
}

function GovernanceReport({ result }: { result: Record<string, unknown> }) {
  const health = result.health as { ok: boolean; file_count: number; reference_count: number; issues: Array<Record<string, unknown>>; unresolved: Array<Record<string, unknown>>; checked: { hashes: boolean; unchecked_owner_types: string[] } } | undefined;
  const labels: Record<string, string> = { payload_missing: '原件缺失', size_mismatch: '文件大小不一致', hash_mismatch: '内容摘要不一致', payload_check_failed: '文件无法核对', duplicate_reference: '使用关系重复', reference_file_missing: '使用关系的文件身份缺失', reference_owner_missing: '使用方缺失', owner_reference_missing: '使用方关系未登记', pending_commit: '文件提交待回查', pending_restore: '备份恢复待回查', already_indexed: '原件与索引一致', verified_payload_unindexed: '原件已核对，身份待封存', verified_artifact_commit: '产出原件已核对', verified_restored_bundle: '恢复的原件与记录一致', observed_file_mutation: '已回查当前字节，未推断写入业务结果', unresolved: '尚无法确认' };
  const entries = (key: string) => Array.isArray(result[key]) ? result[key] as Array<Record<string, unknown>> : [];
  const rows = health?.issues || [...entries('conflicts'), ...entries('results')];
  return <section aria-label="核对结果">
    {health && <><h4>{health.ok ? '已检查项目一致' : `发现 ${health.issues.length} 项待处理问题`}</h4>
      <p>{health.file_count} 个文件身份 · {health.reference_count} 处使用关系 · {health.checked.hashes ? '已核对全部可用原件摘要' : '本次未核对内容摘要'}</p>
      {health.checked.unchecked_owner_types.length > 0 && <p>未核对的使用方：{health.checked.unchecked_owner_types.join('、')}</p>}
      {health.unresolved.length > 0 && <p>另有 {health.unresolved.length} 项来源无法完整确认，详见记录。</p>}</>}
    {Array.isArray(result.additions) && <p>{result.applied ? '本次已应用' : '可以补充'} {result.additions.length} 处有事实证明的关系；{entries('unresolved').length} 处仍需核对。</p>}
    {typeof result.indexed === 'number' && <p>已建立 {result.indexed} 个文件的正文索引；{entries('failures').length} 个文件解析失败。</p>}
    {typeof result.files === 'number' && <p>{result.preview ? '恢复预览' : '恢复结果'}：{result.files} 个文件身份 · {String(result.references || 0)} 处关系 · {entries('conflicts').length} 处冲突。</p>}
    {Array.isArray(result.unavailable_payloads) && result.unavailable_payloads.length > 0 && <p role="status">{result.unavailable_payloads.length} 个原件不在备份中，恢复记录无法找回这些字节。</p>}
    {rows.length > 0 && <ul>{rows.map((row, index) => <li key={index}>{labels[String(row.kind || row.state)] || String(row.kind || row.state)} · {String(row.file_id || row.artifact_id || row.owner_id || row.intent || row.path || row.ref_id || '')}{row.settled === true ? ' · 已封存' : ''}{row.reason ? ` · ${row.reason}` : ''}</li>)}</ul>}
    <details><summary>完整核对记录</summary><CodeBlock language="json">{JSON.stringify(result, null, 2)}</CodeBlock></details>
  </section>;
}
