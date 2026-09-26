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

import logging
import multiprocessing
import os
import shutil
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

# 强制 Python 环境在 Windows (包括 GBK/CP936 区域) 下全链路采用 UTF-8 编码
os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"
if sys.platform.startswith("win"):
    try:
        if hasattr(sys.stdin, "reconfigure") and sys.stdin:
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stdout, "reconfigure") and sys.stdout:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure") and sys.stderr:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # Windows High-DPI 高分屏感知（优先 Per-Monitor V2，杜绝 125%/150% 缩放下字体与拓扑图发虚）
    try:
        import ctypes
        try:
            # -4 代表 DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Win10 1703+)
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:
            try:
                # 2 代表 PROCESS_PER_MONITOR_DPI_AWARE (Win8.1+)
                ctypes.windll.shcore.SetProcessDpiAwareness(2)
            except Exception:
                ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

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

# 3. 配置持久化与日志重定向（解决 Windows console=False 下 stdout 为 None 的静默闪退问题）
LOG_FILE = APP_DIR / "lzcore_desktop.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(str(LOG_FILE), encoding="utf-8"),
    ],
)
logger = logging.getLogger("lzcore.desktop")


class StreamToLogger:
    """Redirect stream writes (e.g. print, uncaught errors) to log file."""

    def __init__(self, target_logger, level, original=None):
        self.logger = target_logger
        self.level = level
        self.original = original
        self.buf = ""

    def write(self, msg):
        if self.original:
            try:
                self.original.write(msg)
            except Exception:
                pass
        if not msg:
            return
        self.buf += str(msg)
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                self.logger.log(self.level, line)

    def flush(self):
        if self.original:
            try:
                self.original.flush()
            except Exception:
                pass
        if self.buf.strip():
            self.logger.log(self.level, self.buf.strip())
            self.buf = ""


# PyInstaller console=False 模式下 sys.stdout / sys.stderr 为 None，重定向至日志
orig_out = sys.stdout
orig_err = sys.stderr
sys.stdout = StreamToLogger(logger, logging.INFO, original=orig_out)
sys.stderr = StreamToLogger(logger, logging.ERROR, original=orig_err)

# 4. 配置持久化数据目录与 WebView2 缓存隔离
WORKSPACE_ROOT = APP_DIR / "workspaces"
if "LZCORE_WORKSPACE_ROOT" not in os.environ and "LZCORE_WORKSPACE_DIR" not in os.environ:
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(WORKSPACE_ROOT)

if "LZCORE_CONFIG_DIR" in os.environ:
    CONFIG_DIR = Path(os.environ["LZCORE_CONFIG_DIR"])
else:
    CONFIG_DIR = APP_DIR / "config"
    os.environ["LZCORE_CONFIG_DIR"] = str(CONFIG_DIR)

# 将 WebView2 临时缓存（EBWebView）隔离到 .runtime/webview2_cache，避免散落在绿色便携根目录
RUNTIME_DIR = APP_DIR / ".runtime"
WEBVIEW2_CACHE = RUNTIME_DIR / "webview2_cache"
WEBVIEW2_CACHE.mkdir(parents=True, exist_ok=True)
os.environ["WEBVIEW2_USER_DATA_FOLDER"] = str(WEBVIEW2_CACHE)

# 5. 配置本地环境
os.environ["LZCORE_EMBEDDED_WORKER"] = "true"
os.environ["LZCORE_RUNTIME_BIND_HOST"] = "127.0.0.1"

_MUTEX_HANDLE = None


def check_single_instance() -> bool:
    """Windows 单实例互斥保护：防止用户连续双击拉起多个进程。若已有实例，唤醒并置顶窗口后退出。"""
    global _MUTEX_HANDLE
    if not sys.platform.startswith("win"):
        return True
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        mutex_name = "Global\\LZCoreDesktopSingleInstanceMutex_v3"
        _MUTEX_HANDLE = kernel32.CreateMutexW(None, False, mutex_name)
        last_error = kernel32.GetLastError()
        ERROR_ALREADY_EXISTS = 183
        if last_error == ERROR_ALREADY_EXISTS:
            logger.warning("检测到已有联智中枢实例正在运行，唤醒已有窗口并退出当前实例。")
            try:
                def enum_windows_callback(hwnd, _extra):
                    length = user32.GetWindowTextLengthW(hwnd)
                    if length > 0:
                        buff = ctypes.create_unicode_buffer(length + 1)
                        user32.GetWindowTextW(hwnd, buff, length + 1)
                        if "联智中枢" in buff.value:
                            SW_RESTORE = 9
                            user32.ShowWindow(hwnd, SW_RESTORE)
                            user32.SetForegroundWindow(hwnd)
                            return False
                    return True

                WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
                user32.EnumWindows(WNDENUMPROC(enum_windows_callback), 0)
            except Exception:
                pass
            return False
    except Exception as exc:
        logger.warning("单实例互斥检查跳过: %s", exc)
    return True


