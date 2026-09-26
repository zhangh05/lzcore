"""OS credential store for API keys and device secrets.

macOS uses the login keychain. Windows uses DPAPI. Tests can select an
in-memory backend with LZCORE_OS_SECRET_STORE=memory. The encrypted file
store remains the fallback when no system store is available.
"""

from __future__ import annotations

import ctypes
import logging
import os
import re
import subprocess
import sys
from ctypes import wintypes

logger = logging.getLogger(__name__)

SERVICE = "lzcore.secret"
_MEMORY: dict[str, str] = {}
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def backend_name() -> str:
    forced = os.environ.get("LZCORE_OS_SECRET_STORE", "auto").strip().lower()
    if forced in {"off", "0", "false", "no"}:
        return ""
    if forced == "memory":
        return "memory"
    if forced == "keychain":
        return "keychain"
    if forced == "dpapi":
        return "dpapi"
    if sys.platform == "darwin":
        return "keychain"
    if sys.platform == "win32":
        return "dpapi"
    return ""


def available() -> bool:
    return bool(backend_name())


def set_os_secret(secret_id: str, value: str) -> bool:
    backend = backend_name()
    if backend == "memory":
        _MEMORY[_account(secret_id)] = value
        return True
    if backend == "keychain":
        return _keychain_set(secret_id, value)
    if backend == "dpapi":
        return _dpapi_set(secret_id, value)
    return False


def get_os_secret(secret_id: str) -> str:
    backend = backend_name()
    account = _account(secret_id)
    if backend == "memory":
        return _MEMORY.get(account, "")
    if backend == "keychain":
        return _keychain_get(secret_id)
    if backend == "dpapi":
        return _dpapi_get(secret_id)
    return ""


def delete_os_secret(secret_id: str) -> bool:
    backend = backend_name()
    account = _account(secret_id)
    if backend == "memory":
        return _MEMORY.pop(account, None) is not None
    if backend == "keychain":
        return _keychain_delete(secret_id)
    if backend == "dpapi":
        return _dpapi_delete(secret_id)
    return False


def _account(secret_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", str(secret_id or "").strip())
    if not cleaned or cleaned.upper() in _RESERVED_NAMES:
        cleaned = f"sec_{cleaned}"
    return cleaned[:240]


def _keychain_set(secret_id: str, value: str) -> bool:
    account = _account(secret_id)
    _keychain_delete(secret_id)
    try:
        result = subprocess.run(
            ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value],
            capture_output=True,
            text=True,
            timeout=8,
        )
        return result.returncode == 0
    except Exception as exc:
        logger.warning("Keychain set error for %s: %s", secret_id, exc)
        return False


def _keychain_get(secret_id: str) -> str:
    account = _account(secret_id)
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        # Fallback to check legacy account format if exists
        legacy = str(secret_id or "").replace("/", "|")[:240]
        if legacy != account:
            result_legacy = subprocess.run(
                ["security", "find-generic-password", "-s", SERVICE, "-a", legacy, "-w"],
                capture_output=True,
                text=True,
                timeout=8,
            )
            if result_legacy.returncode == 0:
                return result_legacy.stdout.strip()
        return ""
    except Exception as exc:
        logger.warning("Keychain get error for %s: %s", secret_id, exc)
        return ""


def _keychain_delete(secret_id: str) -> bool:
    account = _account(secret_id)
    success = False
    try:
        result = subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE, "-a", account],
            capture_output=True,
            text=True,
            timeout=8,
        )
        success = (result.returncode == 0)
        legacy = str(secret_id or "").replace("/", "|")[:240]
        if legacy != account:
            subprocess.run(
                ["security", "delete-generic-password", "-s", SERVICE, "-a", legacy],
                capture_output=True,
                text=True,
                timeout=8,
            )
    except Exception as exc:
        logger.warning("Keychain delete error for %s: %s", secret_id, exc)
    return success


def _dpapi_path(secret_id: str):
    from storage.records import runtime_record_file
    return runtime_record_file("secrets", "dpapi", _account(secret_id) + ".bin", create_parent=True)


def _dpapi_set(secret_id: str, value: str) -> bool:
    try:
        blob = _dpapi_protect(value.encode("utf-8"))
        if blob is None:
            return False
        path = _dpapi_path(secret_id)
        path.write_bytes(blob)
        return True
    except Exception as exc:
        logger.warning("DPAPI set error for %s: %s", secret_id, exc)
        return False


def _dpapi_get(secret_id: str) -> str:
    try:
        path = _dpapi_path(secret_id)
        if not path.is_file():
            # Legacy check if path existed without illegal characters
            legacy = str(secret_id or "").replace("/", "|")[:240]
            if legacy != _account(secret_id) and "|" not in legacy:
                from storage.records import runtime_record_file
                legacy_path = runtime_record_file("secrets", "dpapi", legacy + ".bin", create_parent=False)
                if legacy_path.is_file():
                    path = legacy_path
                else:
                    return ""
            else:
                return ""
        raw = _dpapi_unprotect(path.read_bytes())
        return raw.decode("utf-8") if raw else ""
    except Exception as exc:
        logger.warning("DPAPI get error for %s: %s", secret_id, exc)
        return ""


def _dpapi_delete(secret_id: str) -> bool:
    try:
        path = _dpapi_path(secret_id)
        if not path.is_file():
            return False
        path.unlink(missing_ok=True)
        return True
    except Exception as exc:
        logger.warning("DPAPI delete error for %s: %s", secret_id, exc)
        return False


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob_from_bytes(data: bytes) -> tuple[_DATA_BLOB, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    blob = _DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def _get_crypt32():
    crypt32 = ctypes.windll.crypt32
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),
        wintypes.LPCWSTR,
        ctypes.POINTER(_DATA_BLOB),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_DATA_BLOB),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(_DATA_BLOB),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    return crypt32


def _get_kernel32():
    kernel32 = ctypes.windll.kernel32
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return kernel32


def _dpapi_protect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    try:
        crypt32 = _get_crypt32()
        kernel32 = _get_kernel32()
        source, _held = _blob_from_bytes(data)
        output = _DATA_BLOB()
        if not crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)):
            return None
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            if output.pbData:
                kernel32.LocalFree(output.pbData)
    except Exception as exc:
        logger.warning("DPAPI protect error: %s", exc)
        return None


def _dpapi_unprotect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    try:
        crypt32 = _get_crypt32()
        kernel32 = _get_kernel32()
        source, _held = _blob_from_bytes(data)
        output = _DATA_BLOB()
        if not crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)):
            return None
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            if output.pbData:
                kernel32.LocalFree(output.pbData)
    except Exception as exc:
        logger.warning("DPAPI unprotect error: %s", exc)
        return None
