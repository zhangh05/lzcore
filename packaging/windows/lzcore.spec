# -*- mode: python ; coding: utf-8 -*-
"""联智中枢 PyInstaller 规格。只通过 packaging/windows/build.py 调用。

单目录（onedir）产物：dist/lzcore/lzcore.exe + _internal/。
- 前端只打包生产构建 frontend/dist。
- config 只打包示例与 logging.yaml；真实配置与密钥在用户数据目录生成，绝不进包。
- 扩展只打包运行时文件（manifest、Python、提示词等），不带前端源码。
"""
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(os.environ["LZCORE_ROOT"]).resolve()
VERSION_FILE = os.environ["LZCORE_VERSION_FILE"]
ICON = ROOT / "lzcore.ico"

PROJECT_PACKAGES = [
    "desktop_app", "agent", "artifacts", "backend", "core", "extensions",
    "jobs", "observability", "prompts", "storage", "workflows",
]

hidden = [
    "webview.platforms.winforms",
    "webview.platforms.edgechromium",
    "clr_loader",
    "pythonnet",
    "werkzeug.serving",
    "simple_websocket",
    "wsproto",
    "h11",
    # 运行期按需导入的文档/网络依赖，静态分析可能看不到。
    "flask", "flask_sock", "yaml", "lxml", "bs4", "paramiko", "cryptography", "requests",
    "PIL", "openpyxl", "docx", "pptx", "dateparser", "trafilatura", "pdfplumber",
]
for package in PROJECT_PACKAGES:
    hidden += collect_submodules(package)

datas = [
    (str(ROOT / "frontend" / "dist"), "frontend/dist"),
    (str(ROOT / "prompts"), "prompts"),
    (str(ROOT / "scripts" / "windows_update.ps1"), "scripts"),
    (str(ICON), "."),
]
for path in (ROOT / "config").glob("*"):
    if path.is_file() and (".example" in path.name or path.name == "logging.yaml"):
        datas.append((str(path), "config"))

SKIP_SUFFIXES = {".ts", ".tsx", ".css", ".map", ".pyc"}
for path in (ROOT / "extensions").rglob("*"):
    if path.is_file() and "__pycache__" not in path.parts and path.suffix.lower() not in SKIP_SUFFIXES:
        datas.append((str(path), str(Path("extensions") / path.relative_to(ROOT / "extensions").parent)))

# 第三方包自带的数据文件（证书、模板、语言包）。
for package in ("certifi", "dateparser", "trafilatura", "justext", "pdfplumber", "pdfminer", "docx", "pptx", "webview"):
    try:
        datas += collect_data_files(package)
    except Exception:
        pass

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "scipy", "IPython", "notebook", "pytest", "playwright", "harness"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lzcore",
    console=False,
    disable_windowed_traceback=False,
    upx=False,
    icon=str(ICON),
    version=VERSION_FILE,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="lzcore")
