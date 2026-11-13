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
import tempfile
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
    try:
        account = _account(secret_id)
        if not re.fullmatch(r"[A-Za-z0-9._-]+", account):
            raise ValueError("Invalid keychain account")
        # Keep the security tool's existing Keychain ACL identity. Hex input
        # avoids interactive-command injection and keeps secrets out of argv.
        result = subprocess.run(
            ["security", "-i"],
            input=f"add-generic-password -U -s {SERVICE} -a {account} -X {value.encode('utf-8').hex()}\n",
            capture_output=True, text=True, timeout=8,
        )
        if result.returncode != 0:
            logger.warning("Keychain set failed (returncode=%d)", result.returncode)
            return False
        # Interactive mode can exit successfully even when its command failed.
        # Verify this account directly; a legacy fallback must not mask failure.
        verified = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=8,
        )
        if verified.returncode != 0:
            logger.warning("Keychain verification failed (returncode=%d)", verified.returncode)
            return False
        if verified.stdout.strip() != value:
            logger.warning("Keychain verification mismatch (returncode=%d)", verified.returncode)
            return False
        return True
    except Exception as exc:
        logger.warning("Keychain set error (%s)", type(exc).__name__)
        return False


def _keychain_get(secret_id: str) -> str:
    try:
        legacy = str(secret_id or "").replace("/", "|")[:240]
        for account in dict.fromkeys((_account(secret_id), legacy)):
            result = subprocess.run(
                ["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
                capture_output=True, text=True, timeout=8,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            if result.returncode != 44:  # Item not found is expected.
                logger.warning("Keychain get failed (returncode=%d)", result.returncode)
        return ""
    except Exception as exc:
        logger.warning("Keychain get error (%s)", type(exc).__name__)
        return ""


def _keychain_delete(secret_id: str) -> bool:
    success = False
    try:
        legacy = str(secret_id or "").replace("/", "|")[:240]
        for account in dict.fromkeys((_account(secret_id), legacy)):
            result = subprocess.run(
                ["security", "delete-generic-password", "-s", SERVICE, "-a", account],
                capture_output=True, text=True, timeout=8,
            )
            success = success or result.returncode == 0
            if result.returncode not in {0, 44}:
                logger.warning("Keychain delete failed (returncode=%d)", result.returncode)
    except Exception as exc:
        logger.warning("Keychain delete error (%s)", type(exc).__name__)
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
        # mkstemp creates a private, separate file. Keep the old blob intact
        # through write/flush/fsync failures and Windows sharing conflicts.
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(blob)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        return True
    except Exception as exc:
        logger.warning("DPAPI set error (%s)", type(exc).__name__)
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
        logger.warning("DPAPI get error (%s)", type(exc).__name__)
        return ""


def _dpapi_delete(secret_id: str) -> bool:
    try:
        path = _dpapi_path(secret_id)
        if not path.is_file():
            return False
        path.unlink(missing_ok=True)
        return True
    except Exception as exc:
        logger.warning("DPAPI delete error (%s)", type(exc).__name__)
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
        logger.warning("DPAPI protect error (%s)", type(exc).__name__)
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
        logger.warning("DPAPI unprotect error (%s)", type(exc).__name__)
        return None
