"""启动真实的 lzcore.exe，经 WebView2 远程调试（CDP）验证打包产物。

    python packaging/windows/smoke.py --exe dist/lzcore/lzcore.exe --mode portable --output <证据目录>

覆盖打包最容易出错的地方，而不是业务细节：
- 进程、窗口、托盘、JS 桥（pywebview）就绪；数据目录与模式正确。
- 新前端每个一级页面与三个网络扩展页面都能加载，没有脚本错误、没有「页面不存在」、没有失败的静态资源。
- Windows 字体、桌面设置对话框、主题切换并持久化、窄窗口不横向溢出。
- 冻结后的文档依赖（PDF、XLSX）与文件存储接口真实可用。
- 原生保存对话框、后台运行与第二次启动唤醒、同源 WebSocket。
- 原生关闭退出码为 0，并对同一数据目录再启动/关闭两次。
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import io
import json
import os
import socket
import subprocess
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
DIALOG_HELPER = HERE.parents[1] / "scripts" / "windows_dialog_smoke.ps1"
PAGES = [
    "/workbench", "/tasks", "/library", "/workflows", "/system", "/system/settings",
    "/extensions", "/extensions/network.operations/manage",
    "/extensions/network.operations/topology", "/extensions/network.operations/skills",
]
WM_CLOSE = 0x0010
LOG_MARKERS = (
    "Desktop controller cleaned up", "Desktop server stopped",
    "Desktop device sessions closed", "Native host cleanup complete; exiting with code 0",
)


def wait_until(call, timeout=90, what="desktop readiness"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = call()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise AssertionError(f"Timed out waiting for {what}")


def read_report(report: Path):
    return json.loads(report.read_text(encoding="utf-8")) if report.exists() else None


def launch(exe: Path, data: Path, report: Path, env: dict[str, str]) -> subprocess.Popen:
    if report.exists():
        report.unlink()
    return subprocess.Popen([str(exe.resolve()), "--data-dir", str(data.resolve()), "--smoke-test", str(report.resolve())], env=env)


def check_pages(page, origin: str, output: Path) -> dict:
    """每个页面：加载完成、主导航在、没有「页面不存在」、没有脚本错误与 4xx/5xx 静态资源。"""
    results = {}
    for path in PAGES:
        errors: list[str] = []
        failed: list[str] = []
        on_error = lambda e: errors.append(str(e))  # noqa: E731
        on_response = lambda r: failed.append(f"{r.status} {r.url}") if r.status >= 400 and "/api/" not in r.url else None  # noqa: E731
        page.on("pageerror", on_error)
        page.on("response", on_response)
        try:
            page.goto(origin + path + "?ws=default", wait_until="load")
            page.get_by_role("navigation", name="主导航").wait_for(timeout=20000)
            page.wait_for_timeout(400)
            body = page.locator("body").inner_text()
            assert "页面不存在" not in body, f"{path}: 页面不存在"
            assert "界面出错了" not in body, f"{path}: 触发了错误边界"
            assert not errors, f"{path}: 脚本错误 {errors}"
            assert not failed, f"{path}: 资源加载失败 {failed}"
            name = path.strip("/").replace("/", "_") or "root"
            page.screenshot(path=str(output / f"page-{name}.png"))
            results[path] = "ok"
        finally:
            page.remove_listener("pageerror", on_error)
            page.remove_listener("response", on_response)
    return results


def check_packaged_documents(page, output: Path) -> dict:
    """冻结后的 PDF/XLSX 依赖与文件存储接口：上传、改名、删除再恢复、解析、渲染页面。"""
    from openpyxl import Workbook
    from PIL import Image
    pdf = io.BytesIO()
    Image.new("RGB", (30, 20), "#eeeeee").save(pdf, format="PDF")
    workbook = io.BytesIO()
    book = Workbook()
    book.active["A1"] = "=1+2"
    book.save(workbook)
    formats = {"pdf": base64.b64encode(pdf.getvalue()).decode(), "xlsx": base64.b64encode(workbook.getvalue()).decode()}
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
      await call('/storage/files/'+fid, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default',name:'已整理 原件.custom',folder:'中文 项目/资料'})});
      await call('/storage/files/'+fid+'?workspace_id=default&confirm=true', {method:'DELETE'});
      await call('/storage/files/'+fid+'/restore', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default'})});
      const actual = new Uint8Array(await (await call('/storage/files/'+fid+'/download?workspace_id=default')).arrayBuffer());
      if (actual.length !== bytes.length || actual.some((v,i)=>v!==bytes[i])) throw new Error('restored bytes changed');
      const checked = {};
      for (const [kind, encoded] of Object.entries(formats)) {
        const f = new FormData(); f.append('file', new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]), '真实格式.'+kind);
        const id = (await (await call('/workspaces/default/artifacts/upload', {method:'POST',body:f})).json()).file.file_id;
        const structure = await (await call('/storage/files/'+id+'/inspect?workspace_id=default')).json();
        if (kind === 'xlsx' && structure.units[0].cells[0].formula !== '=1+2') throw new Error('formula lost');
        if (kind === 'pdf') {
          const rendered = await (await call('/storage/files/'+id+'/page', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:'default',page:1})})).json();
          const image = new Uint8Array(await (await call('/storage/files/'+rendered.image_file_id+'/preview?workspace_id=default')).arrayBuffer());
          if (image[0] !== 137 || image[1] !== 80) throw new Error('page image unavailable');
        }
        checked[kind] = {file_id:id, coverage:structure.coverage};
      }
      return {ok:true, file_id:fid, bytes_preserved:true, formats:checked};
    }""", formats)
    (output / "files.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def check_settings_dialog(page, origin: str, data: Path, output: Path) -> None:
    page.goto(origin + "/workbench?ws=default", wait_until="load")
    page.get_by_role("button", name="桌面设置", exact=True).click()
    dialog = page.get_by_role("dialog", name="桌面设置")
    dialog.wait_for()
    assert dialog.get_by_text("窗口与后台运行").is_visible()
    # 真实的 Windows 字形渲染：标题实际用到雅黑，而不只是 CSS 声明。
    cdp = page.context.new_cdp_session(page)
    cdp.send("DOM.enable")
    cdp.send("CSS.enable")
    root = cdp.send("DOM.getDocument")["root"]["nodeId"]
    title = cdp.send("DOM.querySelector", {"nodeId": root, "selector": ".dialog .dialog-title"})["nodeId"]
    fonts = cdp.send("CSS.getPlatformFontsForNode", {"nodeId": title})["fonts"]
    cdp.detach()
    assert any(f["familyName"] in ("Microsoft YaHei UI", "Microsoft YaHei") and f["glyphCount"] > 0 for f in fonts), fonts
    (output / "font-rendering.json").write_text(json.dumps(fonts, ensure_ascii=False), encoding="utf-8")
    dialog.get_by_label("主题").select_option("dark")
    page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
    wait_until(lambda: json.loads((data / ".runtime/desktop.json").read_text(encoding="utf-8"))["ui"]["theme"] == "dark", what="theme persisted")
    page.screenshot(path=str(output / "desktop-settings.png"))
    dialog.get_by_role("button", name="完成", exact=True).click()


def check_native_save(page, proc: subprocess.Popen, output: Path) -> None:
    exported = output / "中文 导出.txt"
    payload = base64.b64encode("真实原生导出".encode()).decode()
    page.evaluate(f"window.__exportResult=null; void window.pywebview.api.save_file('测试.txt', '{payload}', 'text/plain').then(r=>window.__exportResult=r)")
    subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(DIALOG_HELPER),
                    "-ParentPid", str(proc.pid), "-FileName", str(exported.resolve())], check=True, timeout=35)
    page.wait_for_function("window.__exportResult !== null", timeout=20000)
    assert exported.read_text(encoding="utf-8") == "真实原生导出", page.evaluate("window.__exportResult")


