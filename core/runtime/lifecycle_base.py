# runtime/lifecycle_base.py
"""Shared utilities for Retention and Archive — eliminates code duplication.

Both retention.py and archive.py share:
  - Path safety check (_is_safe_path)
  - Active artifact/reference detection (_get_active_refs)
  - Directory scanning with age/count filtering
  - Audit record writing

This module provides the common building blocks.
"""

import json
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Optional

from agent.runtime.utils import now_iso
from storage.atomic_io import atomic_write_json
from storage.paths import workspace_root


def workspace_dir(workspace_id: str) -> Path:
    return workspace_root(workspace_id)


def audit_record_path(workspace_id: str, audit_id: str) -> Path:
    """Validate the same single-segment audit identity on Windows and POSIX."""
    if not isinstance(audit_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", audit_id):
        raise ValueError("invalid_audit_id")
    root = workspace_dir(workspace_id).resolve()
    directory = root / "sys" / "audits"
    path = directory / f"{audit_id}.json"
    if not is_safe_path(directory, root) or not is_safe_path(path, directory):
        raise ValueError("invalid_audit_path")
    return path


def is_safe_path(path: Path, ws_dir: Path) -> bool:
    """Verify path is within workspace — uses relative_to(), NOT string startswith.

    Prevents path traversal, symlink escape, and cross-workspace access.
    """
    try:
        resolved = path.resolve()
        ws_resolved = ws_dir.resolve()
        resolved.relative_to(ws_resolved)
        return True
    except (ValueError, OSError):
        return False


def get_active_refs(ws_dir: Path) -> set:
    """Get artifact/job IDs referenced by workspace state and recent runs.

    These IDs are protected — never pruned or archived.
    Combines refs from:
      - workspace state.json (current_run_id, current_artifacts, etc.)
      - recent run records (artifact_refs)
    """
    active = set()

    # From workspace state
    state_file = ws_dir / "sys" / "state.json"
    if state_file.is_file():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            for key in ("current_run_id", "last_run_id", "current_job_id", "last_job_id", "current_artifacts",
                        "last_input_artifacts", "last_output_artifacts",
                        "last_report_artifacts", "current_report_artifact_id",
                        "current_topology_artifact_id"):
                val = state.get(key)
                if isinstance(val, str):
                    active.add(val)
                elif isinstance(val, list):
                    for v in val:
                        if isinstance(v, str):
                            active.add(v)
                        elif isinstance(v, dict):
                            active.add(v.get("artifact_id", ""))
        except Exception:
            pass

    # Every session-owned run remains active until the session is removed by
    # the session repository.  Lifecycle jobs must never strand a session by
    # pruning or archiving one of its run records behind its back.
    sessions_dir = ws_dir / "sessions"
    if sessions_dir.is_dir():
        for session_file in sessions_dir.glob("*.json"):
            try:
                session = json.loads(session_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            for run_id in session.get("run_ids") or []:
                if isinstance(run_id, str) and run_id:
                    active.add(run_id)

    # From all current run records. Limiting this scan makes protection depend
    # on directory iteration order and can expose older referenced artifacts.
    runs_dir = ws_dir / "runs"
    if runs_dir.is_dir():
        from storage.run_record_store import is_run_record_file

        for rf in runs_dir.iterdir():
            if not is_run_record_file(rf):
                continue
            try:
                record = json.loads(rf.read_text(encoding="utf-8-sig"))
                art_refs = record.get("artifact_refs", [])
                if isinstance(art_refs, list):
                    for ref in art_refs:
                        aid = ref.get("artifact_id", ref) if isinstance(ref, dict) else str(ref)
                        if aid:
                            active.add(aid)
            except Exception:
                pass

    return active


@contextmanager
def transient_file_guard(workspace_id: str):
    """Hold the existing writer locks while verifying file identities and refs.

    Lifecycle decisions must use strict reads: a damaged index is not evidence
    that a payload is unowned. The reference lock also covers new owner links.
    """
    from storage import index, records
    from storage.project_changes import workspace_files_lock

    root = workspace_dir(workspace_id).resolve()
    ref_path = root / "index" / "references.jsonl"
    with workspace_files_lock(workspace_id), records._lock_for(ref_path), records._file_lock(ref_path), index.IndexLock(workspace_id):
        files = index._records_from_lines(
            index._read_lines(root / "index" / "files.jsonl"), strict=True,
        )
        refs = records._read_jsonl_unlocked(ref_path, strict=True)
        for record in files:
            if (record.get("workspace_id") != workspace_id or not record.get("file_id")
                    or not record.get("path") or not is_safe_path(root / record["path"], root)):
                raise ValueError("invalid_managed_file_identity")
        if any(not ref.get("file_id") or ref.get("workspace_id") != workspace_id for ref in refs):
            raise ValueError("invalid_file_reference_identity")
        yield files, refs


def transient_block_reason(path: Path, ws_dir: Path, files: list, refs: list,
                           active_refs: set, *, archive: bool = False) -> str:
    """Protect indexed descendants as well as the file_id__name layout."""
    target = path.resolve()
    referenced = {ref["file_id"] for ref in refs} | active_refs
    matches = [rec for rec in files if (ws_dir / rec["path"]).resolve().is_relative_to(target)]
    if any(rec["file_id"] in referenced for rec in matches):
        return "active_file_ref"
    paths = [path, *(path.rglob("*") if path.is_dir() else [])]
    if any(item.name in active_refs or item.stem in active_refs
           or item.name.split("__", 1)[0] in referenced for item in paths):
        return "active_file_ref"
    # Archive has no FileStore relocation API. Keep these identities resolvable
    # instead of moving their payload behind the index's back.
    if archive and matches:
        return "managed_file_archive_unsupported"
    return ""


def scan_transient_files(workspace_id: str, ws_dir: Path, max_age_days: int,
                         active_refs: set, *, archive: bool = False) -> dict:
    result = scan_directory(ws_dir, "files/tmp", max_age_days=max_age_days,
                            active_refs=active_refs, check_is_file=False)
    candidates = []
    try:
        with transient_file_guard(workspace_id) as (files, refs):
            for name in result["candidates"]:
                reason = transient_block_reason(ws_dir / "files/tmp" / name, ws_dir,
                                                files, refs, active_refs, archive=archive)
                if reason:
                    result["blocked"].append({"path": name, "reason": reason})
                else:
                    candidates.append(name)
    except (OSError, ValueError, RuntimeError) as exc:
        candidates = []
        result["blocked"].extend({"path": name, "reason": "file_index_unavailable"}
                                 for name in result["candidates"])
        result["warnings"] = [f"transient_file_scan_blocked:{type(exc).__name__}"]
    result["candidates"] = candidates
    return result


def scan_directory(ws_dir: Path, subdir: str, max_age_days: int = 0,
                   max_count: int = 0, active_refs: Optional[set] = None,
                   check_is_file: bool = True,
                   name_filter: Callable[[Path], bool] | None = None) -> dict:
    """Scan a workspace subdirectory for candidates based on age and count.

    Args:
        ws_dir: Workspace root directory.
        subdir: Subdirectory name (e.g., "runs", "traces", "jobs").
        max_age_days: Maximum age in days before a file is a candidate. 0 = no age filter.
        max_count: Keep at most this many newest files; older ones become candidates. 0 = no count filter.
        active_refs: Set of IDs that should be protected from pruning.
        check_is_file: If True, skip non-file entries.

    Returns:
        Dict with keys: 'candidates' (list of names), 'blocked' (list of dicts).
    """
    target_dir = ws_dir / subdir
    if not target_dir.is_dir():
        return {"candidates": [], "blocked": []}

    now = time.time()
    candidates = []
    blocked = []
    active_refs = active_refs or set()

    # Sort by mtime (oldest first) for consistent count-based pruning
    entries = sorted(
        (entry for entry in target_dir.iterdir() if name_filter is None or name_filter(entry)),
        key=lambda p: p.stat().st_mtime,
    )
    expired = []
    eligible = []

    for entry in entries:
        if check_is_file and not entry.is_file():
            continue
        if not is_safe_path(entry, ws_dir):
            blocked.append({"path": entry.name, "reason": "path_outside_workspace"})
            continue
        # Active ref protection
        reference_keys = {entry.name, entry.stem}
        if entry.name.endswith(".trace.json"):
            reference_keys.add(entry.name[:-len(".trace.json")])
        if reference_keys.intersection(active_refs):
            blocked.append({"path": entry.name, "reason": "active_ref"})
            continue
        eligible.append(entry)

        # Age-based filter
        if max_age_days > 0:
            age_days = (now - entry.stat().st_mtime) / 86400
            if age_days > max_age_days:
                expired.append(entry.name)

    # Count-based filter (keep newest max_count)
    if max_count > 0 and len(eligible) > max_count:
        for entry in eligible[:-max_count]:
            if entry.name not in expired:
                expired.append(entry.name)

    candidates = list(dict.fromkeys(expired))  # dedupe preserving order
    return {"candidates": candidates, "blocked": blocked}


def write_audit(audit_dir: Path, record_type: str, workspace_id: str,
                dry_run: bool, policy: dict, candidate_counts: dict,
                result_counts: dict, warnings: list, blocked_count: int = 0) -> str:
    """Write an audit record to the workspace's runtime_audits directory.

    Args:
        audit_dir: Path to runtime_audits directory.
        record_type: "retention" or "archive".
        workspace_id: Workspace identifier.
        dry_run: Whether this was a dry run.
        policy: The policy used.
        candidate_counts: Counts of candidates by type.
        result_counts: Counts of deleted/moved items by type.
        warnings: List of warning strings.
        blocked_count: Number of blocked items.

    Returns:
        The audit_id.
    """
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_id = f"{record_type}_{uuid.uuid4().hex[:12]}"
    record = {
        "audit_id": audit_id,
        "type": record_type,
        "created_at": now_iso(),
        "workspace_id": workspace_id,
        "dry_run": dry_run,
        "confirmed": not dry_run,
        "policy": policy,
        "candidate_counts": candidate_counts,
        "result_counts": result_counts,
        "blocked_count": blocked_count,
        "warnings": warnings[:20],
    }
    atomic_write_json(audit_dir / f"{audit_id}.json", record)
    return audit_id
