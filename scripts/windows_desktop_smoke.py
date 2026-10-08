"""Launch the actual frozen EXE and test its real WebView2/native bridge."""
from __future__ import annotations
import argparse
import base64
import ctypes
from ctypes import wintypes
import json
import io
import os
import re
from pathlib import Path
import socket
import subprocess
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


def verify_packaged_files(page, origin, output):
    """Exercise real FileStore endpoints under the packaged native principal."""
    from PIL import Image
    from openpyxl import Workbook
    pdf = io.BytesIO(); Image.new('RGB', (30, 20), '#eeeeee').save(pdf, format='PDF')
    workbook = io.BytesIO(); book = Workbook(); book.active['A1'] = '=1+2'; book.save(workbook)
    formats = {'pdf': base64.b64encode(pdf.getvalue()).decode(), 'xlsx': base64.b64encode(workbook.getvalue()).decode()}
    result = page.evaluate("""async formats => {
      const token = (await (await fetch('/api/local-token')).json()).token;
      const headers = {'X-LZCore-Local-Token': token};
      async function call(path, options={}) {
        const response = await fetch('/api'+path, {...options, headers:{...headers,...options.headers}});
        if (!response.ok) throw new Error(path + ':' + response.status);
        return response;
      }
      const bytes = new Uint8Array([0,1,2,255]);
      const form = new FormData(); form.append('file', new Blob([bytes]), '中文 原件.custom');
      const uploaded = await (await call('/workspaces/default/artifacts/upload', {method:'POST',body:form})).json();
      const fid = uploaded.file.file_id;
      const changed = await (await call('/storage/files/'+fid, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default',name:'已整理 原件.custom',folder:'中文 项目/资料'})})).json();
      if (changed.file.file_id !== fid || changed.file.metadata.folder !== '中文 项目/资料') throw new Error('identity changed');
      await call('/storage/files/'+fid+'?workspace_id=default&confirm=true', {method:'DELETE'});
      await call('/storage/files/'+fid+'/restore', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default'})});
      const actual = new Uint8Array(await (await call('/storage/files/'+fid+'/download?workspace_id=default')).arrayBuffer());
      if (actual.length !== bytes.length || actual.some((v,i)=>v!==bytes[i])) throw new Error('restored bytes changed');
      const checked = {};
      for (const [kind, encoded] of Object.entries(formats)) {
        const form = new FormData(); form.append('file', new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]), '真实格式.'+kind);
        const original = await (await call('/workspaces/default/artifacts/upload', {method:'POST',body:form})).json();
        const id = original.file.file_id;
        const structure = await (await call('/storage/files/'+id+'/inspect?workspace_id=default')).json();
        if (kind === 'xlsx' && structure.units[0].cells[0].formula !== '=1+2') throw new Error('formula lost');
        if (kind === 'pdf') {
          const rendered = await (await call('/storage/files/'+id+'/page', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default',page:1})})).json();
          const image = new Uint8Array(await (await call('/storage/files/'+rendered.image_file_id+'/preview?workspace_id=default')).arrayBuffer());
          if (image[0] !== 137 || image[1] !== 80 || image[2] !== 78 || image[3] !== 71) throw new Error('page image unavailable');
        }
        checked[kind] = {file_id:id,coverage:structure.coverage};
      }
      const backup = await (await call('/storage/backup?workspace_id=default')).blob();
      const restore = new FormData(); restore.append('workspace_id','default'); restore.append('file',backup,'files.zip');
      const preview = await (await call('/storage/restore', {method:'POST',body:restore})).json();
      if (!preview.ok || preview.conflicts.length) throw new Error('backup preview conflict');
      return {ok:true,file_id:fid,bytes_preserved:true,formats:checked,backup_preview:preview,model_requests:0};
    }""", formats)
    (output/'files.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    page.goto(origin+'/data')
    page.get_by_role('tab', name=re.compile('^文件')).click()
    page.get_by_placeholder('搜索名称、路径或来源').fill('已整理 原件.custom')
    page.get_by_role('button', name='已整理 原件.custom', exact=False).click()
    page.get_by_text(result['file_id'], exact=True).wait_for()
    page.screenshot(path=str(output/'file-workspace.png'), full_page=True)


def verify_packaged_memory(page, origin, output):
    """Full text, scoped ownership, revision and human review in the frozen app."""
    result = page.evaluate("""async () => {
      const token = (await (await fetch('/api/local-token')).json()).token;
      const headers = {'X-LZCore-Local-Token': token, 'Content-Type':'application/json'};
      async function call(path, data) {
        const response = await fetch('/api'+path, {method:data?'POST':'GET', headers, ...(data?{body:JSON.stringify(data)}:{})});
        if (!response.ok) throw new Error(path+':'+response.status);
        return await response.json();
      }
      const content = '完整长期记忆原文'.repeat(500)+'末尾约束';
      const original = await call('/memory/write', {workspace_id:'default',title:'桌面记忆原文',content,user_confirmed:true});
      if ((await call('/memory/'+original.memory_id+'?workspace_id=default')).record.content !== content) throw new Error('memory content cut');
      const denied = await fetch('/api/memory/'+original.memory_id+'?workspace_id=another-project',{headers});
      if (denied.status !== 404) throw new Error('project memory leaked');
      const personal = await call('/memory/write', {workspace_id:'default',title:'桌面个人偏好',content:'个人通用偏好：使用中文回复。',scope:'global',memory_type:'core_rule',user_confirmed:true});
      if (!(await call('/memory/'+personal.memory_id+'?workspace_id=another-project')).record) throw new Error('personal memory unavailable');
      const candidate = await call('/memory/write', {workspace_id:'default',title:'桌面记忆审核',content:'新版完整内容：发布前核对附件。',supersedes_memory_id:original.memory_id});
      if (candidate.status !== 'conflict') throw new Error('unreviewed replacement activated');
      if ((await call('/memory/'+original.memory_id+'?workspace_id=default')).record.status !== 'active') throw new Error('original retired before review');
      return {original:original.memory_id,candidate:candidate.memory_id,full_chars:content.length,scopes_verified:true,model_requests:0};
    }""")
    page.goto(origin+'/memory')
    page.get_by_role('button', name='桌面记忆审核', exact=True).click()
    page.get_by_role('button', name='确认并启用', exact=True).click()
    page.get_by_text('记忆已确认并开始生效', exact=True).wait_for()
    checked = page.evaluate("""async ids => {
      const token=(await (await fetch('/api/local-token')).json()).token;
      const headers={'X-LZCore-Local-Token':token};
      const records=[];
      for(const id of [ids.original,ids.candidate]) {
        const r=await fetch('/api/memory/'+id+'?workspace_id=default',{headers});
        records.push((await r.json()).record);
      }
      if(records[0].status!=='expired'||records[0].content.length!==ids.full_chars||records[1].status!=='active') throw new Error('review or original lost');
      return {reviewed:true,original_preserved:true};
    }""",result)
    result.update(checked)
    (output/'memory.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    page.screenshot(path=str(output/'memory-workspace.png'),full_page=True)


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
            body = page.locator('.desktop-dialog-body')
            assert body.evaluate("el => getComputedStyle(el, '::-webkit-scrollbar').width") == '6px'
            assert body.evaluate("el => getComputedStyle(el, '::-webkit-scrollbar-button').display") == 'none'
            assert body.evaluate("el => getComputedStyle(el).scrollbarWidth") == 'auto'
            assert page.locator('.desktop-dialog').evaluate("el => getComputedStyle(el).backgroundColor") == 'rgb(24, 28, 31)'
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
            verify_packaged_files(page, start['origin'], output)
            verify_packaged_memory(page, start['origin'], output)
            # Actual packaged topology renderer: neutral defaults and black ink
            # survive native theme changes without touching persistent drawing data.
            assert user32.MoveWindow(hwnd, 40, 40, 1280, 800, True)
            topology_id = page.evaluate("""async () => {
              const token = (await (await fetch('/api/local-token')).json()).token;
              const response = await fetch('/api/extensions/network.operations/topologies?workspace_id=default', {
                method:'POST', headers:{'Content-Type':'application/json','X-LZCore-Local-Token':token},
                body:JSON.stringify({name:'原生图纸颜色验证',nodes:[
                  {node_id:'a',display_name:'核心交换机',device_type:'switch',x:100,y:160.5},
                  {node_id:'b',display_name:'接入交换机',device_type:'switch',x:400,y:160.5}],
                  links:[{link_id:'neutral',source_node_id:'a',target_node_id:'b',status:'unknown'},
                    {link_id:'black',source_node_id:'a',target_node_id:'b',status:'up',style:{color:'#000000'}}]})
              });
              if(!response.ok) throw new Error('Topology fixture failed: '+response.status);
              return (await response.json()).topology.topology_id;
            }""")
            page.goto(start['origin']+'/topology?topology='+topology_id)
            page.wait_for_function("document.querySelector('.netops-cytoscape')?._cyreg?.cy?.edges().length === 2")
            for theme in ('light', 'dark'):
                if page.locator('html').get_attribute('data-theme') != theme:
                    page.get_by_role('button', name='切换主题', exact=True).click()
                page.wait_for_function("document.documentElement.dataset.theme === '"+theme+"'")
                appearance = page.evaluate("""() => {
                  const cy=document.querySelector('.netops-cytoscape')._cyreg.cy;
                  return {neutral:cy.getElementById('neutral').style('line-color'),
                    black:cy.getElementById('black').style('line-color'),
                    border:cy.getElementById('a').style('border-color'),
                    observation:cy.getElementById('a').data('observationStatus'),
                    contrast:Number(cy.getElementById('black').style('underlay-opacity'))};
                }""")
                assert appearance['neutral'] == 'rgb(102,113,122)', appearance
                assert appearance['black'] == 'rgb(0,0,0)', appearance
                assert appearance['border'] == 'rgb(138,148,158)', appearance
                assert appearance['observation'] is None, appearance
                wait_until(lambda theme=theme: page.evaluate("Number(document.querySelector('.netops-cytoscape')._cyreg.cy.getElementById('black').style('underlay-opacity'))") == (.8 if theme == 'dark' else 0))
                page.wait_for_timeout(250)
                page.screenshot(path=str(output/('topology-'+theme+'.png')), full_page=True)
            # Native pointer drag: an off-grid smart alignment must survive
            # mouse-up, backend save and reopening the packaged drawing.
            host = page.locator('.netops-cytoscape')
            host.evaluate("el => {const cy=el._cyreg.cy; cy.stop(); cy.zoom(1); cy.pan({x:30,y:30}); cy.elements().unselect(); cy.getElementById('a').select();}")
            page.locator('.topology-inspector').wait_for(state='visible')
            box = host.bounding_box()
            point = host.evaluate("el => el._cyreg.cy.getElementById('a').renderedPosition()")
            page.mouse.move(box['x']+point['x'], box['y']+point['y'])
            page.locator('.studio-display-menu summary').click()
            assert page.get_by_role('checkbox', name='网格', exact=True).is_checked()
            page.locator('.studio-guides-menu summary').click()
            assert not page.get_by_role('checkbox', name='网格吸附', exact=True).is_checked()
            page.keyboard.press('Escape')
            page.mouse.move(box['x']+point['x'], box['y']+point['y'])
            page.mouse.down()
            previous = None
            for step in range(6, 41):
                page.mouse.move(box['x']+point['x']+step, box['y']+point['y'])
                shown = host.evaluate("el => el._cyreg.cy.getElementById('a').position()")
                assert abs(shown['x']-(100+step)) < 2.5, shown
                if previous is not None:
                    assert abs(shown['x']-previous) < 3, shown
                previous = shown['x']
            # Approach the obsolete 94x76 edge first. Any displayed horizontal
            # guide must meet the real 76x60 bodies, not the old imaginary edge.
            page.mouse.move(box['x']+point['x']+80, box['y']+point['y']-8, steps=16)
            assert host.evaluate("""el => {
              const cy=el._cyreg.cy, pan=cy.pan(), zoom=cy.zoom();
              const bodies=['a','b'].map(id => {const n=cy.getElementById(id); return {y:n.position().y,h:n.height()};});
              return [...document.querySelectorAll('.netops-align-guides line[data-aligned=\"true\"]')].every(line => {
                const y1=Number(line.getAttribute('y1')),y2=Number(line.getAttribute('y2'));
                if(y1!==y2) return true;
                const y=(y1-pan.y)/zoom;
                return bodies.every(n => Math.min(...[n.y-n.h/2,n.y,n.y+n.h/2].map(v=>Math.abs(v-y)))<.001);
              });
            }"""), 'Guide does not meet actual icon boundaries'
            page.mouse.move(box['x']+point['x']+80, box['y']+point['y'], steps=8)
            preview = host.evaluate("el => el._cyreg.cy.getElementById('a').position()")
            assert abs(preview['y']-160.5) < .001, preview
            page.mouse.up()
            wait_until(lambda: host.evaluate("el => el._cyreg.cy.getElementById('a').position()") == preview)
            page.get_by_role('button', name='保存', exact=True).click()
            page.get_by_text('已保存', exact=True).wait_for(state='visible')
            page.reload()
            page.wait_for_function("document.querySelector('.netops-cytoscape')?._cyreg?.cy?.edges().length === 2")
            assert host.evaluate("el => el._cyreg.cy.getElementById('a').position()") == preview
            page.screenshot(path=str(output/'topology-drag-released.png'), full_page=True)
            # Native smart-guide feedback differs on/off, without enlarging
            # attraction. Returning near the grab start stays responsive.
            # Reload intentionally restores ?node=a. Wait for that incoming
            # link's initial focus before establishing the test viewport.
            page.wait_for_function("document.querySelector('.netops-cytoscape')?._cyreg?.cy?.zoom() === 1.1")
            host.evaluate("el => {const cy=el._cyreg.cy; cy.stop(); cy.zoom(1); cy.pan({x:30,y:30}); cy.getElementById('a').select();}")
            page.locator('.topology-inspector').wait_for(state='visible')
            for enabled in (False, True):
                page.locator('.studio-guides-menu summary').click()
                page.get_by_role('checkbox', name='智能参考线', exact=True).set_checked(enabled)
                page.keyboard.press('Escape')
                box = host.bounding_box()
                point = host.evaluate("el => el._cyreg.cy.getElementById('a').renderedPosition()")
                origin_y = host.evaluate("el => el._cyreg.cy.getElementById('a').position().y")
                page.mouse.move(box['x']+point['x'], box['y']+point['y'])
                page.mouse.down()
                page.mouse.move(box['x']+point['x'], box['y']+point['y']+8)
                wait_until(lambda: abs(host.evaluate("el => el._cyreg.cy.getElementById('a').position().y")-origin_y-8) < .8)
                device_guides = page.locator('.netops-align-guides line[data-source="device"]')
                wait_until(lambda: bool(device_guides.count()) == enabled)
                page.mouse.move(box['x']+point['x'], box['y']+point['y']+2)
                def position_matches_attraction():
                    distance = host.evaluate("el => el._cyreg.cy.getElementById('a').position().y")-origin_y
                    return abs(distance) < 1 if enabled else abs(distance-2) < .8
                wait_until(position_matches_attraction)
                page.mouse.move(box['x']+point['x'], box['y']+point['y'])
                if enabled:
                    wait_until(lambda: page.locator('.netops-align-guides line[data-source="device"][data-aligned="true"]').count() > 0)
                page.screenshot(path=str(output/('topology-smart-guides-'+('on' if enabled else 'off')+'.png')), full_page=True)
                shown = host.evaluate("el => el._cyreg.cy.getElementById('a').position()")
                page.mouse.up()
                wait_until(lambda: host.evaluate("el => el._cyreg.cy.getElementById('a').position()") == shown)
                wait_until(lambda: page.locator('.netops-align-guides').count() == 0)
            page.get_by_role('button', name='保存', exact=True).click()
            page.get_by_text('已保存', exact=True).wait_for(state='visible')
            # Grouped controls and local reference aids work in native WebView2.
            page.locator('.studio-display-menu summary').click()
            assert page.get_by_text('暂无可显示的检测记录', exact=True).is_visible()
            page.locator('.studio-guides-menu summary').click()
            page.get_by_role('button', name='添加水平参考线', exact=True).click()
            page.get_by_role('spinbutton', name='参考线 1 坐标').fill('300')
            page.get_by_role('checkbox', name='锁定参考线 1').check()
            assert page.get_by_role('spinbutton', name='参考线 1 坐标').is_disabled()
            page.keyboard.press('Escape')
            page.reload()
            page.wait_for_function("document.querySelector('.netops-cytoscape')?._cyreg?.cy?.edges().length === 2")
            assert page.get_by_role('button', name='水平参考线 300 已锁定', exact=True).is_visible()
            page.screenshot(path=str(output/'topology-reference-lines.png'), full_page=True)
            page.locator('.studio-guides-menu summary').click()
            page.get_by_role('button', name='删除参考线 1', exact=True).click()
            page.keyboard.press('Escape')
            page.evaluate("() => {document.querySelector('.netops-cytoscape')._cyreg.cy.getElementById('black').emit('tap');}")
            assert page.get_by_label('自定义拾色器').input_value() == '#000000'
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
        # Reopen the same persisted state twice. Native teardown failures were
        # intermittent, so one successful process exit is insufficient.
        for cycle in range(2):
            report.unlink()
            proc = subprocess.Popen([str(exe.resolve()), '--data-dir', str(data.resolve()), '--smoke-test', str(report.resolve())], env=env)
            start = wait_until(lambda: json.loads(report.read_text(encoding='utf-8')) if report.exists() else None)
            assert start['ok'] and start['tray'] and start['data_dir'] == str(data.resolve())
            hwnd = wintypes.HWND(start['hwnd'])
            wait_until(lambda: user32.IsWindowVisible(hwnd))
            assert (data/'sentinel.txt').read_text(encoding='utf-8') == '卸载保留'
            assert (history/'job_smoke_history.json').is_file()
            assert user32.PostMessageW(hwnd, 0x0010, 0, 0)
            exit_code = proc.wait(timeout=40)
            (output/'result.json').write_text(json.dumps({
                'ok': exit_code == 0, 'mode': mode, 'stage': 'native_close',
                'close_cycles': cycle + 2, 'exit_code': exit_code,
                'exit_hex': f'0x{exit_code & 0xffffffff:08X}',
            }), encoding='utf-8')
            assert exit_code == 0, f'Repeated native close failed: cycle={cycle + 2}, exit={exit_code}'
        desktop_log = (data/'logs/desktop.log').read_text(encoding='utf-8')
        for marker in ('Desktop controller cleaned up', 'Desktop server stopped', 'Desktop device sessions closed', 'Native host cleanup complete; exiting with code 0'):
            assert desktop_log.count(marker) >= 3, marker
    finally:
        if proc.poll() is None:
            # Only the isolated CI process, on test failure.
            proc.terminate(); proc.wait(timeout=20)
        if not report.exists() or proc.returncode:
            for log in (data/'logs').glob('desktop.log*'):
                print(log.read_text(encoding='utf-8',errors='replace')[-15000:])
            if os.name == 'nt' and proc.returncode:
                # A windowed EXE has no console for CLR failures. Keep the
                # corresponding Windows event, without accepting a bad exit.
                diagnostic = subprocess.run([
                    'powershell.exe', '-NoProfile', '-Command',
                    "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | "
                    "Where-Object { $_.ProviderName -in @('.NET Runtime','Application Error') -and $_.Message -match 'lzcore\\.exe' } | "
                    "Select-Object TimeCreated,ProviderName,Message | ConvertTo-Json -Depth 3",
                ], capture_output=True, text=True, errors='replace', timeout=20)
                details = diagnostic.stdout + diagnostic.stderr
                (output/'native-errors.txt').write_text(details, encoding='utf-8')
                print(details)
    (output/'result.json').write_text(json.dumps({'ok':True,'mode':mode,'exe':str(exe),'platform':os.name,'data':str(data),'close_cycles':3,'exit_code':0,'exit_hex':'0x00000000'}),encoding='utf-8')
    return data


if __name__=='__main__':
    args=argparse.ArgumentParser(); args.add_argument('--exe',type=Path,required=True); args.add_argument('--mode',choices=['portable','installed'],required=True); args.add_argument('--output',type=Path,required=True)
    a=args.parse_args(); run(a.exe,a.mode,a.output)