def check_websocket(page) -> None:
    assert page.evaluate("""async () => {
      const token = (await (await fetch('/api/local-token')).json()).token;
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws/agent');
        const timer = setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 10000);
        ws.onopen = () => ws.send(JSON.stringify({type:'ping', workspace_id:'default', local_token:token}));
        ws.onmessage = e => { const f = JSON.parse(e.data); if (f.type === 'pong') { clearTimeout(timer); ws.close(); resolve(true); } };
        ws.onerror = () => reject(new Error('WS failed'));
      });
    }""")


def close_window(proc: subprocess.Popen, hwnd, output: Path, mode: str, cycle: int) -> None:
    user32 = ctypes.windll.user32
    assert user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    code = proc.wait(timeout=40)
    (output / "result.json").write_text(json.dumps({
        "ok": code == 0, "mode": mode, "stage": "native_close", "close_cycles": cycle,
        "exit_code": code, "exit_hex": f"0x{code & 0xffffffff:08X}",
    }), encoding="utf-8")
    assert code == 0, f"Native close failed: cycle={cycle}, exit=0x{code & 0xffffffff:08X}"


def run(exe: Path, mode: str, output: Path) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    data = output / "中文 用户数据"
    report = output / "startup.json"
    user32 = ctypes.windll.user32
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        cdp_port = probe.getsockname()[1]
    env = {**os.environ, "LZCORE_SMOKE_CDP_PORT": str(cdp_port), "LZCORE_EMBEDDED_WORKER": "true",
           "PYTHONUTF8": "1", "LZCORE_LLM_ENABLED": "false"}
    proc = launch(exe, data, report, env)
    summary: dict = {"mode": mode, "exe": str(exe)}
    try:
        start = wait_until(lambda: read_report(report), what="startup report")
        assert start["ok"] and start["mode"] == mode and start["hwnd"] and start["tray"], start
        assert start["data_dir"] == str(data.resolve()), start
        hwnd = wintypes.HWND(start["hwnd"])
        assert user32.IsWindowVisible(hwnd)
        origin = start["origin"]
        wait_until(lambda: urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version").status == 200, what="CDP")
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
            page = wait_until(lambda: next((x for c in browser.contexts for x in c.pages if x.url.startswith(origin)), None), what="app page")
            page.wait_for_function("Boolean(window.pywebview?.api?.get_info)", timeout=60000)
            assert page.locator("html").get_attribute("data-desktop-platform") == "win32"
            info = page.evaluate("window.pywebview.api.get_info()")
            assert info["ok"] and info["data_dir"] == str(data.resolve()) and info["mode"] == mode, info
            assert user32.MoveWindow(hwnd, 40, 40, 1366, 860, True)
            summary["pages"] = check_pages(page, origin, output)
            check_settings_dialog(page, origin, data, output)
            # 窄窗口：原生 HWND 缩放，WebView 布局不能横向溢出。
            assert user32.MoveWindow(hwnd, 40, 40, 640, 600, True)
            page.wait_for_timeout(600)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "narrow window overflows"
            page.screenshot(path=str(output / "desktop-narrow.png"))
            assert user32.MoveWindow(hwnd, 40, 40, 1280, 860, True)
            summary["documents"] = check_packaged_documents(page, output)
            check_native_save(page, proc, output)
            # 后台运行不停服务；第二次启动唤醒原窗口。
            page.evaluate("window.pywebview.api.request_exit('background')")
            wait_until(lambda: not user32.IsWindowVisible(hwnd), timeout=10, what="hide to tray")
            assert urllib.request.urlopen(origin + "/api/health").status == 200
            second = subprocess.run([str(exe.resolve()), "--data-dir", str(data.resolve())], env=env, timeout=20)
            assert second.returncode == 0
            wait_until(lambda: user32.IsWindowVisible(hwnd), what="second launch wakes window")
            check_websocket(page)
            assert page.evaluate("window.pywebview.api.get_info()")["active_jobs"] == 0
            (data / "sentinel.txt").write_text("卸载保留", encoding="utf-8")
            close_window(proc, hwnd, output, mode, 1)
        # 原生退出曾间歇失败：同一数据目录再启动、关闭两次。
        for cycle in (2, 3):
            proc = launch(exe, data, report, env)
            start = wait_until(lambda: read_report(report), what=f"restart {cycle}")
            assert start["ok"] and start["tray"] and start["data_dir"] == str(data.resolve())
            hwnd = wintypes.HWND(start["hwnd"])
            wait_until(lambda: user32.IsWindowVisible(hwnd), what="window visible")
            assert (data / "sentinel.txt").read_text(encoding="utf-8") == "卸载保留"
            close_window(proc, hwnd, output, mode, cycle)
        log_text = (data / "logs/desktop.log").read_text(encoding="utf-8")
        for marker in LOG_MARKERS:
            assert log_text.count(marker) >= 3, f"desktop.log 缺少 3 次「{marker}」"
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=20)
        if proc.returncode:
            for log in (data / "logs").glob("desktop.log*"):
                print(log.read_text(encoding="utf-8", errors="replace")[-15000:])
            diagnostic = subprocess.run([
                "powershell.exe", "-NoProfile", "-Command",
                "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | "
                "Where-Object { $_.ProviderName -in @('.NET Runtime','Application Error') -and $_.Message -match 'lzcore\\.exe' } | "
                "Select-Object TimeCreated,ProviderName,Message | ConvertTo-Json -Depth 3",
            ], capture_output=True, text=True, errors="replace", timeout=20)
            (output / "native-errors.txt").write_text(diagnostic.stdout + diagnostic.stderr, encoding="utf-8")
            print(diagnostic.stdout + diagnostic.stderr)
    summary.update({"ok": True, "close_cycles": 3, "exit_code": 0})
    (output / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--mode", choices=["portable", "installed"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.exe, args.mode, args.output)
