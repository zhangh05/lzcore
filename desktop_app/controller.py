"""Desktop-owned lifecycle and deliberately small, origin-checked native API."""
from __future__ import annotations

import base64
import functools
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

from desktop_app import backup
from desktop_app.environment import DATA_SCHEMA
from desktop_app.updates import DesktopUpdater
from desktop_app.window import DesktopState, NativeWindow, apply_theme, autostart_enabled, set_autostart, system_theme

log = logging.getLogger("lzcore.desktop")


def active_jobs():
    from jobs.store import list_jobs
    from storage.principal import known_storage_principals, storage_principal
    result = []
    for principal in sorted(set(["", *known_storage_principals()])):
        with storage_principal(principal):
            for job in list_jobs(limit=10000):
                if job.get("status") in {"running", "queued", "created"}:
                    result.append((principal, job))
    return result


def native_method(method):
    @functools.wraps(method)
    def call(self, *args, **kwargs):
        try:
            if self._controller.window.evaluate_js("window.location.origin") != self._controller.origin:
                return {"ok": False, "error": "native_origin_denied"}
            return method(self, *args, **kwargs)
        except (ValueError, RuntimeError, OSError, zipfile.BadZipFile) as exc:
            from storage.redaction import redact_text
            return {"ok": False, "error": redact_text(str(exc))[:400]}
        except Exception:
            log.exception("Desktop operation failed: %s", method.__name__)
            return {"ok": False, "error": "桌面操作失败，请查看脱敏诊断信息。"}
    return call


