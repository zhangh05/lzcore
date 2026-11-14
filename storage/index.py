# storage/index.py
"""FileStore index management — safe, locked, atomic operations on files.jsonl.

P2-B: Production-grade index layer for FileStore.
  - Per-workspace advisory lock (fcntl.flock)
  - Append with lock + atomic tmp
  - Update/compact via atomic rewrite
  - Duplicate file_id resolution (last-active wins)
  - Consistency validation

Replaces direct open()/write_text() in storage/file_store.py.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from storage.atomic_io import atomic_write_text
from storage.paths import workspace_root
from storage.locking import FileLock

# ═══════════════════════════════════════════════════════════════════════
# Path helpers
# ═══════════════════════════════════════════════════════════════════════

_LOCK_TIMEOUT_S = 5.0
_LOCK_RETRY_INTERVAL_S = 0.05
_logger = logging.getLogger(__name__)


def _index_path(workspace_id: str) -> Path:
    return workspace_root(workspace_id) / "index" / "files.jsonl"


def _lock_path(workspace_id: str) -> Path:
    return workspace_root(workspace_id) / "index" / "files.lock"


# ═══════════════════════════════════════════════════════════════════════
# Locking
# ═══════════════════════════════════════════════════════════════════════

class IndexLock:
    """Advisory lock per workspace index.

    Uses the shared fail-closed cross-platform storage lock.

    Usage:
        with IndexLock(workspace_id) as lock:
            # read/write index safely
    """

    def __init__(self, workspace_id: str, timeout: float = _LOCK_TIMEOUT_S):
        self._ws = workspace_id
        self._timeout = timeout
        self._lock = None

    def __enter__(self):
        self._lock = FileLock(
            _lock_path(self._ws),
            timeout=self._timeout,
            retry_interval=_LOCK_RETRY_INTERVAL_S,
        )
        self._lock.__enter__()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._lock is not None:
            self._lock.__exit__(exc_type, exc_val, exc_tb)
            self._lock = None
        return False


# ═══════════════════════════════════════════════════════════════════════
# Core operations
# ═══════════════════════════════════════════════════════════════════════


def append_file_record(workspace_id: str, record) -> None:
    """Append a FileRecord to files.jsonl under lock.

    Uses atomic append: write temp line → fsync → os.replace the whole
    index. This is:
      - Safe against concurrent writers (lock)
      - Safe against crashes (read-then-append-then-replace atomic)
    """
    from storage.schemas import FileRecord

    idx = _index_path(workspace_id)
    idx.parent.mkdir(parents=True, exist_ok=True)

    with IndexLock(workspace_id):
        # Read existing records
        existing = _read_lines(idx)

        # Convert record to dict
        if isinstance(record, FileRecord):
            line = json.dumps(record.as_dict(), ensure_ascii=False, default=str)
        elif isinstance(record, dict):
            line = json.dumps(record, ensure_ascii=False, default=str)
        else:
            raise TypeError(f"Expected FileRecord or dict, got {type(record).__name__}")

        # Append new line
        existing.append(line)

        # Write atomically
        _atomic_write_lines(idx, existing)


def read_file_records(workspace_id: str) -> list[dict]:
    """Read all file records from files.jsonl.

    Deduplicates by file_id — the last occurrence wins.
    """
    idx = _index_path(workspace_id)
    lines = _read_lines(idx, strict=False)
    return _records_from_lines(lines)


def _records_from_lines(lines: list[str], *, strict: bool = False) -> list[dict]:
    records = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("non_object_file_index_record")
            records.append(record)
        except ValueError as exc:
            if strict:
                raise ValueError(f"malformed_file_index_record: line {line_number}") from exc
            _logger.warning("Skipping malformed file index record at line %s", line_number)
            continue

    # Deduplicate: last occurrence of each file_id wins
    seen: dict[str, int] = {}
    for i, rec in enumerate(records):
        fid = rec.get("file_id", "")
        if fid:
            seen[fid] = i

    # Return in original order, keeping only last occurrence per file_id
    keep_indices = set(seen.values())
    return [r for i, r in enumerate(records) if i in keep_indices]


def merge_file_records(workspace_id: str, additions: list[dict]) -> None:
    """Merge restored identities using the normal writer's lock and fresh state.

    Existing identical records are idempotent; conflicting identities fail
    closed, including identities written after restore's preview checks.
    """
    idx = _index_path(workspace_id)
    with IndexLock(workspace_id):
        lines = _read_lines(idx)
        known = {r["file_id"]: r for r in _records_from_lines(lines)}
        appended = []
        for record in additions:
            fid = record["file_id"]
            if fid in known:
                if known[fid] != record:
                    raise ValueError("backup_file_identity_conflict")
                continue
            appended.append(json.dumps(record, ensure_ascii=False, default=str))
            known[fid] = record
        if appended:
            _atomic_write_lines(idx, lines + appended)


def update_file_record(workspace_id: str, file_id: str, updates: dict) -> bool:
    """Update a file record atomically under lock.

    Returns True if the file_id was found and updated. Failures before replace
    preserve the old index; a directory fsync error after replace propagates
    with an uncertain durability outcome.
    """
    idx = _index_path(workspace_id)
    with IndexLock(workspace_id):
        lines = _read_lines(idx)
        found = False
        updated_lines = []

        for line in lines:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
                if rec.get("file_id") == file_id:
                    rec.update(updates)
                    found = True
                updated_lines.append(json.dumps(rec, ensure_ascii=False, default=str))
            except json.JSONDecodeError:
                updated_lines.append(line)

        if not found:
            return False

        _atomic_write_lines(idx, updated_lines)
        return True


def delete_file_record(workspace_id: str, file_id: str) -> bool:
    """Physically remove every version of one file record from the index."""
    idx = _index_path(workspace_id)
    with IndexLock(workspace_id):
        lines = _read_lines(idx)
        kept: list[str] = []
        found = False
        for line in lines:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                kept.append(line)
                continue
            if record.get("file_id") == file_id:
                found = True
                continue
            kept.append(json.dumps(record, ensure_ascii=False, default=str))
        if found:
            _atomic_write_lines(idx, kept)
        return found


def compact_file_index(workspace_id: str) -> dict:
    """Compact files.jsonl without dropping recoverable or referenced identities.

    Returns a summary dict:
      {"before": N, "after": M, "removed": N-M, "duplicates_resolved": D}
    """
    idx = _index_path(workspace_id)
    with IndexLock(workspace_id):
        lines = _read_lines(idx)
        if not lines:
            return {"before": 0, "after": 0, "removed": 0, "duplicates_resolved": 0}
        records = _records_from_lines(lines)

        # Count before
        before = sum(1 for line in lines if line.strip())

        # Remove soft-deleted and deduplicate
        kept = []
        duplicates = before - len(records)
        seen_ids = set()
        # Records are already deduplicated by read_file_records (last wins)
        for rec in records:
            fid = rec.get("file_id", "")
            # Remove soft-deleted
            if rec.get("lifecycle") == "deleted":
                continue
            if fid in seen_ids:
                duplicates += 1
                continue
            seen_ids.add(fid)
            kept.append(json.dumps(rec, ensure_ascii=False, default=str))

        _atomic_write_lines(idx, kept)

        after = len(kept)
        removed = before - after
        total_removed = removed  # includes dedup within already-deduped records
        return {
            "before": before,
            "after": after,
            "removed": total_removed,
            "duplicates_resolved": duplicates,
        }


def validate_file_index(workspace_id: str, *, check_disk: bool = True) -> dict:
    """Validate files.jsonl consistency.

    Checks:
      - Every path is workspace-relative and within workspace boundary
      - File exists on disk (if check_disk=True)
      - file_id uniqueness
      - size_bytes matches disk (if check_disk=True)
      - lifecycle field is valid
      - No path escapes

    Returns:
      {"ok": bool, "warnings": [...], "errors": [...], "stats": {...}}
    """
    idx = _index_path(workspace_id)
    result: dict = {
        "ok": True,
        "warnings": [],
        "errors": [],
        "stats": {
            "total_records": 0,
            "valid": 0,
            "missing_disk": 0,
            "size_mismatch": 0,
            "duplicate_ids": 0,
            "path_escapes": 0,
            "invalid_lifecycle": 0,
            "malformed_lines": 0,
        },
    }

    if not idx.is_file():
        result["ok"] = True
        result["stats"]["total_records"] = 0
        return result

    lines = _read_lines(idx, strict=False)
    records = []
    for line in lines:
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            result["stats"]["malformed_lines"] += 1
            result["warnings"].append(f"malformed JSON line: {line[:80]}")

    result["stats"]["total_records"] = len(records)

    # Check file_id uniqueness
    seen_ids = {}
    for rec in records:
        fid = rec.get("file_id", "")
        if not fid:
            continue
        if fid in seen_ids:
            result["stats"]["duplicate_ids"] += 1
            result["warnings"].append(
                f"Duplicate file_id: {fid} (lines {seen_ids[fid]}, current)"
            )
        else:
            seen_ids[fid] = len(seen_ids) + 1

    # Validate each record
    ws = workspace_root(workspace_id).resolve()
    for rec in records:
        fid = rec.get("file_id", "?")
        path_str = rec.get("path", "")

        # Path boundary check
        try:
            p = Path(str(path_str))
            if p.is_absolute():
                result["stats"]["path_escapes"] += 1
                result["errors"].append(f"{fid}: absolute path {path_str[:80]}")
                continue
            resolved = (ws / p).resolve()
            try:
                resolved.relative_to(ws)
            except ValueError:
                result["stats"]["path_escapes"] += 1
                result["errors"].append(f"{fid}: path escape {path_str[:80]}")
                continue
        except Exception:
            result["stats"]["path_escapes"] += 1
            result["errors"].append(f"{fid}: invalid path {path_str[:80]}")
            continue

        # Lifecycle check
        lc = rec.get("lifecycle", "active")
        if lc not in ("active", "soft_deleted", "deleted", "purged", "archived", ""):
            result["stats"]["invalid_lifecycle"] += 1
            result["warnings"].append(f"{fid}: invalid lifecycle '{lc}'")

        # Disk check
        if check_disk:
            disk_path = ws / path_str
            if not disk_path.exists():
                result["stats"]["missing_disk"] += 1
                result["warnings"].append(f"{fid}: file missing on disk: {path_str[:80]}")
                continue

            # Size check
            if disk_path.is_file():
                disk_size = disk_path.stat().st_size
                index_size = rec.get("size_bytes", 0)
                if index_size and abs(disk_size - index_size) > 1:  # allow 1-byte tolerance
                    result["stats"]["size_mismatch"] += 1
                    result["warnings"].append(
                        f"{fid}: size mismatch index={index_size} disk={disk_size}"
                    )

        result["stats"]["valid"] += 1

    # Overall ok
    has_errors = any(result["stats"][k] > 0 for k in ("path_escapes",))
    result["ok"] = not has_errors
    if not result["ok"]:
        result["errors"].insert(0, "Index validation FAILED")

    return result


# ═══════════════════════════════════════════════════════════════════════
# Internal helpers
# ═══════════════════════════════════════════════════════════════════════


def _read_lines(path: Path, *, strict: bool = True) -> list[str]:
    """Only missing files are empty; mutations also reject malformed records."""
    try:
        lines = path.read_text(encoding="utf-8").split("\n")
    except FileNotFoundError:
        return []
    except (OSError, UnicodeDecodeError) as exc:
        if strict:
            raise
        _logger.warning("Unable to read file index (%s)", type(exc).__name__)
        return []
    if strict:
        _records_from_lines(lines, strict=True)
    return lines


def _atomic_write_lines(path: Path, lines: list[str]) -> None:
    """Use the shared atomic writer, including file and directory fsync.

    Before replacement failures preserve the original. Directory sync errors
    after replacement propagate as an uncertain durability outcome.
    """
    content = "\n".join(lines) + ("\n" if lines else "")
    atomic_write_text(path, content)
