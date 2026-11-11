#!/usr/bin/env python3
"""联智中枢 Windows 发行构建：本机与 CI 共用的唯一入口。

    python packaging/windows/build.py build --webview2 <已校验的 Fixed WebView2 目录>
    python packaging/windows/build.py package
    python packaging/windows/build.py all --webview2 <目录>

build   预检 → 清理 → 全新构建前端 → PyInstaller → 装配（WebView2、build-info、便携标记）→ 签名 → 校验产物
package 便携 ZIP → 每用户安装器（Inno Setup）→ windows-update.json 与 SHA256SUMS.txt

原则：
- 每次都从干净目录构建；不复用旧的 frontend/dist、build/、dist/。
- 版本只来自 agent/__init__.py；版本资源生成到 build/windows/，不改仓库文件。
- 打包工具版本必须与 requirements-desktop.lock 一致，否则拒绝构建。
- 产物先校验（必需文件、禁止文件、前端入口）再打包；任何一步失败立即退出。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BUILD = ROOT / "build" / "windows"
DIST = ROOT / "dist"
APP = DIST / "lzcore"
RELEASE = ROOT / "release"
FRONTEND = ROOT / "frontend"

# 产物里必须存在的文件（相对 APP）。
REQUIRED = (
    "lzcore.exe",
    "build-info.json",
    "portable.json",
    "_internal/frontend/dist/index.html",
    "_internal/prompts",
    "_internal/extensions/network_operations/extension.json",
    "_internal/scripts/windows_update.ps1",
    "_internal/webview2/msedgewebview2.exe",
)
# 产物里绝不能出现的路径片段 / 文件名（密钥、开发依赖、测试与源码前端）。
FORBIDDEN_PARTS = {"node_modules", ".git", "harness", "frontend-legacy", "test-results", "playwright-report"}
FORBIDDEN_NAMES = {"llm.yaml", "credentials.yaml", "secrets.yaml", ".env", ".env.local", ".backend.pid", ".frontend.pid"}
FORBIDDEN_SUFFIXES = {".pfx", ".p12"}
# 前端与扩展目录只发布构建产物，不带源码与 sourcemap。
SOURCE_ONLY_SUFFIXES = {".ts", ".tsx", ".map"}


def log(message: str) -> None:
    print(f"[build] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[build] 失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def run(cmd: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    log("$ " + " ".join(str(c) for c in cmd))
    result = subprocess.run([str(c) for c in cmd], cwd=str(cwd), env=env)
    if result.returncode != 0:
        fail(f"命令退出码 {result.returncode}：{cmd[0]}")


def app_version() -> str:
    text = (ROOT / "agent" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"(\d+\.\d+\.\d+)"', text, re.M)
    if not match:
        fail("agent/__init__.py 里没有 x.y.z 形式的 __version__")
    return match.group(1)


def source_commit() -> str:
    commit = os.environ.get("GITHUB_SHA")
    if commit:
        return commit
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()


def tree_is_dirty() -> bool:
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, capture_output=True, text=True)
    return bool(status.stdout.strip())


def locked_versions() -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in (ROOT / "requirements-desktop.lock").read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9_.\-]+)==([^\s;\\]+)", line.strip())
        if match:
            pins[match.group(1).lower().replace("_", "-")] = match.group(2)
    return pins


def preflight(*, need_node: bool) -> None:
    if sys.platform != "win32":
        fail("Windows 发行包只能在 Windows 上构建（PyInstaller 不交叉编译）")
    if sys.version_info[:2] != (3, 12) or sys.maxsize <= 2**32:
        fail(f"需要 64 位 CPython 3.12，当前是 {sys.version.split()[0]}")
    from importlib.metadata import PackageNotFoundError, version
    pins = locked_versions()
    for package in ("pyinstaller", "pywebview", "pythonnet", "flask", "werkzeug"):
        expected = pins.get(package)
        if not expected:
            fail(f"requirements-desktop.lock 缺少 {package}")
        try:
            installed = version(package)
        except PackageNotFoundError:
            fail(f"未安装 {package}；先执行 python -m pip install -r requirements-desktop.lock")
        if installed != expected:
            fail(f"{package} 版本 {installed} 与锁定版本 {expected} 不一致；先执行 python -m pip install -r requirements-desktop.lock")
    if need_node:
        node = shutil.which("node")
        if not node:
            fail("未找到 Node.js 24")
        major = subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True).strip()
        if major != "24":
            fail(f"需要 Node.js 24，当前是 {major}")
        if not shutil.which("npm"):
            fail("未找到 npm")


def clean() -> None:
    for path in (BUILD, APP, RELEASE, FRONTEND / "dist"):
        if path.exists():
            log(f"清理 {path.relative_to(ROOT)}")
            shutil.rmtree(path)
    BUILD.mkdir(parents=True)
    RELEASE.mkdir(parents=True)


def build_frontend() -> None:
    npm = shutil.which("npm")
    run([npm, "ci", "--no-audit", "--no-fund"], cwd=FRONTEND)
    run([npm, "run", "build"], cwd=FRONTEND)
    index = FRONTEND / "dist" / "index.html"
    if not index.is_file():
        fail("前端构建没有生成 frontend/dist/index.html")
    html = index.read_text(encoding="utf-8")
    if "/src/main" in html or "localhost:" in html:
        fail("frontend/dist/index.html 不是生产构建（引用了源码或开发服务器）")


def write_version_resource(version: str) -> Path:
    numbers = tuple(int(x) for x in version.split(".")) + (0,)
    path = BUILD / "version_info.txt"
    path.write_text(f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('080404b0', [
      StringStruct('CompanyName', 'LZCore'),
      StringStruct('FileDescription', '联智中枢'),
      StringStruct('FileVersion', '{version}.0'),
      StringStruct('InternalName', 'lzcore'),
      StringStruct('LegalCopyright', 'Copyright (C) 2026 LZCore'),
      StringStruct('OriginalFilename', 'lzcore.exe'),
      StringStruct('ProductName', '联智中枢'),
      StringStruct('ProductVersion', '{version}.0')])]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])
  ]
)
""", encoding="utf-8")
    return path


