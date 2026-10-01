#!/usr/bin/env python3
"""联智中枢：同一应用入口，便携版和每用户安装版。"""
from __future__ import annotations
import argparse
import json
import logging
import logging.handlers
import multiprocessing
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import urllib.request


def find_free_port(preferred=8011):
    for port in dict.fromkeys((preferred, 8012, 8013, 0)):
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return probe.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError('没有可用的本地端口')


class BackgroundServerThread(threading.Thread):
    def __init__(self, app, port):
        from werkzeug.serving import make_server
        super().__init__(daemon=True, name='desktop-http')
        self.server = make_server('127.0.0.1', port, app, threaded=True)
    def run(self):
        self.server.serve_forever()
    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def mount_frontend_spa(app, dist_dir, bootstrap=None):
    from flask import abort, make_response, send_from_directory
    root = Path(dist_dir).resolve()
    if not (root / 'index.html').is_file():
        raise RuntimeError('缺少前端构建产物，请先构建 frontend')
    def index():
        html = (root / 'index.html').read_text(encoding='utf-8')
        if bootstrap is not None:
            payload = json.dumps(bootstrap, ensure_ascii=True).replace('<', '\\u003c')
            html = html.replace('<head>', '<head><script>window.__LZCORE_DESKTOP__=' + payload + ';</script>', 1)
        response = make_response(html)
        response.headers['Cache-Control'] = 'no-store'
        return response
    app.view_functions['backend_root'] = index
    @app.route('/<path:path>')
    def desktop_asset(path):
        if path.startswith(('api/', 'ws/')):
            abort(404)
        target = (root / path).resolve()
        if root in target.parents and target.is_file():
            return send_from_directory(root, path)
        return index()


