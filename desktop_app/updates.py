"""GitHub release updates: fixed origin, verified artifacts, explicit application."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse

from desktop_app.environment import DATA_SCHEMA, file_sha256
from storage.atomic_io import atomic_write_json

REPOSITORY = "zhangh05/lzcore"
MAX_PACKAGE_BYTES = 1024 * 1024 * 1024


def version_tuple(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", str(value))
    if not match:
        raise ValueError("无效的发行版本")
    return tuple(int(x) for x in match.groups())


def _safe_url(url: str, *, api=False):
    parsed = urlparse(url)
    host = "api.github.com" if api else "github.com"
    prefix = f"/repos/{REPOSITORY}/releases/" if api else f"/{REPOSITORY}/releases/download/"
    if parsed.scheme != "https" or parsed.netloc != host or not parsed.path.startswith(prefix) or parsed.query or parsed.fragment:
        raise ValueError("更新来源不受信任")
    return url


def _open(url, *, api=False):
    _safe_url(url, api=api)
    req = urllib.request.Request(url, headers={"User-Agent": "LZCore-desktop-updater", "Accept": "application/vnd.github+json" if api else "application/octet-stream"})
    response = urllib.request.urlopen(req, timeout=30)
    final = urlparse(response.url)
    if final.scheme != "https" or final.hostname not in {"api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}:
        response.close()
        raise ValueError("更新下载重定向不受信任")
    return response


def release_update(current_version: str, mode: str, *, rollback_version=""):
    if mode not in {"portable", "installed"}:
        return {"status": "unsupported", "message": "源码运行请通过 Git 更新"}
    suffix = "tags/v" + rollback_version if rollback_version else "latest"
    if rollback_version:
        version_tuple(rollback_version)
    with _open(f"https://api.github.com/repos/{REPOSITORY}/releases/{suffix}", api=True) as response:
        release = json.loads(response.read(1024 * 1024))
    version = str(release["tag_name"]).removeprefix("v")
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("更新不能使用草稿或预发布版本")
    if not rollback_version and version_tuple(version) <= version_tuple(current_version):
        return {"status": "current", "version": version}
    if rollback_version and version != rollback_version:
        raise ValueError("回退版本不匹配")
    assets = {x["name"]: x for x in release.get("assets", [])}
    manifest_asset = assets.get("windows-update.json")
    if not manifest_asset:
        raise ValueError("此版本没有受支持的桌面更新清单")
    with _open(manifest_asset["browser_download_url"]) as response:
        manifest = json.loads(response.read(1024 * 1024))
    if manifest.get("version") != version or manifest.get("data_schema") != DATA_SCHEMA:
        raise ValueError("此版本的数据格式不兼容，请使用迁移流程")
    package = manifest["assets"][mode]
    expected = f"lzcore-v{version}-windows-{'portable.zip' if mode == 'portable' else 'setup.exe'}"
    asset = assets.get(expected)
    if not asset or package.get("name") != expected or not re.fullmatch(r"[0-9a-f]{64}", str(package.get("sha256", ""))):
        raise ValueError("更新包清单不完整")
    if int(asset["size"]) != int(package["size"]) or not 0 < int(asset["size"]) <= MAX_PACKAGE_BYTES:
        raise ValueError("更新包大小不匹配")
    digest = asset.get("digest")
    if digest and digest != "sha256:" + package["sha256"]:
        raise ValueError("更新包的发布校验值不匹配")
    _safe_url(asset["browser_download_url"])
    return {"status": "available", "version": version, "notes": str(release.get("body", ""))[:20000], "url": asset["browser_download_url"], "name": expected, "size": package["size"], "sha256": package["sha256"], "signed": bool(package.get("signed")), "rollback": bool(rollback_version)}


class DesktopUpdater:
    def __init__(self, paths, version, state):
        self.paths, self.version, self.state = paths, version, state
        self.lock = threading.RLock()
        self.value = {"status": "idle"}
        self.package = None
        self.thread = None
        try:
            result = max(self.paths.runtime.glob('updates/*/result.json'),
                         key=lambda p: p.stat().st_mtime_ns, default=None)
            if result:
                with result.open(encoding='utf-8-sig') as handle:
                    outcome = json.loads(handle.read(4096))
                if isinstance(outcome, dict) and outcome.get('ok') is False:
                    # Keep the failure visible after the helper restarts the
                    # program. Never reflect an arbitrary local error string.
                    self.value = {'status': 'error', 'message': f'上次更新未完成，用户数据已保留。当前版本 v{version}，请重新检查更新。'}
        except (OSError, ValueError):
            pass

    def snapshot(self):
        with self.lock:
            return dict(self.value)

    def check(self, *, rollback=False):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return self.snapshot()
            previous = self.state.snapshot().get("previous_version", "") if rollback else ""
            if rollback and not previous:
                raise ValueError("没有可回退的兼容版本")
            self.value = {"status": "checking"}
            self.package = None
            self.thread = threading.Thread(target=self._check, args=(previous,), daemon=True)
            self.thread.start()
            return self.snapshot()

    def _check(self, previous):
        try:
            value = release_update(self.version, self.paths.mode, rollback_version=previous)
        except Exception:
            value = {"status": "error", "message": "无法核对更新，请检查网络或稍后重试；当前程序和数据未修改。"}
        with self.lock:
            self.value = value

    def download(self):
        with self.lock:
            if self.value.get("status") != "available":
                raise ValueError("请先检查更新")
            metadata = dict(self.value)
            self.value.update(status="downloading", progress=0)
            self.thread = threading.Thread(target=self._download, args=(metadata,), daemon=True)
            self.thread.start()
            return self.snapshot()

    def _download(self, metadata):
        directory = self.paths.runtime / "updates" / uuid.uuid4().hex
        target = directory / metadata["name"]
        try:
            directory.mkdir(parents=True)
            received = 0
            with _open(metadata["url"]) as response, target.open("xb") as handle:
                while chunk := response.read(1024 * 1024):
                    received += len(chunk)
                    if received > int(metadata["size"]):
                        raise ValueError("下载大小超过清单")
                    handle.write(chunk)
                    with self.lock:
                        self.value["progress"] = min(99, round(received * 100 / metadata["size"]))
                handle.flush()
                os.fsync(handle.fileno())
            if received != metadata["size"] or file_sha256(target) != metadata["sha256"]:
                raise ValueError("下载校验失败")
            if metadata["signed"] and self.paths.mode == "installed":
                verify_authenticode(target)
            with self.lock:
                self.package = target
                self.value = {**metadata, "status": "ready", "progress": 100}
        except Exception:
            with self.lock:
                self.value = {"status": "error", "message": "更新包下载或校验失败，请重新检查更新。"}
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass

    def prepare_apply(self):
        with self.lock:
            metadata, target = dict(self.value), self.package
        if metadata.get("status") != "ready" or not target or file_sha256(target) != metadata["sha256"]:
            raise ValueError("更新包尚未准备好或校验失败")
        script = self.paths.bundle / "scripts" / "windows_update.ps1"
        if not script.is_file() or sys.platform != "win32":
            raise ValueError("当前平台不支持桌面更新")
        copied_script = target.parent / "apply.ps1"
        shutil.copy2(script, copied_script)
        plan = target.parent / "apply.json"
        atomic_write_json(plan, {"parent_pid": os.getpid(), "app": str(self.paths.app), "data": str(self.paths.data), "mode": self.paths.mode, "package": str(target), "sha256": metadata["sha256"], "version": metadata["version"], "data_schema": DATA_SCHEMA, "signed": metadata["signed"], "previous_version": self.version})
        return copied_script, plan

    def launch_apply(self, prepared):
        script, plan = prepared
        subprocess.Popen([powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Plan", str(plan)], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), close_fds=True)


def powershell():
    return str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")


def verify_authenticode(path: Path):
    # -Command parses trailing arguments as code; keep the command fixed and
    # transfer the literal filename through a task-specific child environment.
    command = "if ((Get-AuthenticodeSignature -LiteralPath $env:LZCORE_VERIFY_SIGNATURE_PATH).Status -ne 'Valid') {exit 1}"
    result = subprocess.run([powershell(), "-NoProfile", "-NonInteractive", "-Command", command], env={**os.environ, "LZCORE_VERIFY_SIGNATURE_PATH": str(path)}, capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError("程序的 Windows 签名无效")