class DesktopController:
    def __init__(self, paths, version, gate, origin):
        self.paths, self.version, self.gate, self.origin = paths, version, gate, origin
        self.state = DesktopState(paths.runtime / "desktop.json")
        self.updater = DesktopUpdater(paths, version, self.state)
        self.window = None
        self.native = None
        self.tray = None
        self.allow_exit = False
        self.hidden = False
        self.dirty = False
        self.principal = ""
        self.shutdown = {"status": "idle"}
        self.lock = threading.RLock()
        self._observed_jobs = {}
        self._stop = threading.Event()
        self.pending_restore = ""
        self.restart = False
        self.prepared_update = None
        self._dialog_lock = threading.Lock()
        self._shutdown_attempt = 0

    def attach(self, window):
        self.window = window
        self.native = NativeWindow(window, self.state, self.paths.runtime / "instance.json", self.origin)
        window.events.shown += self.native.attach
        window.events.resized += self.native.schedule_save
        window.events.moved += self.native.schedule_save
        window.events.closing += self.on_closing

    def emit(self, action, **details):
        if not self.window:
            return
        payload = json.dumps({"action": action, **details}, ensure_ascii=True)
        try:
            self.window.evaluate_js(f"window.dispatchEvent(new CustomEvent('lzcore:desktop-action', {{detail: {payload}}}))")
        except Exception:
            log.info("Desktop UI event deferred: %s", action)

    def on_closing(self):
        if self.allow_exit:
            return True
        if self.state.snapshot().get("close_to_tray") and self.tray:
            threading.Thread(target=self.hide, daemon=True).start()
        else:
            threading.Thread(target=self.emit, args=("close",), daemon=True).start()
        return False

    def show(self):
        self.hidden = False
        self.window.show()
        if sys.platform != "win32" or not self.native.hwnd:
            self.window.restore()
        else:
            import ctypes
            if ctypes.windll.user32.IsIconic(ctypes.c_void_p(self.native.hwnd)):
                self.window.restore()
        if sys.platform == "win32" and self.native.hwnd:
            import ctypes
            from ctypes import wintypes
            ctypes.windll.user32.SetForegroundWindow(wintypes.HWND(self.native.hwnd))

    def hide(self):
        if not self.tray:
            raise ValueError("托盘尚未就绪，请保持窗口最小化")
        self.hidden = True
        self.window.hide()

    def start_tray(self):
        if sys.platform != "win32":
            return
        if self.tray:
            return
        from desktop_app.tray import NativeTray
        self.tray = NativeTray(self)
        threading.Thread(target=self._monitor, daemon=True, name="desktop-status").start()

    def _monitor(self):
        while not self._stop.wait(2):
            try:
                import ctypes
                if self.native.hwnd:
                    self.hidden = not bool(ctypes.windll.user32.IsWindowVisible(ctypes.c_void_p(self.native.hwnd)))
                current = {}
                from jobs.store import list_jobs
                from storage.principal import known_storage_principals, storage_principal
                for principal in sorted(set(["", *known_storage_principals()])):
                    with storage_principal(principal):
                        for job in list_jobs(limit=10000):
                            key = (principal, job["workspace_id"], job["job_id"])
                            status = job.get("status")
                            current[key] = status
                            if principal == self.principal and self._observed_jobs.get(key) == "running" and status in {"succeeded", "failed", "cancelled"}:
                                if self.hidden and self.state.snapshot().get("notifications", True):
                                    label = {"succeeded": "任务已完成", "failed": "任务未完成，请查看运行记录", "cancelled": "任务已取消"}[status]
                                    self.tray.notify(label, "联智中枢", {"workspace_id": job["workspace_id"], "session_id": (job.get("payload") or {}).get("session_id", "")})
                self._observed_jobs = current
                count = sum(x in {"running", "queued"} for x in current.values())
                self.tray.title = f"联智中枢 · {count} 个任务运行中" if count else "联智中枢 · 空闲"
                if self.state.snapshot().get("ui", {}).get("themePreference", "system") == "system":
                    theme = system_theme()
                    if theme != self.state.snapshot().get("ui", {}).get("theme"):
                        self.emit("system-theme", theme=theme)
                        apply_theme(self.native.hwnd, theme)
            except Exception:
                log.exception("Desktop status refresh failed")

    def open_directory(self, path: Path):
        if sys.platform == "win32":
            os.startfile(str(path))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])

    def dialog(self, kind, **kwargs):
        # Serialise native dialogs; APIs never accept arbitrary filesystem paths.
        with self._dialog_lock:
            return self.window.create_file_dialog(kind, **kwargs)

    def idle_pause(self):
        if self.dirty:
            raise ValueError("请先保存或放弃未保存的图纸改动")
        if not self.gate.pause(require_idle=True):
            raise ValueError("仍有任务或保存操作进行中，请完成后重试")
        try:
            if active_jobs():
                raise ValueError("仍有待处理或运行中的任务，请完成后重试")
        except Exception:
            self.gate.resume()
            raise

    def quit(self, *, force=False, discard=False):
        with self.lock:
            if self.dirty and not discard:
                raise ValueError("请先保存或确认放弃未保存的图纸改动")
            if self.shutdown["status"] == "stopping" and not force:
                return {"ok": True, **self.shutdown}
            self.gate.pause(require_idle=False)
            self.shutdown = {"status": "stopping"}
            self._shutdown_attempt += 1
            attempt = self._shutdown_attempt
        if force:
            self.allow_exit = True
            self.window.destroy()
            return {"ok": True, "status": "exiting"}
        threading.Thread(target=self._stop_jobs, args=(attempt,), daemon=True, name="desktop-shutdown").start()
        return {"ok": True, **self.shutdown}

    def _stop_jobs(self, attempt):
        try:
            from jobs.manager import cancel_job
            from backend.ws.agent_ws import request_active_turn_cancel
            from storage.principal import storage_principal
            for principal, job in active_jobs():
                with storage_principal(principal):
                    cancel_job(job["workspace_id"], job["job_id"])
                    request_active_turn_cancel(principal, job["workspace_id"], job["job_id"])
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if attempt != self._shutdown_attempt:
                    return
                if not self.gate.active and not [x for x in active_jobs() if x[1]["status"] == "running"]:
                    from agent.runtime.turn_closeout import close_restarted_turns
                    close_restarted_turns()
                    with self.lock:
                        if attempt != self._shutdown_attempt:
                            return
                        self.allow_exit = True
                        self.window.destroy()
                    return
                time.sleep(.2)
            if attempt != self._shutdown_attempt:
                return
            self.shutdown = {"status": "waiting", "message": "任务尚未完成收尾。可继续等待、返回应用，或确认中断并退出；未知写入不会自动重试。"}
        except Exception:
            log.exception("Desktop shutdown deferred")
            self.shutdown = {"status": "waiting", "message": "无法确认任务已安全结束，请返回应用核对或确认中断退出。"}

    def cleanup(self):
        self._stop.set()
        try:
            if self.native:
                self.native.save()
            if self.tray:
                self.tray.stop()
        except Exception:
            log.exception("Desktop window cleanup deferred")


