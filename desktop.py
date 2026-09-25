#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
联智中枢 (LZCore) — 桌面原生应用程序入口 (Desktop Runner)

说明：
    通过内嵌微型引擎与本地原生 WebView 容器，将联智中枢封装为开箱即用的独立桌面程序。
    不依赖浏览器标签栏与外部 Web 端口暴露，启动后自动呈现独立桌面程序窗口。

支持模式：
    - 直接运行: python desktop.py
    - 编译打包: 通过 PyInstaller 打包为 Windows lzcore.exe
"""

import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

# 1. Windows 下 PyInstaller 多进程必备保护
multiprocessing.freeze_support()

# 2. 确定运行时资源路径与数据持久化路径
if getattr(sys, "frozen", False):
    # PyInstaller 解压运行目录（包含内置前端产物与依赖代码）
    BUNDLE_DIR = Path(sys._MEIPASS).resolve()
    # 实际可执行文件所在的真实目录（用于持久化保存用户数据）
    APP_DIR = Path(sys.executable).parent.resolve()
else:
    BUNDLE_DIR = Path(__file__).resolve().parent
    APP_DIR = BUNDLE_DIR

# 确保项目模块在 sys.path 中
if str(BUNDLE_DIR) not in sys.path:
    sys.path.insert(0, str(BUNDLE_DIR))

# 3. 配置持久化数据目录（保存在 exe 同级的 workspaces 目录中，实现绿色便携版）
if "LZCORE_WORKSPACE_ROOT" not in os.environ and "LZCORE_WORKSPACE_DIR" not in os.environ:
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(APP_DIR / "workspaces")

# 4. 配置本地环境
os.environ["LZCORE_EMBEDDED_WORKER"] = "true"
os.environ["LZCORE_ALLOW_UNAUTHENTICATED_NETWORK"] = "true"
os.environ["LZCORE_RUNTIME_BIND_HOST"] = "127.0.0.1"


def find_free_port() -> int:
    """寻找本地 127.0.0.1 空闲端口，优先使用 8011"""
    for preferred in (8011, 8012, 8013):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", preferred))
            s.close()
            return preferred
        except OSError:
            continue

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class BackgroundServerThread(threading.Thread):
    """在后台独立线程中托管 Flask 服务"""

    def __init__(self, app, host: str, port: int):
        super().__init__(daemon=True)
        from werkzeug.serving import make_server
        self.server = make_server(host, port, app, threaded=True)
        self.host = host
        self.port = port
        self.ctx = app.app_context()
        self.ctx.push()

    def run(self):
        try:
            self.server.serve_forever()
        except Exception:
            pass

    def shutdown(self):
        try:
            self.server.shutdown()
        except Exception:
            pass


def mount_frontend_spa(app, dist_dir: Path):
    """将前端编译产物挂载至 Flask，作为 SPA 单页应用由根路径统一路由"""
    from flask import send_from_directory, jsonify

    has_dist = (dist_dir / "index.html").is_file()

    def serve_index():
        if not has_dist:
            return (
                "<html><body style='font-family:sans-serif;padding:40px;text-align:center;'>"
                "<h2>前端构建产物未找到</h2>"
                "<p>请先在项目根目录下执行 <code>npm --prefix frontend run build</code> 完成构建。</p>"
                "</body></html>",
                200,
                {"Content-Type": "text/html; charset=utf-8"},
            )
        return send_from_directory(str(dist_dir), "index.html")

    # 覆盖原先仅用于开发说明的 backend_root API
    if "backend_root" in app.view_functions:
        app.view_functions["backend_root"] = serve_index

    @app.route("/<path:path>")
    def serve_spa_path(path):
        if path.startswith("api/"):
            return jsonify({"ok": False, "error": "api_not_found"}), 404

        if not has_dist:
            return serve_index()

        target = dist_dir / path
        if path and target.is_file():
            return send_from_directory(str(dist_dir), path)
        return send_from_directory(str(dist_dir), "index.html")


def wait_for_server(port: int, timeout: float = 8.0) -> bool:
    """等待后台服务准备就绪"""
    start = time.time()
    url = f"http://127.0.0.1:{port}/api/health"
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def main():
    import argparse
    parser = argparse.ArgumentParser(description="联智中枢桌面程序")
    parser.add_argument("--port", type=int, default=0, help="自定义本地端口 (默认自动分配)")
    parser.add_argument("--web-only", action="store_true", help="以常规浏览器模式运行，不拉起桌面窗体")
    args = parser.parse_args()

    port = args.port if args.port > 0 else find_free_port()
    os.environ["LZCORE_PORT"] = str(port)

    # 1. 获取版本号
    try:
        from agent import __version__ as APP_VERSION
    except Exception:
        APP_VERSION = "3.1.0"

    print(f"[*] 启动联智中枢桌面内核 v{APP_VERSION} ...")
    print(f"[*] 数据工作区目录: {os.environ['LZCORE_WORKSPACE_ROOT']}")

    # 2. 初始化核心后端
    from backend.main import create_app
    flask_app = create_app()

    # 3. 挂载前端静态单页
    dist_dir = BUNDLE_DIR / "frontend" / "dist"
    mount_frontend_spa(flask_app, dist_dir)

    # 4. 后台运行本地服务
    server = BackgroundServerThread(flask_app, "127.0.0.1", port)
    server.start()

    if not wait_for_server(port):
        print(f"[!] 警告：端口 {port} 响应超时，正在尝试继续启动窗口...")

    app_url = f"http://127.0.0.1:{port}"
    print(f"[*] 内核服务已就绪: {app_url}")

    # 5. 纯 Web 模式直接打开默认浏览器
    if args.web_only:
        import webbrowser
        webbrowser.open(app_url)
        print("[*] 已在浏览器中打开，按 Ctrl+C 退出程序。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.shutdown()
            sys.exit(0)

    # 6. 原生桌面窗口模式 (PyWebView)
    try:
        import webview
    except ImportError:
        print("[!] 未检测到 pywebview，降级为默认浏览器打开。可在终端安装: pip install pywebview")
        import webbrowser
        webbrowser.open(app_url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.shutdown()
            sys.exit(0)

    window_title = f"联智中枢 v{APP_VERSION}"
    
    # 查找程序图标
    icon_path = None
    for candidate in [
        BUNDLE_DIR / "lzcore.ico",
        BUNDLE_DIR / "frontend" / "public" / "favicon.ico",
        BUNDLE_DIR / "frontend" / "dist" / "favicon.ico",
    ]:
        if candidate.is_file():
            icon_path = str(candidate)
            break

    # 创建桌面窗口
    window_kwargs = {
        "title": window_title,
        "url": app_url,
        "width": 1440,
        "height": 900,
        "min_size": (1024, 680),
        "resizable": True,
        "text_select": True,
        "background_color": "#ffffff",
    }

    window = webview.create_window(**window_kwargs)

    # Windows 优先调用内置的 Edge WebView2 内核
    gui_engine = "edgechromium" if sys.platform == "win32" else None

    print("[*] 正在唤起桌面应用窗口...")
    try:
        webview.start(gui=gui_engine, debug=False)
    finally:
        print("[*] 桌面窗口已关闭，正在清理后台线程...")
        server.shutdown()
        print("[*] 应用程序安全退出。")
        sys.exit(0)


if __name__ == "__main__":
    main()