def configure_logging(paths):
    from storage.redaction import redact_text
    class RedactedFormatter(logging.Formatter):
        def format(self, record):
            return redact_text(super().format(record))
    folder = paths.data / 'logs'
    folder.mkdir(exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(folder / 'desktop.log', maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
    handler.setFormatter(RedactedFormatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    class LogStream:
        def __init__(self):
            self.buffer = ''
        def write(self, value):
            self.buffer += value
            while '\n' in self.buffer:
                line, self.buffer = self.buffer.split('\n', 1)
                if line.strip():
                    logging.getLogger('desktop.console').info('%s', line)
            return len(value)
        def flush(self):
            if self.buffer.strip():
                logging.getLogger('desktop.console').info('%s', self.buffer)
            self.buffer = ''
        def isatty(self):
            return False
    if sys.stdout is None:
        sys.stdout = LogStream()
    if sys.stderr is None:
        sys.stderr = LogStream()


def main():
    os.environ['PYTHONUTF8'] = '1'
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    if sys.platform == 'win32':
        import ctypes
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except (AttributeError, OSError):
            ctypes.windll.user32.SetProcessDPIAware()
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8011)
    parser.add_argument('--data-dir')
    parser.add_argument('--web-only', action='store_true')
    parser.add_argument('--background', action='store_true')
    parser.add_argument('--smoke-test', metavar='REPORT')
    args = parser.parse_args()
    frozen = bool(getattr(sys, 'frozen', False))
    app_dir = Path(sys.executable).resolve().parent if frozen else Path(__file__).resolve().parent
    bundle = Path(sys._MEIPASS).resolve() if frozen else app_dir
    from desktop_app.environment import resolve_paths, prepare_paths, migrate_legacy, seed_config
    from desktop_app.backup import apply_pending_restore
    from desktop_app.window import wake_instance, monitors, fit_window, system_theme
    from desktop_app.controller import DesktopController, DesktopApi
    from agent.runtime.local_lifecycle import LocalLifecycle, install_local_lifecycle
    from storage.locking import FileLock
    paths = resolve_paths(app_dir, bundle, frozen=frozen, data_dir=args.data_dir)
    prepare_paths(paths)
    guard = FileLock(paths.runtime / 'desktop-instance.lock', timeout=0)
    try:
        guard.__enter__()
    except TimeoutError:
        wake_instance(paths.runtime / 'instance.json')
        return 0
    server = controller = None
    try:
        configure_logging(paths)
        apply_pending_restore(paths.data)
        migrate_legacy(paths)
        seed_config(paths)
        from storage.workspace_store import ensure_workspace
        ensure_workspace('default')
        try:
            build = json.loads((paths.app / 'build-info.json').read_text(encoding='utf-8'))
            os.environ['LZCORE_BUILD_COMMIT'] = str(build.get('commit', ''))
        except (OSError, ValueError):
            pass
        port = find_free_port(args.port)
        os.environ['LZCORE_PORT'] = str(port)
        gate = LocalLifecycle()
        install_local_lifecycle(gate)
        from backend.main import app
        from agent import __version__
        origin = f'http://127.0.0.1:{port}'
        controller = DesktopController(paths, __version__, gate, origin)
        ui = controller.state.snapshot().get('ui', {})
        if ui.get('themePreference', 'system') == 'system':
            ui = {**ui, 'theme': system_theme(), 'themePreference': 'system'}
        mount_frontend_spa(app, bundle / 'frontend' / 'dist', None if args.web_only else {'theme': ui.get('theme', 'light'), 'ui': ui})
        server = BackgroundServerThread(app, port)
        server.start()
        for _ in range(120):
            try:
                with urllib.request.urlopen(origin + '/api/health', timeout=1) as response:
                    if response.status == 200:
                        break
            except Exception:
                time.sleep(.1)
        else:
            raise RuntimeError('本地服务启动失败，请查看数据目录中的日志')
        if args.web_only:
            import webbrowser
            webbrowser.open(origin)
            try:
                while server.is_alive():
                    time.sleep(.5)
            except KeyboardInterrupt:
                pass
            return 0
        import webview
        if (bundle / 'webview2').is_dir():
            webview.settings['WEBVIEW2_RUNTIME_PATH'] = str(bundle / 'webview2')
            if sys.platform == 'win32' and sys.getwindowsversion().build < 22000:
                for sid in ('*S-1-15-2-1:(OI)(CI)(RX)', '*S-1-15-2-2:(OI)(CI)(RX)'):
                    permission = subprocess.run([str(Path(os.environ['SystemRoot']) / 'System32' / 'icacls.exe'), str(bundle / 'webview2'), '/grant', sid], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    if permission.returncode:
                        raise RuntimeError('WebView2 沙箱读取权限设置失败，请选择可写的本地程序目录')
        if args.smoke_test:
            webview.settings['REMOTE_DEBUGGING_PORT'] = int(os.environ.get('LZCORE_SMOKE_CDP_PORT', '9222'))
        screens = monitors()
        screen = next((x for x in screens if x['primary']), None)
        bounds = fit_window({}, screen['area'], screen['scale']) if screen else (0, 0, 1180, 760)
        window = webview.create_window('联智中枢', origin, js_api=DesktopApi(controller), width=bounds[2], height=bounds[3], min_size=(500, 420), resizable=True, background_color='#171c21' if ui.get('theme') == 'dark' else '#fafafa')
        controller.attach(window)
        def ready():
            controller.native.attach()
            controller.start_tray()
            if args.background and controller.tray:
                controller.hide()
            if args.smoke_test:
                from storage.atomic_io import atomic_write_json
                atomic_write_json(Path(args.smoke_test), {'ok': True, 'pid': os.getpid(), 'hwnd': controller.native.hwnd, 'origin': origin, 'mode': paths.mode, 'data_dir': str(paths.data), 'version': __version__, 'tray': bool(controller.tray)})
        window.events.loaded += ready
        webview.start(gui='edgechromium' if sys.platform == 'win32' else None, debug=False, private_mode=False, storage_path=str(paths.runtime / 'webview2'))
    finally:
        if controller:
            controller.cleanup()
        if server:
            server.stop()
        guard.__exit__(None, None, None)
    if controller and controller.restart:
        command = [sys.executable] if frozen else [sys.executable, str(app_dir / 'desktop.py')]
        subprocess.Popen([*command, '--data-dir', str(paths.data)])
    return 0


if __name__ == '__main__':
    multiprocessing.freeze_support()
    try:
        raise SystemExit(main())
    except Exception as exc:
        from storage.redaction import redact_text
        logging.exception('Desktop startup failed')
        message = redact_text(str(exc))[:600]
        if sys.platform == 'win32':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, '联智中枢启动失败', 0x10)
        else:
            print(message, file=sys.stderr)
        raise SystemExit(1)
