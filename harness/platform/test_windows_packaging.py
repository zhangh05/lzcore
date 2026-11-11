"""Windows 发行构建（packaging/windows）的合同：任何平台都能跑，不调用 PyInstaller / Inno Setup。"""
from __future__ import annotations

import importlib.util
import json
import re
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGING = ROOT / "packaging" / "windows"


def load_build(monkeypatch, tmp_path: Path):
    spec = importlib.util.spec_from_file_location("lzcore_windows_build", PACKAGING / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = tmp_path / "dist" / "lzcore"
    monkeypatch.setattr(module, "APP", app)
    monkeypatch.setattr(module, "BUILD", tmp_path / "build")
    monkeypatch.setattr(module, "RELEASE", tmp_path / "release")
    return module, app


def make_bundle(app: Path) -> None:
    for rel in (
        "lzcore.exe", "build-info.json", "portable.json",
        "_internal/prompts/system.md",
        "_internal/extensions/network_operations/extension.json",
        "_internal/scripts/windows_update.ps1",
        "_internal/webview2/msedgewebview2.exe",
        "_internal/config/llm.example.yaml",
        "_internal/frontend/dist/assets/index-abc.js",
    ):
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x", encoding="utf-8")
    (app / "_internal/frontend/dist/index.html").write_text(
        '<html><head><script type="module" src="/assets/index-abc.js"></script></head></html>', encoding="utf-8")


def test_version_comes_only_from_agent_package(monkeypatch, tmp_path):
    build, _ = load_build(monkeypatch, tmp_path)
    source = (ROOT / "agent" / "__init__.py").read_text(encoding="utf-8")
    assert build.app_version() == re.search(r'__version__ = "([^"]+)"', source).group(1)
    assert not (ROOT / "version_info.txt").exists(), "版本资源只生成到 build/windows/，仓库里不再保存"


def test_version_resource_is_generated_into_build_dir(monkeypatch, tmp_path):
    build, _ = load_build(monkeypatch, tmp_path)
    (tmp_path / "build").mkdir()
    path = build.write_version_resource("4.0.0")
    text = path.read_text(encoding="utf-8")
    assert path.parent == tmp_path / "build"
    assert "filevers=(4, 0, 0, 0)" in text and "'ProductVersion', '4.0.0.0'" in text


def test_build_tools_are_pinned_by_the_desktop_lock(monkeypatch, tmp_path):
    build, _ = load_build(monkeypatch, tmp_path)
    pins = build.locked_versions()
    for package in ("pyinstaller", "pywebview", "pythonnet", "flask", "werkzeug", "playwright"):
        assert re.fullmatch(r"\d+(\.\d+)+", pins.get(package, "")), package


def test_bundle_check_accepts_a_complete_clean_bundle(monkeypatch, tmp_path):
    build, app = load_build(monkeypatch, tmp_path)
    make_bundle(app)
    summary = build.verify_bundle()
    assert summary["files"] >= 9


@pytest.mark.parametrize("rel", [
    "_internal/config/llm.yaml",
    "_internal/config/providers/openai.json",
    "_internal/node_modules/vite/index.js",
    "_internal/frontend/src/main.tsx",
    "_internal/frontend/dist/assets/index-abc.js.map",
    "_internal/.env.local",
    "_internal/signing.pfx",
    "_internal/harness/test_x.py",
])
def test_bundle_check_rejects_secrets_dev_files_and_sources(monkeypatch, tmp_path, rel):
    build, app = load_build(monkeypatch, tmp_path)
    make_bundle(app)
    path = app / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("secret", encoding="utf-8")
    with pytest.raises(SystemExit):
        build.verify_bundle()


@pytest.mark.parametrize("missing", ["_internal/webview2/msedgewebview2.exe", "_internal/frontend/dist/assets/index-abc.js", "portable.json"])
def test_bundle_check_rejects_missing_runtime_parts(monkeypatch, tmp_path, missing):
    build, app = load_build(monkeypatch, tmp_path)
    make_bundle(app)
    (app / missing).unlink()
    with pytest.raises(SystemExit):
        build.verify_bundle()


def test_portable_zip_has_single_lzcore_root(monkeypatch, tmp_path):
    build, app = load_build(monkeypatch, tmp_path)
    make_bundle(app)
    (tmp_path / "release").mkdir()
    target = build.make_portable_zip("4.0.0")
    assert target.name == "lzcore-v4.0.0-windows-portable.zip"
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
    assert names and all(name.startswith("lzcore/") for name in names)
    assert "lzcore/portable.json" in names and "lzcore/lzcore.exe" in names


def test_manifest_lists_both_assets_with_checksums(monkeypatch, tmp_path):
    build, app = load_build(monkeypatch, tmp_path)
    make_bundle(app)
    (app / "build-info.json").write_text(json.dumps({"commit": "abc", "data_schema": 1, "signed": False}), encoding="utf-8")
    release = tmp_path / "release"
    release.mkdir()
    portable = release / "lzcore-v4.0.0-windows-portable.zip"
    installer = release / "lzcore-v4.0.0-windows-setup.exe"
    portable.write_bytes(b"zip")
    installer.write_bytes(b"exe")
    build.write_manifest("4.0.0", portable, installer)
    manifest = json.loads((release / "windows-update.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "4.0.0" and manifest["source_commit"] == "abc"
    assert set(manifest["assets"]) == {"portable", "installed"}
    sums = (release / "SHA256SUMS.txt").read_text(encoding="utf-8")
    assert portable.name in sums and installer.name in sums


def test_build_refuses_non_windows_hosts(monkeypatch, tmp_path):
    build, _ = load_build(monkeypatch, tmp_path)
    monkeypatch.setattr(build.sys, "platform", "darwin")
    with pytest.raises(SystemExit):
        build.preflight(need_node=False)


def test_spec_packages_only_examples_and_built_frontend():
    spec = (PACKAGING / "lzcore.spec").read_text(encoding="utf-8")
    assert '"frontend" / "dist"' in spec
    assert '".example" in path.name or path.name == "logging.yaml"' in spec
    assert "node_modules" not in spec
    assert "LZCORE_VERSION_FILE" in spec


def test_installer_replaces_runtime_on_upgrade_and_keeps_user_data():
    iss = (PACKAGING / "installer.iss").read_text(encoding="utf-8")
    install_delete = iss.split("[InstallDelete]", 1)[1].split("[Files]", 1)[0]
    assert '{app}\\_internal' in install_delete
    assert "localappdata" in iss.lower() and "portable.json" in iss
    assert "PrivilegesRequired=lowest" in iss


def test_release_workflow_uses_the_single_build_entry():
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    assert "packaging/windows/build.py build" in workflow
    assert "packaging/windows/build.py package" in workflow
    assert workflow.count("packaging/windows/smoke.py") == 2
    assert "requirements-desktop.lock" in workflow
    assert "does not match code version" in workflow
    for removed in ("build_windows_exe.py", "windows_release_manifest.py", "runtime/node", "frontend/node_modules", "Compress-Archive"):
        assert removed not in workflow, removed
