"""Encrypted local secret adapter for single-node and bootstrap deployments."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from storage.atomic_io import atomic_write_json
from storage.locking import FileLock
from storage.records import runtime_record_file

_LOG = logging.getLogger("lzcore.secret_store")


def extension_secret_owner() -> str:
    from storage.principal import current_storage_principal, principal_storage_key
    principal = current_storage_principal()
    if principal:
        return principal_storage_key(principal)
    # Personal mode retains its local store. A missing server principal must
    # never silently fall through to that shared namespace.
    from backend.core.auth import _is_auth_enabled, _is_identity_enabled, _is_login_enabled
    if _is_auth_enabled() or _is_identity_enabled() or _is_login_enabled():
        raise PermissionError("extension secret principal required")
    return "personal"


def extension_secret_id(workspace_id: str, extension_id: str, name: str) -> str:
    from storage.ids import validate_workspace_id
    workspace_id = validate_workspace_id(workspace_id)
    if not isinstance(extension_id, str) or not extension_id or not isinstance(name, str) or not name:
        raise ValueError("extension_id and secret name required")
    parts = [extension_secret_owner(), workspace_id, extension_id, name]
    encoded = base64.urlsafe_b64encode(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).decode().rstrip("=")
    return "extension-v2/" + encoded


def check_extension_secret_reference(reference: str, *, workspace_id: str | None = None, extension_id: str | None = None) -> None:
    secret_id = str(reference).removeprefix("secret://")
    if not secret_id.startswith("extension-v2/"):
        # Old references have no owner proof. Only the unchanged anonymous
        # personal-mode namespace may read them; server users must re-enter.
        if secret_id.startswith("extension/") and extension_secret_owner() == "personal":
            parts = secret_id.split("/")
            if len(parts) == 4 and (workspace_id is None or parts[2] == workspace_id) and (extension_id is None or parts[1] == extension_id):
                return
        raise PermissionError("unowned extension secret reference")
    try:
        encoded = secret_id.split("/", 1)[1]
        parts = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        if not isinstance(parts, list) or len(parts) != 4 or not all(isinstance(item, str) and item for item in parts):
            raise ValueError("invalid identity")
        expected = extension_secret_id(parts[1], parts[2], parts[3])
        if secret_id != expected or parts[0] != extension_secret_owner():
            raise ValueError("foreign identity")
        if workspace_id is not None and parts[1] != workspace_id or extension_id is not None and parts[2] != extension_id:
            raise ValueError("foreign namespace")
    except (ValueError, TypeError, UnicodeError) as exc:
        raise PermissionError("invalid extension secret namespace") from exc



def _has_master_key() -> bool:
    master = os.environ.get("LZCORE_MASTER_KEY", "").strip()
    if not master:
        key_file = os.environ.get("LZCORE_MASTER_KEY_FILE", "").strip()
        if key_file:
            try:
                master = Path(key_file).read_text(encoding="utf-8").strip()
            except OSError:
                master = ""
    return len(master) >= 16


def _fernet() -> Fernet:
    master = os.environ.get("LZCORE_MASTER_KEY", "").strip()
    if not master:
        key_file = os.environ.get("LZCORE_MASTER_KEY_FILE", "").strip()
        if key_file:
            try:
                master = Path(key_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise RuntimeError("LZCORE_MASTER_KEY_FILE is not readable") from exc
    if len(master) < 16:
        raise RuntimeError("LZCORE_MASTER_KEY must contain at least 16 characters")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(master.encode()).digest()))


def _path(*, create_parent: bool = True):
    return runtime_record_file("secrets", "encrypted.json", create_parent=create_parent)


def _read_encrypted(path: Path) -> dict:
    """Only an absent file is an empty store; never repair by overwriting."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"Encrypted secret store cannot be read ({type(exc).__name__}); original file preserved"
        ) from None
    if not isinstance(data, dict):
        raise RuntimeError("Encrypted secret store must contain a JSON object; original file preserved")
    return data


def secret_backend_available() -> bool:
    from storage.os_secret_store import available
    if available():
        return True
    return _has_master_key()


def set_secret(secret_id: str, value: str) -> str:
    if secret_id.startswith("extension-v2/"):
        check_extension_secret_reference(secret_id)
    from storage.os_secret_store import available, set_os_secret
    if available():
        try:
            stored = set_os_secret(secret_id, value)
        except Exception:
            stored = False
        if stored:
            try:
                _forget_file_copy(secret_id)
            except Exception as exc:
                _LOG.warning("Failed to clean up secret file copy (%s)", type(exc).__name__)
            return f"secret://{secret_id}"
    if _has_master_key():
        path = _path()
        with FileLock(path.with_name("encrypted.lock")):
            data = _read_encrypted(path)
            data[secret_id] = _fernet().encrypt(value.encode()).decode()
            atomic_write_json(path, data)
        return f"secret://{secret_id}"
    raise RuntimeError("No secure secret backend available (OS store unavailable and LZCORE_MASTER_KEY not set)")


def get_secret(reference: str) -> str:
    secret_id = str(reference).removeprefix("secret://")
    if secret_id.startswith(("extension/", "extension-v2/")):
        check_extension_secret_reference(reference)
    from storage.os_secret_store import available, get_os_secret
    if available():
        stored = get_os_secret(secret_id)
        if stored:
            return stored
    path = _path()
    try:
        data = _read_encrypted(path)
        encrypted = data.get(secret_id, "")
        if not encrypted:
            return ""
        if not isinstance(encrypted, str):
            raise TypeError("Encrypted secret must be a string")
        return _fernet().decrypt(encrypted.encode()).decode()
    except InvalidToken:
        _LOG.warning("Secret decryption failed: invalid master key or corrupted token")
        return ""
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        _LOG.warning("Failed to read or decode secret (%s)", type(exc).__name__)
        return ""


def _forget_file_copy(secret_id: str) -> None:
    path = _path(create_parent=False)
    try:
        path.stat()
    except FileNotFoundError:
        return
    with FileLock(path.with_name("encrypted.lock")):
        data = _read_encrypted(path)
        if secret_id not in data:
            return
        data.pop(secret_id, None)
        atomic_write_json(path, data)


def delete_secret(reference: str) -> bool:
    secret_id = str(reference).removeprefix("secret://")
    if secret_id.startswith(("extension/", "extension-v2/")):
        check_extension_secret_reference(reference)
    from storage.os_secret_store import available, delete_os_secret
    path = _path()
    with FileLock(path.with_name("encrypted.lock")):
        data = _read_encrypted(path)
        removed = delete_os_secret(secret_id) if available() else False
        existed = secret_id in data
        if existed:
            data.pop(secret_id, None)
            atomic_write_json(path, data)
        return existed or removed
