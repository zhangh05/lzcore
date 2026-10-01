"""Verified local backups and journaled restore; no live database replacement."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from storage.atomic_io import atomic_write_json
from desktop_app.environment import DATA_SCHEMA, copy_verified

MAX_BACKUP_BYTES = 512 * 1024 * 1024
MAX_BACKUP_FILES = 100000
_CREDENTIAL_KEYS = {"api_key", "apikey", "password", "secret", "access_token", "private_key", "token", "client_secret", "api_token", "master_key"}


def _safe_member(name: str):
    path = PurePosixPath(name)
    if not name or "\\" in name or ":" in name or path.is_absolute() or ".." in path.parts or path.parts[0] not in {"workspaces", "config"}:
        raise ValueError("备份包含不安全的路径")
    if path.as_posix() != name:
        raise ValueError("备份路径不是规范路径")
    for part in path.parts:
        if not part or part.endswith((".", " ")) or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part):
            raise ValueError("备份包含不支持的 Windows 文件名")
    return path


def _strip_config_keys(value):
    if isinstance(value, dict):
        return {key: ("" if (str(key).lower().replace("-", "_") in _CREDENTIAL_KEYS or str(key).lower().endswith(("_api_key", "_password", "_secret"))) else _strip_config_keys(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [_strip_config_keys(item) for item in value]
    return value


def _files(data: Path):
    for root in ("workspaces", "config"):
        source = data / root
        if source.is_symlink():
            raise ValueError("数据目录不能是符号链接")
        if not source.is_dir():
            continue
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("备份不能跟随符号链接")
            if not path.is_file():
                continue
            rel = path.relative_to(data).as_posix()
            if "secrets" in path.relative_to(data).parts or path.suffix == ".lock" or path.name in {"credentials.yaml", "secrets.yaml", ".env"}:
                continue
            _safe_member(rel)
            yield rel, path


def _portable_secrets(data: Path):
    """Plain secret values exist only inside an explicitly encrypted backup."""
    from storage.os_secret_store import _dpapi_unprotect, _account
    from storage.secret_store import _fernet
    values = {}
    for folder in (data / "workspaces").rglob("secrets"):
        if folder.is_symlink():
            raise ValueError("凭据目录不能含符号链接")
        for path in (folder / "dpapi").glob("*.bin"):
            if path.is_symlink():
                raise ValueError("凭据目录不能含符号链接")
            raw = _dpapi_unprotect(path.read_bytes())
            if raw is None:
                raise ValueError("部分凭据无法解密；请在原 Windows 用户下导出")
            values[path.relative_to(data).as_posix()] = raw.decode("utf-8")
        encrypted = folder / "encrypted.json"
        if encrypted.is_file():
            for key, token in json.loads(encrypted.read_text(encoding="utf-8")).items():
                try:
                    raw = _fernet().decrypt(token.encode()).decode()
                except Exception as exc:
                    raise ValueError("部分凭据无法解密；请检查主密钥配置") from exc
                target = folder / "dpapi" / (_account(key) + ".bin")
                values.setdefault(target.relative_to(data).as_posix(), raw)

    return values


def _cipher(password: str, salt: bytes):
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode("utf-8"))
    return Fernet(base64.urlsafe_b64encode(key))


def create_backup(data: Path, target: Path, *, password="", include_credentials=False):
    if include_credentials and len(password) < 12:
        raise ValueError("带凭据的备份需要至少 12 个字符的加密口令")
    if password and len(password) < 12:
        raise ValueError("加密口令至少需要 12 个字符")
    target = target.resolve()
    if target == data.resolve() or data.resolve() in target.parents:
        raise ValueError("请将备份保存到数据目录之外")
    buffer = io.BytesIO()
    manifest = {"format": "lzcore-backup", "schema": DATA_SCHEMA, "created_at": time.time(), "includes_credentials": include_credentials, "files": {}}
    total = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for rel, path in _files(data):
            total += path.stat().st_size
            if total > MAX_BACKUP_BYTES or len(manifest["files"]) >= MAX_BACKUP_FILES:
                raise ValueError("备份超过 512 MiB 或文件数量上限，请先整理工作区")
            content = path.read_bytes()
            if rel.startswith("config/") and path.suffix in {".json", ".yaml", ".yml"}:
                if path.suffix == ".json":
                    content = json.dumps(_strip_config_keys(json.loads(content)), ensure_ascii=False).encode()
                else:
                    import yaml
                    content = yaml.safe_dump(_strip_config_keys(yaml.safe_load(content)), allow_unicode=True).encode()
            manifest["files"][rel] = {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
            archive.writestr(rel, content)
        if include_credentials:
            archive.writestr("credentials.json", json.dumps(_portable_secrets(data), ensure_ascii=False))
        archive.writestr("manifest.json", json.dumps(manifest))
    payload = buffer.getvalue()
    if password:
        salt = os.urandom(16)
        payload = json.dumps({"format": "lzcore-encrypted-backup", "schema": DATA_SCHEMA, "salt": base64.b64encode(salt).decode(), "ciphertext": _cipher(password, salt).encrypt(payload).decode()}).encode()
    temporary = target.with_name(target.name + f".{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return {"ok": True, "files": len(manifest["files"]), "encrypted": bool(password), "includes_credentials": include_credentials}


def read_backup(source: Path, password=""):
    if source.stat().st_size > MAX_BACKUP_BYTES * 2:
        raise ValueError("备份文件超过大小上限")
    payload = source.read_bytes()
    encrypted = not payload.startswith(b"PK")
    if encrypted:
        try:
            envelope = json.loads(payload)
            if envelope["format"] != "lzcore-encrypted-backup" or envelope["schema"] != DATA_SCHEMA:
                raise ValueError("不支持的备份格式")
            salt = base64.b64decode(envelope["salt"], validate=True)
            if len(salt) != 16:
                raise ValueError("不支持的备份格式")
            payload = _cipher(password, salt).decrypt(envelope["ciphertext"].encode())
        except (InvalidToken, KeyError, UnicodeError, ValueError) as exc:
            raise ValueError("备份口令错误或文件已损坏") from exc
    archive = zipfile.ZipFile(io.BytesIO(payload))
    infos = archive.infolist()
    if len(infos) > MAX_BACKUP_FILES + 2 or sum(x.file_size for x in infos) > MAX_BACKUP_BYTES:
        archive.close()
        raise ValueError("备份解压后的数据超过上限")
    names = [x.filename for x in infos]
    if len(names) != len(set(x.casefold() for x in names)):
        archive.close()
        raise ValueError("备份含重复文件")
    manifest = json.loads(archive.read("manifest.json"))
    if manifest.get("format") != "lzcore-backup" or manifest.get("schema") != DATA_SCHEMA:
        archive.close()
        raise ValueError("备份的数据版本不兼容")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(names) != set(files) | {"manifest.json"} | ({"credentials.json"} if manifest.get("includes_credentials") else set()):
        archive.close()
        raise ValueError("备份清单不完整")
    if "credentials.json" in names and not encrypted:
        archive.close()
        raise ValueError("凭据只能通过加密备份恢复")
    for item in infos:
        if item.filename in {"manifest.json", "credentials.json"}:
            continue
        member = _safe_member(item.filename)
        if "secrets" in member.parts:
            raise ValueError("凭据必须通过加密备份单独恢复")
        if stat.S_ISLNK(item.external_attr >> 16):
            raise ValueError("备份不能包含符号链接")
        raw = archive.read(item.filename)
        meta = files[item.filename]
        if len(raw) != meta["size"] or hashlib.sha256(raw).hexdigest() != meta["sha256"]:
            raise ValueError("备份校验失败")
    return archive, manifest


def stage_restore(data: Path, source: Path, *, password=""):
    archive, manifest = read_backup(source, password)
    restore_id = uuid.uuid4().hex
    stage = data / ".runtime" / "restore" / restore_id
    try:
        payload = stage / "payload"
        payload.mkdir(parents=True)
        for name in manifest["files"]:
            target = payload.joinpath(*_safe_member(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
        # Store transfer credentials only re-encrypted for the current Windows
        # user. No plaintext credential file is staged on disk.
        if manifest.get("includes_credentials"):
            from storage.os_secret_store import _dpapi_protect
            values = json.loads(archive.read("credentials.json"))
            for key, value in values.items():
                blob = _dpapi_protect(str(value).encode())
                if blob is None:
                    raise ValueError("当前系统不能安全保存恢复凭据")
                rel = _safe_member(key)
                if len(rel.parts) < 5 or rel.parts[0] != "workspaces" or rel.parts[-3:-1] != ("secrets", "dpapi") or not rel.name.endswith(".bin"):
                    raise ValueError("凭据备份的路径无效")
                target = payload.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(blob)
        atomic_write_json(stage / "plan.json", {"id": restore_id, "roots": [x for x in ("workspaces", "config") if (payload / x).exists()], "committed": [], "schema": DATA_SCHEMA})
        return {"ok": True, "restore_id": restore_id, "files": len(manifest["files"]), "includes_credentials": bool(manifest.get("includes_credentials"))}
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    finally:
        archive.close()


def stage_migration(data: Path, source: Path):
    """Selected old desktop data is copied and verified; source is retained."""
    if not (source / "workspaces").is_dir():
        raise ValueError("所选目录没有 workspaces，请选择旧版本程序或数据目录")
    if source.resolve() == data.resolve() or data.resolve() in source.resolve().parents or source.resolve() in data.resolve().parents:
        raise ValueError("源目录和当前数据目录不能相同或互相包含")
    restore_id = uuid.uuid4().hex
    stage = data / ".runtime" / "restore" / restore_id
    roots = []
    count = 0
    try:
        for name in ("workspaces", "config"):
            if (source / name).is_dir():
                roots.append(name)
                count += copy_verified(source / name, stage / "payload" / name)
        atomic_write_json(stage / "plan.json", {"id": restore_id, "roots": roots, "committed": [], "schema": DATA_SCHEMA})
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return {"ok": True, "restore_id": restore_id, "files": count, "includes_credentials": True}


def queue_restore(data: Path, restore_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", restore_id):
        raise ValueError("无效的恢复请求")
    if not (data / ".runtime" / "restore" / restore_id / "plan.json").is_file():
        raise ValueError("恢复数据尚未准备好")
    atomic_write_json(data / ".runtime" / "pending-restore.json", {"id": restore_id})


def apply_pending_restore(data: Path):
    """Run only at startup under the data-directory instance lock."""
    pending = data / ".runtime" / "pending-restore.json"
    if not pending.is_file():
        return None
    restore_id = json.loads(pending.read_text(encoding="utf-8")).get("id", "")
    if not re.fullmatch(r"[0-9a-f]{32}", restore_id):
        raise ValueError("无效的恢复请求")
    stage = data / ".runtime" / "restore" / restore_id
    plan = json.loads((stage / "plan.json").read_text(encoding="utf-8"))
    if plan.get("schema") != DATA_SCHEMA or not set(plan["roots"]).issubset({"workspaces", "config"}):
        raise ValueError("不支持的恢复计划")
    recovery = data / ".runtime" / "before-restore" / restore_id
    recovery.mkdir(parents=True, exist_ok=True)
    for name in plan["roots"]:
        if name in plan["committed"]:
            continue
        old, target, replacement = recovery / name, data / name, stage / "payload" / name
        if replacement.exists():
            if target.exists() and not old.exists():
                target.replace(old)
            if target.exists():
                raise ValueError("恢复目标发生变化，原数据已保留")
            # Preserve local credentials absent from a normal backup. Imported
            # encrypted credentials take precedence on explicit restore.
            if name == "workspaces" and old.is_dir():
                for folder in old.rglob("secrets"):
                    if folder.is_symlink():
                        continue
                    for item in folder.rglob("*"):
                        rel = item.relative_to(old)
                        dst = replacement / rel
                        if item.is_file() and not item.is_symlink() and not dst.exists():
                            dst.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(item, dst)
            replacement.replace(target)
        elif not target.exists():
            raise ValueError("恢复数据缺失；请保留恢复前备份目录")
        plan["committed"].append(name)
        atomic_write_json(stage / "plan.json", plan)
    pending.unlink()
    shutil.rmtree(stage)
    return {"restored": True, "recovery_dir": str(recovery)}
