"""Native Windows frame integration and portable, bounded window preferences."""
from __future__ import annotations

import ctypes
import json
import math
import os
import sys
import threading
from ctypes import wintypes
from pathlib import Path

from storage.atomic_io import atomic_write_json


class DesktopState:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            self.value = value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            self.value = {}

    def update(self, **values):
        with self.lock:
            self.value.update(values)
            atomic_write_json(self.path, self.value)

    def snapshot(self):
        with self.lock:
            return dict(self.value)


def fit_window(saved: dict, area: tuple[int, int, int, int], scale=1.0):
    """Fit logical dimensions into the current monitor's physical work area."""
    left, top, right, bottom = area
    available_w, available_h = right - left, bottom - top
    def number(key, fallback):
        try:
            value = float(saved.get(key, fallback))
            return value if math.isfinite(value) else fallback
        except (TypeError, ValueError):
            return fallback
    scale = max(1.0, float(scale))
    width = min(available_w, max(min(500 * scale, available_w), number("width", min(1280, available_w / scale * .88)) * scale))
    height = min(available_h, max(min(420 * scale, available_h), number("height", min(860, available_h / scale * .88)) * scale))
    x = left + number("left", (available_w - width) / scale / 2) * scale
    y = top + number("top", (available_h - height) / scale / 2) * scale
    x = min(max(left, x), right - width)
    y = min(max(top, y), bottom - height)
    return tuple(int(v) for v in (x, y, width, height))


class MONITORINFOEX(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]


def monitors():
    if sys.platform != "win32":
        return []
    result = []
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFOEX)]
    user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), callback_type, wintypes.LPARAM]

    def callback(handle, _dc, _rect, _data):
        info = MONITORINFOEX()
        info.cbSize = ctypes.sizeof(info)
        if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            dpi = ctypes.c_uint(96)
            other = ctypes.c_uint(96)
            try:
                ctypes.windll.shcore.GetDpiForMonitor(wintypes.HMONITOR(handle), 0, ctypes.byref(dpi), ctypes.byref(other))
            except (AttributeError, OSError):
                pass
            rect = info.rcWork
            result.append({"name": info.szDevice, "area": (rect.left, rect.top, rect.right, rect.bottom), "scale": dpi.value / 96, "primary": bool(info.dwFlags & 1)})
        return True

    user32.EnumDisplayMonitors(None, None, callback_type(callback), 0)
    return result


def apply_theme(hwnd: int, theme: str):
    if sys.platform != "win32" or not hwnd:
        return
    try:
        dark = ctypes.c_int(theme == "dark")
        dwm = ctypes.windll.dwmapi
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 20, ctypes.byref(dark), ctypes.sizeof(dark))
        # Native caption buttons, hit testing, shadow and snap remain Windows-owned.
        caption = ctypes.c_uint(0x00211C17 if dark.value else 0x00FAFAFA)
        text = ctypes.c_uint(0x00F0F0F0 if dark.value else 0x002B2723)
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 35, ctypes.byref(caption), 4)
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 36, ctypes.byref(text), 4)
    except (AttributeError, OSError):
        pass  # Earlier Windows releases retain their standard native frame.


def system_theme():
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
                return "light" if winreg.QueryValueEx(key, "AppsUseLightTheme")[0] else "dark"
        except OSError:
            pass
    return "light"


def wake_instance(record: Path):
    if sys.platform != "win32":
        return False
    try:
        info = json.loads(record.read_text(encoding="utf-8"))
        hwnd, pid = int(info["hwnd"]), int(info["pid"])
        user32 = ctypes.windll.user32
        actual = wintypes.DWORD()
        user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(actual))
        if actual.value != pid or not user32.IsWindow(wintypes.HWND(hwnd)):
            return False
        user32.ShowWindow(wintypes.HWND(hwnd), 9)
        user32.SetForegroundWindow(wintypes.HWND(hwnd))
        return True
    except (OSError, ValueError, KeyError):
        return False


def set_autostart(paths, enabled: bool):
    if paths.mode != "installed" or sys.platform != "win32":
        if enabled:
            raise ValueError("只有安装版支持登录 Windows 后启动")
        return
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        if enabled:
            winreg.SetValueEx(key, "LZCore", 0, winreg.REG_SZ, f'"{paths.app / "lzcore.exe"}" --background')
        else:
            try:
                winreg.DeleteValue(key, "LZCore")
            except FileNotFoundError:
                pass