def init_local_environment():
    """初始化本地数据目录与默认工作区结构，确保开箱即用且数据完全保留在用户本地"""
    try:
        # 1. 复制默认配置目录
        if not CONFIG_DIR.is_dir():
            bundle_cfg = BUNDLE_DIR / "config"
            if bundle_cfg.is_dir():
                shutil.copytree(bundle_cfg, CONFIG_DIR)
                logger.info("已初始化本地配置目录: %s", CONFIG_DIR)

        # 2. 确保默认工作区基础结构与索引就绪
        from storage.workspace_store import ensure_workspace
        ensure_workspace("default")
        logger.info("已初始化默认工作区: default")

        # 3. 确保网络拓扑存储目录就绪（纯净环境，完全由用户本地创建与保存）
        topo_dir = WORKSPACE_ROOT / "default" / "extensions" / "network_operations" / "topologies"
        topo_dir.mkdir(parents=True, exist_ok=True)
        logger.info("网络拓扑数据存储目录已就绪: %s", topo_dir)

    except Exception as exc:
        logger.error("初始化本地环境失败: %s", exc, exc_info=True)


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


class DesktopApi:
    """
    通过 pywebview js_api 暴露给前端的原生桌面能力。
    JS 端通过 window.pywebview.api.save_file(...) 调用。
    """

    def __init__(self):
        self._window = None

    def set_window(self, window):
        """由启动流程调用，注入 pywebview window 引用以便使用原生文件对话框。"""
        self._window = window

    def save_file(self, filename: str, data_base64: str, mime: str = "image/png") -> dict:
        """
        弹出系统原生"另存为"对话框，将 base64 编码的文件内容写入用户选择的路径。

        Args:
            filename: 建议的文件名（含扩展名），显示在对话框默认文件名框中
            data_base64: 文件二进制内容的 base64 编码字符串（不含 data: 前缀）
            mime: MIME 类型，用于过滤对话框文件类型

        Returns:
            {"ok": True, "path": "<保存路径>"} 或 {"ok": False, "error": "<原因>"}
        """
        import base64
        try:
            # 解析 base64（兼容带 data:xxx;base64, 前缀的格式）
            if "," in data_base64:
                data_base64 = data_base64.split(",", 1)[1]
            raw = base64.b64decode(data_base64)
        except Exception as exc:
            logger.error("save_file: base64 解码失败: %s", exc)
            return {"ok": False, "error": f"base64_decode_error: {exc}"}

        # 使用 pywebview 自带的原生保存文件对话框（不依赖 tkinter，不会阻塞主线程）
        try:
            import webview
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
            type_map = {
                "png": ("PNG 图像 (*.png)",),
                "svg": ("SVG 矢量图 (*.svg)",),
                "pdf": ("PDF 文档 (*.pdf)",),
            }
            file_types = type_map.get(ext, ("所有文件 (*.*)",))

            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=filename,
                file_types=file_types,
            )
        except Exception as exc:
            logger.error("save_file: 打开保存对话框失败: %s", exc)
            return {"ok": False, "error": f"dialog_error: {exc}"}

        if not result:
            # 用户点击了取消
            return {"ok": False, "error": "cancelled"}

        save_path = result if isinstance(result, str) else result[0]

        try:
            Path(save_path).write_bytes(raw)
            logger.info("save_file: 文件已保存至 %s (%d bytes)", save_path, len(raw))
            return {"ok": True, "path": save_path}
        except Exception as exc:
            logger.error("save_file: 写文件失败: %s", exc)
            return {"ok": False, "error": f"write_error: {exc}"}


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
        except Exception as exc:
            logger.error("后台服务器异常退出: %s", exc, exc_info=True)

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

    # 检查单实例互斥（Windows），防止多开冲突
    if not args.web_only and not check_single_instance():
        sys.exit(0)

    port = args.port if args.port > 0 else find_free_port()
    os.environ["LZCORE_PORT"] = str(port)

    # 1. 获取版本号
    try:
        from agent import __version__ as APP_VERSION
    except Exception:
        APP_VERSION = "3.2.2"

    logger.info("启动联智中枢桌面内核 v%s ...", APP_VERSION)
    logger.info("运行时资源目录: %s", BUNDLE_DIR)
    logger.info("数据持久化目录: %s", WORKSPACE_ROOT)

    # 2. 初始化本地数据环境
    init_local_environment()

    # 3. 初始化核心后端
    from backend.main import create_app
    flask_app = create_app()

    # 4. 挂载前端静态单页
    dist_dir = BUNDLE_DIR / "frontend" / "dist"
    if not dist_dir.is_dir():
        dist_dir = APP_DIR / "frontend" / "dist"
    mount_frontend_spa(flask_app, dist_dir)

    # 5. 后台运行本地服务
    server = BackgroundServerThread(flask_app, "127.0.0.1", port)
    server.start()

    if not wait_for_server(port):
        logger.warning("端口 %d 响应超时，正在尝试继续启动窗口...", port)

    app_url = f"http://127.0.0.1:{port}"
    logger.info("内核服务已就绪: %s", app_url)

    # 6. 纯 Web 模式直接打开默认浏览器
    if args.web_only:
        import webbrowser
        webbrowser.open(app_url)
        logger.info("已在浏览器中打开，按 Ctrl+C 退出程序。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            server.shutdown()
            sys.exit(0)

    # 7. 原生桌面窗口模式 (PyWebView)
    try:
        import webview
    except ImportError:
        logger.warning("未检测到 pywebview，降级为默认浏览器打开。可在终端安装: pip install pywebview")
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
        APP_DIR / "lzcore.ico",
    ]:
        if candidate.is_file():
            icon_path = str(candidate)
            break

    # 动态适应当前屏幕尺寸，自适应视口
    init_w, init_h = 1440, 900
    try:
        screens = webview.screens
        if screens:
            primary = screens[0]
            # 还原窗口状态时的尺寸自适应为屏幕的 92% 宽和 88% 高，居中舒适
            init_w = max(1024, int(primary.width * 0.92))
            init_h = max(680, int(primary.height * 0.88))
    except Exception:
        pass

    # 创建桌面窗口：初始贴合当前屏幕（最大化铺满工作区，保留任务栏）
    desktop_api = DesktopApi()
    window_kwargs = {
        "title": window_title,
        "url": app_url,
        "width": init_w,
        "height": init_h,
        "min_size": (1024, 680),
        "resizable": True,
        "maximized": True,  # 初始尺寸直接贴合当前屏幕，全屏展示画布
        "text_select": True,
        "background_color": "#ffffff",
        "js_api": desktop_api,  # 原生桌面能力（保存对话框等）暴露给前端
    }

    window = webview.create_window(**window_kwargs)
    desktop_api.set_window(window)

    # Windows 优先调用内置的 Edge WebView2 内核
    gui_engine = "edgechromium" if sys.platform == "win32" else None

    logger.info("正在唤起桌面应用窗口 (初始全屏工作区模式)...")
    try:
        webview.start(gui=gui_engine, debug=False)
    finally:
        logger.info("桌面窗口已关闭，正在清理后台线程...")
        server.shutdown()
        # 释放单实例互斥锁
        if _MUTEX_HANDLE:
            try:
                import ctypes
                ctypes.windll.kernel32.CloseHandle(_MUTEX_HANDLE)
            except Exception:
                pass
        logger.info("应用程序安全退出。")
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logger.critical("主程序启动崩溃: %s", exc, exc_info=True)
        try:
            import html
            import webview
            safe_err = html.escape(str(exc))
            safe_log = html.escape(str(LOG_FILE))
            webview.create_window(
                "启动失败 - 联智中枢",
                html=(
                    f"<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
                    f"<body style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:30px;line-height:1.6;color:#1e293b;background:#f8fafc;'>"
                    f"<h2 style='color:#dc2626;margin-top:0;'>程序启动发生异常</h2>"
                    f"<p style='margin-bottom:8px;font-weight:600;'>错误详情：</p>"
                    f"<pre style='background:#f1f5f9;border:1px solid #cbd5e1;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;color:#334155;'>{safe_err}</pre>"
                    f"<p style='font-size:13px;color:#64748b;'>详细运行日志已写入：<code style='background:#e2e8f0;padding:2px 6px;border-radius:4px;'>{safe_log}</code></p>"
                    f"</body></html>"
                ),
                width=680,
                height=400,
            )
            webview.start()
        except Exception:
            pass
        sys.exit(1)
