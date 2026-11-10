import { useCallback, useEffect, useState } from 'react';
import { ModalShell } from '../components/ui/ModalShell';
import { Button } from '../components/ui/Button';
import { useSessionStore, useUIStore } from '../stores/session';
import { isDesktop, nativeCall, desktopPreferences, desktopDirty, type DesktopInfo } from './bridge';
export function DesktopSettingsButton() {
  return isDesktop() ? <button className="theme-toggle" aria-label="桌面设置" title="桌面设置" onClick={() => window.dispatchEvent(new CustomEvent('lzcore:desktop-action', {detail: {action: 'settings'}}))}>▣</button> : null;
}
export function DesktopHost() {
  const [panel, setPanel] = useState<'settings' | 'close' | null>(null);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [credentials, setCredentials] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [force, setForce] = useState(false);
  const preference = useUIStore(s => s.themePreference);
  const refresh = useCallback(async () => { desktopDirty('bootstrap', false); const data = await nativeCall('get_info'); setInfo(data as unknown as DesktopInfo); return data as unknown as DesktopInfo; }, []);
  const run = useCallback(async (name: string, ...args: unknown[]) => {
    setBusy(true); setMessage('');
    try { const result = await nativeCall(name, ...args); await refresh(); if (name === 'create_backup' || name === 'export_diagnostics') setMessage('已保存到所选位置'); return result; }
    catch (e) { setMessage(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); if (['create_backup', 'import_backup'].includes(name)) setPassword(''); }
  }, [refresh]);
  useEffect(() => {
    if (!isDesktop()) return;
    const persist = () => { void nativeCall('save_preferences', desktopPreferences()).catch(() => {}); };
    const ready = () => { desktopDirty('bootstrap', false); persist(); void refresh().catch(() => {}); };
    window.addEventListener('pywebviewready', ready);
    const unsubscribe = useUIStore.subscribe(persist);
    const event = async (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.action === 'system-theme') { if (useUIStore.getState().themePreference === 'system') useUIStore.getState().syncTheme(d.theme); return; }
      if (d.action === 'task' && d.target?.workspace_id) {
        // The destination still passes through normal server authentication.
        const store = useSessionStore.getState(); store.setCurrentWorkspace(d.target.workspace_id);
        if (d.target.session_id) store.setCurrentSession(d.target.session_id);
        window.history.pushState({}, '', '/workbench'); window.dispatchEvent(new PopStateEvent('popstate')); return;
      }
      if (d.action === 'settings') { setPanel('settings'); void refresh().catch(() => {}); }
      if (d.action === 'shutdown') { setPanel('close'); setInfo(current => current ? {...current, shutdown: d.shutdown} : current); void refresh().catch(() => {}); }
      if (d.action === 'close') {
        try { const current = await refresh(); if (!current.active_jobs && !current.dirty && current.shutdown.status === 'idle') { await nativeCall('request_exit', 'exit'); return; } } catch { /* show recovery controls */ }
        setPanel('close'); setForce(false); setDiscard(false);
      }
    };
    window.addEventListener('lzcore:desktop-action', event);
    ready();
    return () => { unsubscribe(); window.removeEventListener('pywebviewready', ready); window.removeEventListener('lzcore:desktop-action', event); };
  }, [refresh]);
  useEffect(() => { if (!panel) return; const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 1000); return () => clearInterval(timer); }, [panel, refresh]);
  const close = () => { if (panel === 'close') void run('request_exit', 'return'); setPanel(null); setPassword(''); setMessage(''); };
  if (!isDesktop()) return null;
  return <ModalShell open={Boolean(panel)} onClose={close} size="sheet" className="desktop-dialog" title={panel === 'close' ? '退出联智中枢' : '桌面设置'} footer={panel === 'close' ? <>
    <Button onClick={close}>返回应用</Button><Button disabled={!info?.tray || busy} onClick={async () => { if (await run('request_exit', 'background')) setPanel(null); }}>后台运行</Button>
    <Button variant="danger-confirm" disabled={busy || (info?.dirty && !discard) || info?.shutdown.status === 'stopping'} onClick={() => { void run('request_exit', force ? 'force' : 'exit', discard); }}>{force ? '确认中断并退出' : '停止任务并退出'}</Button>
  </> : <Button onClick={close}>完成</Button>}>
    <div className="desktop-dialog-body">
      {message && <p role="status" className="desktop-message">{message}</p>}
      {panel === 'close' ? <>
        <p>{info?.active_jobs ? `${info.active_jobs} 个任务待处理或运行中。后台运行会保留当前窗口和任务。` : '当前没有待处理或运行中的任务。'}</p>
        {info?.dirty && <label><input type="checkbox" checked={discard} onChange={e => setDiscard(e.target.checked)}/> 确认放弃未保存的编辑</label>}
        {info?.shutdown.status === 'stopping' && <p role="status">正在停止任务并等待收尾…</p>}
        {info?.shutdown.status === 'waiting' && <><p>{info.shutdown.message}</p><label><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)}/> 确认中断退出，后续需核对尚未确认的写入</label></>}
      </> : <>
        <section><h3>窗口与后台运行</h3>
          <label>主题 <select value={preference} onChange={e => useUIStore.getState().setThemePreference(e.target.value as 'light' | 'dark' | 'system')}><option value="system">跟随 Windows</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label><input type="checkbox" checked={Boolean(info?.settings.close_to_tray)} disabled={!info?.tray || busy} onChange={e => { void run('save_preferences', {close_to_tray: e.target.checked}); }}/> 关闭窗口时进入托盘</label>
          <label><input type="checkbox" checked={info?.settings.notifications !== false} disabled={busy} onChange={e => { void run('save_preferences', {notifications: e.target.checked}); }}/> 后台任务完成后通知</label>
          {info?.mode === 'installed' && <label><input type="checkbox" checked={Boolean(info.settings.autostart)} disabled={busy} onChange={e => { void run('save_preferences', {autostart: e.target.checked}); }}/> 登录 Windows 后在后台启动</label>}
        </section>
        <section><h3>数据与备份</h3>{info?.admin === false && <p>需要登录默认组织管理员账号才能打开数据目录、备份、恢复或应用更新。</p>}<p className="desktop-path">{info?.data_dir}</p><div className="desktop-buttons"><Button disabled={info?.admin === false} onClick={() => { void run('open_folder', 'data'); }}>打开数据目录</Button><Button disabled={info?.admin === false} onClick={() => { void run('open_folder', 'exports'); }}>打开导出目录</Button></div>
          <label>备份口令 <input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="可选，至少 12 个字符"/></label>
          <label><input type="checkbox" checked={credentials} onChange={e => setCredentials(e.target.checked)}/> 将凭据放入加密备份（需要口令）</label>
          <p>普通备份不包含凭据。恢复或迁移会替换当前数据，原数据保留在恢复前目录。请先退出旧版程序。</p>
          <div className="desktop-buttons"><Button disabled={info?.admin === false || busy || Boolean(info?.active_jobs) || Boolean(info?.dirty)} onClick={() => { void run('create_backup', password, credentials); }}>创建备份</Button><Button disabled={info?.admin === false || busy || Boolean(info?.active_jobs) || Boolean(info?.dirty)} onClick={() => { void run('import_backup', password); }}>选择备份</Button><Button disabled={info?.admin === false || busy || Boolean(info?.active_jobs) || Boolean(info?.dirty)} onClick={() => { void run('migrate_data'); }}>迁移旧版数据</Button></div>
          {info?.restore && <div className="desktop-message"><p>数据已校验并暂存。确认替换当前数据并重启？原数据会保留。</p><Button variant="danger-confirm" disabled={info.admin === false || busy || Boolean(info.active_jobs) || info.dirty} onClick={() => { void run('apply_restore'); }}>确认恢复并重启</Button></div>}
        </section>
        <section><h3>版本与更新</h3><p>v{info?.version} · {info?.commit?.slice(0, 8)} · {info?.mode === 'portable' ? '便携版' : info?.mode === 'installed' ? '安装版' : '源码运行'}</p><p>{info?.signed ? '已签名' : '未签名'} · WebView2 {info?.webview2}</p>
          <div className="desktop-buttons"><Button disabled={busy || ['checking', 'downloading'].includes(info?.update.status || '')} onClick={() => { void run('check_update'); }}>检查更新</Button>{info?.settings.previous_version && <Button disabled={busy} onClick={() => { void run('check_update', true); }}>检查可回退版本</Button>}<Button disabled={info?.admin === false || busy} onClick={() => { void run('export_diagnostics'); }}>导出脱敏诊断</Button></div>
          {info?.update.status === 'checking' && <p role="status">正在检查…</p>}{info?.update.status === 'current' && <p>已是最新版本</p>}
          {info?.update.message && <p role="status">{info.update.message}</p>}
          {['available', 'downloading', 'ready'].includes(info?.update.status || '') && <><p>版本 {info?.update.version}{info?.update.status === 'downloading' ? ` · 下载 ${info.update.progress || 0}%` : ''}</p><pre className="desktop-notes">{info?.update.notes}</pre>{info?.update.status === 'available' && <Button disabled={busy} onClick={() => { void run('download_update'); }}>下载更新</Button>}{info?.update.status === 'ready' && <Button variant="primary" disabled={info.admin === false || busy || Boolean(info.active_jobs) || info.dirty} onClick={() => { void run('apply_update'); }}>更新并重启</Button>}<p>保存编辑并结束任务后才能安装。更新保留用户数据。</p></>}
        </section>
      </>}
    </div>
  </ModalShell>;
}