def autostart_enabled(paths):
    if paths.mode != "installed" or sys.platform != "win32":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
            value = winreg.QueryValueEx(key, "LZCore")[0]
            return value == f'"{paths.app / "lzcore.exe"}" --background'
    except OSError:
        return False


class NativeWindow:
    def __init__(self, window, state: DesktopState, record: Path, trusted_origin: str):
        self.window, self.state, self.record = window, state, record
        self.origin = trusted_origin
        self.hwnd = 0
        self._handlers = []  # Keep delegates alive for pythonnet.
        self._save_timer = None

    def attach(self):
        if sys.platform != "win32":
            return
        from System import Action
        form = self.window.native
        form.Invoke(Action(self._attach_on_ui))

    def _attach_on_ui(self):
        if self.hwnd:
            return
        from System.Drawing import Size
        form = self.window.native
        self.hwnd = int(form.Handle.ToInt64())
        atomic_write_json(self.record, {"pid": os.getpid(), "hwnd": self.hwnd})
        saved = self.state.snapshot().get("window", {})
        screens = monitors()
        screen = next((x for x in screens if x["name"] == saved.get("monitor")), None) or next((x for x in screens if x["primary"]), None)
        if screen:
            scale = screen["scale"]
            form.MinimumSize = Size(int(min(500 * scale, screen["area"][2] - screen["area"][0])), int(min(420 * scale, screen["area"][3] - screen["area"][1])))
            form.SetBounds(*fit_window(saved, screen["area"], scale))
            if saved.get("maximized"):
                from System.Windows.Forms import FormWindowState
                form.WindowState = FormWindowState.Maximized
        def dpi_changed(_sender, _event):
            self.schedule_save()
        if hasattr(form, "DpiChanged"):
            form.DpiChanged += dpi_changed
            self._handlers.append(dpi_changed)
        self._install_navigation_guard(form)
        theme = self.state.snapshot().get("ui", {}).get("theme", system_theme())
        apply_theme(self.hwnd, theme)

    def _install_navigation_guard(self, form):
        """External content must never inherit the JavaScript native bridge."""
        from urllib.parse import urlparse
        import webbrowser

        def navigation(_sender, args):
            uri = str(args.Uri)
            parsed = urlparse(uri)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            if origin != self.origin:
                args.Cancel = True
                if parsed.scheme in {"http", "https"}:
                    webbrowser.open(uri)

        def attach_control(control):
            if hasattr(control, "NavigationStarting"):
                control.NavigationStarting += navigation
                self._handlers.append(navigation)
            if hasattr(control, "Controls"):
                for child in control.Controls:
                    attach_control(child)

        attach_control(form)

    def schedule_save(self, *_args):
        if self._save_timer:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(.25, self.save)
        self._save_timer.daemon = True
        self._save_timer.start()

    def save(self):
        if not self.hwnd or sys.platform != "win32":
            return
        class WINDOWPLACEMENT(ctypes.Structure):
            _fields_ = [("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT), ("ptMinPosition", wintypes.POINT), ("ptMaxPosition", wintypes.POINT), ("rcNormalPosition", wintypes.RECT)]
        placement = WINDOWPLACEMENT()
        placement.length = ctypes.sizeof(placement)
        if not ctypes.windll.user32.GetWindowPlacement(wintypes.HWND(self.hwnd), ctypes.byref(placement)):
            return
        rect = placement.rcNormalPosition
        screen = max(monitors(), key=lambda s: max(0, min(rect.right, s["area"][2]) - max(rect.left, s["area"][0])) * max(0, min(rect.bottom, s["area"][3]) - max(rect.top, s["area"][1])), default=None)
        if screen:
            scale = screen["scale"]
            self.state.update(window={"monitor": screen["name"], "left": (rect.left - screen["area"][0]) / scale, "top": (rect.top - screen["area"][1]) / scale, "width": (rect.right - rect.left) / scale, "height": (rect.bottom - rect.top) / scale, "maximized": placement.showCmd == 3 or bool(placement.flags & 2)})