class DesktopApi:
    def __init__(self, controller):
        self._controller = controller
        self._last_export = None

    @native_method
    def get_info(self):
        c = self._controller
        try:
            build = json.loads((c.paths.app / "build-info.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            build = {}
        return {"ok": True, "version": c.version, "commit": build.get("commit", "development"), "mode": c.paths.mode, "data_dir": str(c.paths.data), "schema": DATA_SCHEMA, "signed": bool(build.get("signed")), "settings": {**c.state.snapshot(), "autostart": autostart_enabled(c.paths)}, "active_jobs": len(active_jobs()), "dirty": c.dirty, "shutdown": dict(c.shutdown), "update": c.updater.snapshot(), "restore": c.pending_restore, "tray": bool(c.tray), "webview2": build.get("webview2_version", "system")}

    @native_method
    def report_state(self, state):
        if not isinstance(state, dict):
            raise ValueError("无效的窗口状态")
        c = self._controller
        c.dirty = bool(state.get("dirty"))
        c.principal = str(state.get("principal") or "")
        title = str(state.get("title") or "")[:160].replace("\n", " ")
        c.window.set_title("联智中枢" + (f" · {title}" if title else ""))
        return {"ok": True}

    @native_method
    def save_preferences(self, settings):
        if not isinstance(settings, dict):
            raise ValueError("无效的桌面设置")
        c = self._controller
        values = {}
        for name in ("close_to_tray", "notifications", "autostart"):
            if name in settings:
                values[name] = bool(settings[name])
        if "autostart" in values:
            set_autostart(c.paths, values["autostart"])
        if "ui" in settings:
            raw = settings["ui"]
            if not isinstance(raw, dict) or raw.get("theme") not in {"light", "dark"} or raw.get("themePreference") not in {"light", "dark", "system"}:
                raise ValueError("无效的主题设置")
            values["ui"] = {"theme": raw["theme"], "themePreference": raw["themePreference"], "sidebarOpen": bool(raw.get("sidebarOpen", True)), "taskProgressOpen": bool(raw.get("taskProgressOpen", True))}
            apply_theme(c.native.hwnd, raw["theme"])
        c.state.update(**values)
        return {"ok": True, "settings": c.state.snapshot()}

    @native_method
    def open_folder(self, kind="data"):
        c = self._controller
        path = {"data": c.paths.data, "logs": c.paths.data / "logs", "exports": self._last_export.parent if self._last_export else c.paths.data}.get(kind)
        if path is None:
            raise ValueError("不支持的目录")
        path.mkdir(parents=True, exist_ok=True)
        c.open_directory(path)
        return {"ok": True}

    @native_method
    def save_file(self, filename, data_base64, mime="image/png"):
        import webview
        safe_name = Path(str(filename).replace("\\", "/")).name
        if not safe_name or len(str(data_base64)) > 96 * 1024 * 1024:
            raise ValueError("导出文件无效或超过大小上限")
        raw = base64.b64decode(str(data_base64).split(",", 1)[-1], validate=True)
        result = self._controller.dialog(webview.SAVE_DIALOG, save_filename=safe_name)
        if not result:
            return {"ok": False, "error": "cancelled"}
        target = Path(result if isinstance(result, str) else result[0])
        target.write_bytes(raw)
        self._last_export = target
        return {"ok": True, "path": str(target)}

    @native_method
    def create_backup(self, password="", include_credentials=False):
        import webview
        c = self._controller
        c.idle_pause()
        try:
            result = c.dialog(webview.SAVE_DIALOG, save_filename="lzcore-backup.lzbackup" if password else "lzcore-backup.zip")
            if not result:
                return {"ok": False, "error": "cancelled"}
            return backup.create_backup(c.paths.data, Path(result if isinstance(result, str) else result[0]), password=password, include_credentials=bool(include_credentials))
        finally:
            c.gate.resume()

    @native_method
    def import_backup(self, password=""):
        import webview
        c = self._controller
        c.idle_pause()
        try:
            result = c.dialog(webview.OPEN_DIALOG, allow_multiple=False, file_types=("联智中枢备份 (*.zip;*.lzbackup)",))
            if not result:
                return {"ok": False, "error": "cancelled"}
            response = backup.stage_restore(c.paths.data, Path(result[0] if not isinstance(result, str) else result), password=password)
            c.pending_restore = response["restore_id"]
            return response
        finally:
            c.gate.resume()

    @native_method
    def migrate_data(self):
        import webview
        c = self._controller
        c.idle_pause()
        try:
            result = c.dialog(webview.FOLDER_DIALOG)
            if not result:
                return {"ok": False, "error": "cancelled"}
            response = backup.stage_migration(c.paths.data, Path(result[0] if not isinstance(result, str) else result))
            c.pending_restore = response["restore_id"]
            return response
        finally:
            c.gate.resume()

    @native_method
    def apply_restore(self):
        c = self._controller
        c.idle_pause()
        try:
            backup.queue_restore(c.paths.data, c.pending_restore)
            c.restart = True
            c.allow_exit = True
            c.window.destroy()
            return {"ok": True}
        except Exception:
            c.gate.resume()
            raise

    @native_method
    def export_diagnostics(self):
        import webview
        from storage.redaction import redact_text
        c = self._controller
        result = c.dialog(webview.SAVE_DIALOG, save_filename="lzcore-diagnostics.zip")
        if not result:
            return {"ok": False, "error": "cancelled"}
        path = Path(result if isinstance(result, str) else result[0])
        # Export app identity and redacted desktop log only, never workspace
        # content, provider configuration, environment variables or credentials.
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("desktop.json", json.dumps({"version": c.version, "mode": c.paths.mode, "schema": DATA_SCHEMA, "platform": sys.platform}, ensure_ascii=False))
            for source in (c.paths.data / "logs").glob("desktop.log*"):
                with source.open("rb") as handle:
                    handle.seek(max(0, source.stat().st_size - 1024 * 1024))
                    text = handle.read().decode("utf-8", errors="replace")
                archive.writestr(source.name, redact_text(text))
        self._last_export = path
        return {"ok": True}

    @native_method
    def check_update(self, rollback=False):
        return {"ok": True, "update": self._controller.updater.check(rollback=bool(rollback))}

    @native_method
    def download_update(self):
        return {"ok": True, "update": self._controller.updater.download()}

    @native_method
    def apply_update(self):
        c = self._controller
        c.idle_pause()
        try:
            c.prepared_update = c.updater.prepare_apply()
            c.updater.launch_apply(c.prepared_update)
            c.allow_exit = True
            c.window.destroy()
            return {"ok": True}
        except Exception:
            c.gate.resume()
            raise

    @native_method
    def request_exit(self, action="exit", discard=False):
        c = self._controller
        if action == "background":
            c.hide()
        elif action == "return":
            with c.lock:
                c._shutdown_attempt += 1
                c.shutdown = {"status": "idle"}
                c.gate.resume()
        elif action in {"exit", "force"}:
            return c.quit(force=action == "force", discard=bool(discard))
        else:
            raise ValueError("不支持的窗口操作")
        return {"ok": True}