def build_exe(version_file: Path) -> None:
    env = {**os.environ, "LZCORE_ROOT": str(ROOT), "LZCORE_VERSION_FILE": str(version_file), "PYTHONUTF8": "1"}
    run([sys.executable, "-m", "PyInstaller", str(HERE / "lzcore.spec"), "--noconfirm", "--clean",
         "--distpath", str(DIST), "--workpath", str(BUILD / "pyinstaller")], env=env)
    if not (APP / "lzcore.exe").is_file():
        fail("PyInstaller 没有生成 dist/lzcore/lzcore.exe")


def assemble(webview2: Path, version: str) -> None:
    runtime = json.loads((ROOT / "packaging" / "webview2.json").read_text(encoding="utf-8"))
    if not (webview2 / "msedgewebview2.exe").is_file():
        fail(f"{webview2} 不是 Fixed WebView2 运行时目录（缺少 msedgewebview2.exe）")
    shutil.copytree(webview2, APP / "_internal" / "webview2")
    dirty = tree_is_dirty()
    if dirty and os.environ.get("CI"):
        fail("CI 构建时工作区有未提交的改动")
    info = {
        "version": version,
        "commit": source_commit(),
        "dirty": dirty,
        "data_schema": data_schema(),
        "signed": bool(os.environ.get("LZCORE_SIGNING_PFX")),
        "webview2_version": runtime["version"],
    }
    (APP / "build-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # 便携标记只用于便携 ZIP；安装器按显式文件清单打包，不会带上它。
    (APP / "portable.json").write_text(json.dumps({"mode": "portable", "data_schema": info["data_schema"]}) + "\n", encoding="utf-8")


def data_schema() -> int:
    sys.path.insert(0, str(ROOT))
    from desktop_app.environment import DATA_SCHEMA
    return int(DATA_SCHEMA)


def sign(path: Path) -> None:
    if not os.environ.get("LZCORE_SIGNING_PFX"):
        log(f"未配置签名证书，{path.name} 保持未签名")
        return
    run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / "sign_windows.ps1"), "-File", str(path)])


def verify_bundle() -> dict[str, object]:
    missing = [rel for rel in REQUIRED if not (APP / rel).exists()]
    if missing:
        fail("产物缺少：" + "、".join(missing))
    problems: list[str] = []
    total = 0
    count = 0
    for path in APP.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(APP)
        count += 1
        total += path.stat().st_size
        if rel.parts[:2] == ("_internal", "webview2"):
            continue
        lowered = {part.lower() for part in rel.parts}
        if lowered & FORBIDDEN_PARTS or path.name.lower() in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            problems.append(str(rel))
        elif rel.parts[:2] == ("_internal", "config") and not (path.name == "logging.yaml" or ".example" in path.name):
            problems.append(str(rel))
        elif rel.parts[:2] in (("_internal", "frontend"), ("_internal", "extensions")) and path.suffix.lower() in SOURCE_ONLY_SUFFIXES:
            problems.append(str(rel))
    if problems:
        fail("产物包含不应发布的文件：" + "、".join(problems[:20]))
    index = (APP / "_internal" / "frontend" / "dist" / "index.html").read_text(encoding="utf-8")
    assets = re.findall(r'(?:src|href)="/(assets/[^"]+)"', index)
    absent = [a for a in assets if not (APP / "_internal" / "frontend" / "dist" / a).is_file()]
    if not assets or absent:
        fail("前端入口引用的资源缺失：" + ("、".join(absent) or "index.html 没有引用任何 assets/"))
    summary = {"files": count, "bytes": total}
    log(f"产物校验通过：{count} 个文件，{total / 1024 / 1024:.1f} MiB")
    return summary


