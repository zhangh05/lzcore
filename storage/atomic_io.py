"""Atomic filesystem IO helpers for storage adapters."""

from __future__ import annotations

import json
import math
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional


def _unique_tmp(path: Path) -> Path:
    suffix = f".tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}"
    return path.with_name(path.name + suffix)


def _replace_with_retry(tmp: Path, path: Path) -> None:
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.05 * (attempt + 1))
    try:
        tmp.unlink()
    except OSError:
        pass
    if last_error is not None:
        raise last_error
    raise OSError(f"failed to replace {path}")


def atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _unique_tmp(path)
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    _replace_with_retry(tmp, path)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically replace a binary payload."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _unique_tmp(path)
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    _replace_with_retry(tmp, path)


def _json_without_nonfinite(value: Any) -> Any:
    """Keep a NaN in one record from failing every other JSON write."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _json_without_nonfinite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_without_nonfinite(item) for item in value]
    return value


def atomic_write_json(path: Path, obj: Any, *, indent: Optional[int] = 2) -> None:
    text = json.dumps(
        _json_without_nonfinite(obj),
        ensure_ascii=False,
        indent=indent,
        default=str,
        allow_nan=False,
    )
    atomic_write_text(Path(path), text)


def safe_read_text(path: Path, default: str = "") -> str:
    try:
        p = Path(path)
        if not p.is_file():
            return default
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return default


def safe_read_json(path: Path, default: Any = None) -> Any:
    try:
        p = Path(path)
        if not p.is_file():
            return default
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return default
