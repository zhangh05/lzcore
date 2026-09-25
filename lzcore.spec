# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller specification for LZCore (联智中枢) Desktop Application.

Build command on Windows:
    pyinstaller lzcore.spec --clean -y
"""

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

ROOT = Path('.').resolve()

# 收集所有项目代码子模块
hidden_imports = [
    'werkzeug.serving',
    'engineio.async_drivers.threading',
    'webview',
    'webview.platforms.winforms',
    'webview.platforms.edgechromium',
    'flask',
    'flask_sock',
    'yaml',
    'lxml',
    'bs4',
    'paramiko',
    'cryptography',
    'requests',
    'PIL',
]

for pkg in ['agent', 'backend', 'core', 'extensions', 'storage', 'workflows']:
    hidden_imports.extend(collect_submodules(pkg))

# 收集内置数据与前端编译资产
datas = [
    (str(ROOT / 'frontend' / 'dist'), 'frontend/dist'),
    (str(ROOT / 'extensions'), 'extensions'),
]

if (ROOT / 'lzcore.ico').is_file():
    datas.append((str(ROOT / 'lzcore.ico'), '.'))

a = Analysis(
    ['desktop.py'],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'scipy', 'numpy', 'IPython', 'notebook'],
    noarchive=False,
)

pyz = PYZ(a.pure)

# 单目录模式便于快速分发与便携运行（也可以通过 --onefile 做成单文件）
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='lzcore',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # 桌面应用：无控制台黑框！直接展示原生窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / 'lzcore.ico') if (ROOT / 'lzcore.ico').is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='lzcore',
)