def make_portable_zip(version: str) -> Path:
    target = RELEASE / f"lzcore-v{version}-windows-portable.zip"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(APP.rglob("*")):
            if path.is_file():
                archive.write(path, Path("lzcore") / path.relative_to(APP))
    with zipfile.ZipFile(target) as archive:
        bad = archive.testzip()
        if bad:
            fail(f"便携包损坏：{bad}")
    log(f"便携包 {target.name}（{target.stat().st_size / 1024 / 1024:.1f} MiB）")
    return target


def find_iscc() -> Path:
    candidates = [os.environ.get("LZCORE_ISCC", "")]
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            candidates += [str(Path(base) / "Inno Setup 6" / "ISCC.exe"), str(Path(base) / "Programs" / "Inno Setup 6" / "ISCC.exe")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    fail("未找到 Inno Setup 6 编译器 ISCC.exe（可用 LZCORE_ISCC 指定）")
    raise AssertionError


def make_installer(version: str) -> Path:
    args = [str(find_iscc()), f"/DAppVersion={version}", f"/DRoot={ROOT}"]
    if os.environ.get("LZCORE_SIGNING_PFX"):
        sign_cmd = f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{ROOT / "scripts" / "sign_windows.ps1"}" -File $f'
        args.append(f"/DSignCommand={sign_cmd}")
    args.append(str(HERE / "installer.iss"))
    run(args)
    target = RELEASE / f"lzcore-v{version}-windows-setup.exe"
    if not target.is_file():
        fail(f"Inno Setup 没有生成 {target.name}")
    return target


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(version: str, portable: Path, installer: Path) -> None:
    info = json.loads((APP / "build-info.json").read_text(encoding="utf-8"))
    assets = {
        mode: {"name": path.name, "size": path.stat().st_size, "sha256": sha256(path), "signed": info["signed"]}
        for mode, path in (("portable", portable), ("installed", installer))
    }
    manifest = {"version": version, "source_commit": info["commit"], "data_schema": info["data_schema"], "assets": assets}
    (RELEASE / "windows-update.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (RELEASE / "SHA256SUMS.txt").write_text("".join(f"{a['sha256']}  {a['name']}\n" for a in assets.values()), encoding="utf-8")
    log("已写出 windows-update.json 与 SHA256SUMS.txt")


def cmd_build(webview2: Path) -> None:
    version = app_version()
    log(f"联智中枢 v{version} · {source_commit()[:12]}")
    preflight(need_node=True)
    clean()
    build_frontend()
    build_exe(write_version_resource(version))
    assemble(webview2.resolve(), version)
    sign(APP / "lzcore.exe")
    summary = verify_bundle()
    (BUILD / "bundle.json").write_text(json.dumps(summary) + "\n", encoding="utf-8")


def cmd_package() -> None:
    version = app_version()
    preflight(need_node=False)
    if not (APP / "lzcore.exe").is_file():
        fail("先执行 build")
    verify_bundle()
    info = json.loads((APP / "build-info.json").read_text(encoding="utf-8"))
    if info.get("version") != version:
        fail(f"dist/lzcore 是 v{info.get('version')} 的产物，当前源码是 v{version}；重新执行 build")
    RELEASE.mkdir(exist_ok=True)
    for stale in RELEASE.glob("lzcore-*"):
        stale.unlink()
    portable = make_portable_zip(version)
    installer = make_installer(version)
    write_manifest(version, portable, installer)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="构建联智中枢 Windows 发行包")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "all"):
        p = sub.add_parser(name)
        p.add_argument("--webview2", type=Path, default=os.environ.get("LZCORE_WEBVIEW2_DIR"),
                       help="已校验的 Fixed WebView2 运行时目录（scripts/download_webview2.ps1 输出）")
    sub.add_parser("package")
    args = parser.parse_args()
    if args.command in ("build", "all"):
        if not args.webview2:
            fail("缺少 --webview2（或环境变量 LZCORE_WEBVIEW2_DIR）")
        cmd_build(args.webview2)
    if args.command in ("package", "all"):
        cmd_package()


if __name__ == "__main__":
    main()
