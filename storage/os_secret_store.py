"""OS credential store for API keys and device secrets.

macOS uses the login keychain. Windows uses DPAPI. Tests can select an
in-memory backend with LZCORE_OS_SECRET_STORE=memory. The encrypted file
store remains the fallback when no system store is available.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from ctypes import wintypes

SERVICE = "lzcore.secret"
_MEMORY: dict[str, str] = {}


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
    return str(secret_id or "").replace("/", "|")[:240]


def _keychain_set(secret_id: str, value: str) -> bool:
    account = _account(secret_id)
    _keychain_delete(secret_id)
    result = subprocess.run(
        ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value],
        capture_output=True,
        text=True,
        timeout=8,
    )
    return result.returncode == 0


def _keychain_get(secret_id: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", SERVICE, "-a", _account(secret_id), "-w"],
        capture_output=True,
        text=True,
        timeout=8,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _keychain_delete(secret_id: str) -> bool:
    result = subprocess.run(
        ["security", "delete-generic-password", "-s", SERVICE, "-a", _account(secret_id)],
        capture_output=True,
        text=True,
        timeout=8,
    )
    return result.returncode == 0


def _dpapi_path(secret_id: str):
    from storage.records import runtime_record_file
    return runtime_record_file("secrets", "dpapi", _account(secret_id) + ".bin", create_parent=True)


def _dpapi_set(secret_id: str, value: str) -> bool:
    blob = _dpapi_protect(value.encode("utf-8"))
    if blob is None:
        return False
    path = _dpapi_path(secret_id)
    path.write_bytes(blob)
    return True


def _dpapi_get(secret_id: str) -> str:
    path = _dpapi_path(secret_id)
    if not path.is_file():
        return ""
    raw = _dpapi_unprotect(path.read_bytes())
    return raw.decode("utf-8") if raw else ""


def _dpapi_delete(secret_id: str) -> bool:
    path = _dpapi_path(secret_id)
    if not path.is_file():
        return False
    path.unlink()
    return True


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob_from_bytes(data: bytes) -> tuple[_DATA_BLOB, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    blob = _DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def _dpapi_protect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    source, _held = _blob_from_bytes(data)
    output = _DATA_BLOB()
    if not crypt32.CryptProtectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)):
        return None
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def _dpapi_unprotect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    source, _held = _blob_from_bytes(data)
    output = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)):
        return None
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)
