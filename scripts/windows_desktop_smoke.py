"""Launch the actual frozen EXE and test its real WebView2/native bridge."""
from __future__ import annotations
import argparse
import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright


def wait_until(call, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = call()
            if value: return value
        except (OSError, ValueError): pass
        time.sleep(.25)
    raise AssertionError('Timed out waiting for desktop readiness')


def run(exe: Path, mode: str, output: Path):
    output.mkdir(parents=True, exist_ok=True)
    data = output / '中文 用户数据'
    report = output / 'startup.json'
    # Seed only this smoke run's isolated storage, then exercise the actual
    # business export button rather than just calling the bridge directly.
    sid = 'smoke_export'
    sessions = data/'workspaces/default/sessions'
    messages = sessions/sid/'messages'
    messages.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    (sessions/f'{sid}.json').write_text(json.dumps({
        'session_id':sid, 'workspace_id':'default', 'title':'桌面业务导出验证',
        'status':'active', 'created_at':now, 'updated_at':now, 'metadata':{}, 'run_ids':['smoke_export'],
    }), encoding='utf-8')
    (messages/'smoke_export.assistant.json').write_text(json.dumps({
        'session_id':sid, 'run_id':'smoke_export', 'role':'assistant',
        'content':'真实工作台中文导出', 'metadata':{'created_at':now},
    }), encoding='utf-8')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0)); cdp = probe.getsockname()[1]
    env = {**os.environ, 'LZCORE_SMOKE_CDP_PORT':str(cdp), 'LZCORE_EMBEDDED_WORKER':'true', 'PYTHONUTF8':'1', 'LZCORE_LLM_ENABLED':'false'}
    proc = subprocess.Popen([str(exe.resolve()), '--data-dir', str(data.resolve()), '--smoke-test', str(report.resolve())], env=env)
    try:
        start = wait_until(lambda: json.loads(report.read_text(encoding='utf-8')) if report.exists() else None)
        assert start['ok'] and start['mode'] == mode and start['hwnd'] and start['tray']
        user32 = ctypes.windll.user32
        hwnd = wintypes.HWND(start['hwnd'])
        assert user32.IsWindowVisible(hwnd)
        wait_until(lambda: urllib.request.urlopen(f'http://127.0.0.1:{cdp}/json/version').status == 200)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{cdp}')
            page = wait_until(lambda: next((x for ctx in browser.contexts for x in ctx.pages if x.url.startswith(start['origin'])), None))
            page.wait_for_function('Boolean(window.pywebview?.api?.get_info)', timeout=60000)
            page.get_by_role('button', name='桌面设置', exact=True).click()
            page.get_by_role('dialog').wait_for()
            assert page.get_by_text('窗口与后台运行').is_visible()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            info = page.evaluate('window.pywebview.api.get_info()')
            assert info['data_dir'] == str(data.resolve()) and info['mode'] == mode
            page.get_by_role('combobox').select_option('dark')
            page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
            wait_until(lambda: json.loads((data/'.runtime/desktop.json').read_text(encoding='utf-8'))['ui']['theme']=='dark')
            page.screenshot(path=str(output/'desktop-settings.png'), full_page=True)
            page.get_by_role('button', name='完成', exact=True).click()
            # Native resize uses the real HWND, so DPI and WebView layout agree.
            assert user32.MoveWindow(hwnd, 40, 40, 640, 600, True)
            page.wait_for_timeout(600)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.get_by_role('button', name='桌面设置', exact=True).click()
            page.screenshot(path=str(output/'desktop-narrow.png'), full_page=True)
            assert page.get_by_role('button', name='完成', exact=True).is_visible()
            page.get_by_role('button', name='完成', exact=True).click()
            # The JS bridge is origin-checked even before navigation guards.
            assert page.evaluate("window.pywebview.api.report_state({dirty:false,title:'窗口测试'})")['ok']
            # Native file dialog: enter text as real keyboard input.
            exported = output/'中文 导出.txt'
            page.evaluate("window.__exportResult=null; void window.pywebview.api.save_file('测试.txt', '" + base64.b64encode('真实原生导出'.encode()).decode() + "', 'text/plain').then(r=>window.__exportResult=r)")
            script = Path(__file__).with_name('windows_dialog_smoke.ps1')
            subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(script),'-ParentPid',str(proc.pid),'-FileName',str(exported.resolve())], check=True, timeout=35)
            page.wait_for_function('window.__exportResult !== null', timeout=20000)
            assert exported.exists(), page.evaluate('window.__exportResult')
            assert exported.read_text(encoding='utf-8')=='真实原生导出'
            assert user32.MoveWindow(hwnd, 40, 40, 1280, 900, True)
            page.goto(start['origin']+'/workbench')
            page.get_by_text('桌面业务导出验证', exact=True).first.click()
            page.get_by_text('真实工作台中文导出', exact=True).wait_for()
            page.get_by_role('button', name='会话信息与导出', exact=True).click()
            page.get_by_role('button', name='导出', exact=True).click()
            conversation = output/'中文 会话.md'
            subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(script),'-ParentPid',str(proc.pid),'-FileName',str(conversation.resolve())],check=True,timeout=35)
            wait_until(lambda: conversation.exists())
            assert '真实工作台中文导出' in conversation.read_text(encoding='utf-8')
            # Background does not stop the local server or detach the durable transport.
            page.evaluate("window.pywebview.api.request_exit('background')")
            assert not user32.IsWindowVisible(hwnd)
            assert urllib.request.urlopen(start['origin']+'/api/health').status==200
            second = subprocess.run([str(exe.resolve()),'--data-dir',str(data.resolve())], env=env, timeout=20)
            assert second.returncode==0
            wait_until(lambda: user32.IsWindowVisible(hwnd))
            user32.ShowWindow(hwnd,3); time.sleep(.4); user32.ShowWindow(hwnd,9)
            # Same-origin websocket contract uses the packaged app, not a test server.
            result = page.evaluate('''async () => {
              const token = (await (await fetch('/api/local-token')).json()).token;
              return await new Promise((resolve,reject) => {
              const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws/agent');
              const timer = setTimeout(() => {ws.close(); reject(new Error('WS timeout'));}, 10000);
              ws.onopen = () => ws.send(JSON.stringify({type:'ping',workspace_id:'default',local_token:token}));
              ws.onmessage = e => {const f=JSON.parse(e.data); if(f.type==='pong') {clearTimeout(timer); ws.close(); resolve(true);}};
              ws.onerror = () => reject(new Error('WS failed'));
            }); }''')
            assert result
            assert not errors, errors
            (data/'sentinel.txt').write_text('卸载保留',encoding='utf-8')
            # A clean installation hid a dict/object mismatch in shutdown.
            # Keep a real, finished historical job in the packaged storage.
            history = data/'workspaces/default/jobs/job_smoke_history'
            history.mkdir(parents=True, exist_ok=True)
            (history/'job_smoke_history.json').write_text(json.dumps({
                'job_id':'job_smoke_history', 'workspace_id':'default',
                'job_type':'desktop_smoke', 'status':'succeeded', 'metadata':{},
            }), encoding='utf-8')
            assert page.evaluate('window.pywebview.api.get_info()')['active_jobs']==0
            # Exercise the real Windows Close action, including the native
            # lifecycle path rather than asking the JS bridge to terminate.
            assert user32.PostMessageW(hwnd, 0x0010, 0, 0)
            exit_code = proc.wait(timeout=40)
            (output/'result.json').write_text(json.dumps({
                'ok': exit_code == 0, 'mode': mode, 'stage': 'native_close',
                'exit_code': exit_code, 'exit_hex': f'0x{exit_code & 0xffffffff:08X}',
            }), encoding='utf-8')
            assert exit_code == 0, f'Native close failed: exit={exit_code} (0x{exit_code & 0xffffffff:08X})'
    finally:
        if proc.poll() is None:
            # Only the isolated CI process, on test failure.
            proc.terminate(); proc.wait(timeout=20)
        if not report.exists() or proc.returncode:
            for log in (data/'logs').glob('desktop.log*'):
                print(log.read_text(encoding='utf-8',errors='replace')[-15000:])
    (output/'result.json').write_text(json.dumps({'ok':True,'mode':mode,'exe':str(exe),'platform':os.name,'data':str(data)}),encoding='utf-8')
    return data


if __name__=='__main__':
    args=argparse.ArgumentParser(); args.add_argument('--exe',type=Path,required=True); args.add_argument('--mode',choices=['portable','installed'],required=True); args.add_argument('--output',type=Path,required=True)
    a=args.parse_args(); run(a.exe,a.mode,a.output)
