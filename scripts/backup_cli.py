#!/usr/bin/env python3
"""Create, list, verify, prune, or restore LZCore backups."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.runtime.backup import (
    backup_path, create_backup, list_backups, prune_backups, restore_backup, service_instance_lock_path, verify_backup,
)


def restore_offline(archive: Path, *, confirmation: str):
    from core.runtime.backup import BackupError
    from storage.paths import get_workspace_root
    from storage.locking import FileLock
    from storage.backend import backend_mode
    from jobs.queue import queue_mode

    if backend_mode() not in {"filesystem", "file", "json"} or queue_mode() == "redis" or os.getenv("LZCORE_EVENT_BUS_MODE", "").lower() == "redis":
        raise BackupError("CLI restore does not support multi-process service deployments")
    data = get_workspace_root().resolve().parent
    configured = os.getenv("LZCORE_DESKTOP_DATA_DIR", "")
    if configured and Path(configured).expanduser().resolve() != data:
        raise BackupError("desktop data directory does not match workspace root")
    try:
        # Create/acquire even when no prior desktop has created the lock. Hold
        # it across extraction and replacement so a desktop cannot start midway.
        with FileLock(data / ".runtime" / "desktop-instance.lock", timeout=0):
            (data / ".runtime").mkdir(parents=True, exist_ok=True)
            with FileLock(service_instance_lock_path(), timeout=0):
                return restore_backup(archive, confirmation=confirmation)
    except TimeoutError:
        raise BackupError("data is in use; stop the desktop and backend before restoring") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create")
    commands.add_parser("list")
    verify = commands.add_parser("verify")
    verify.add_argument("archive")
    prune = commands.add_parser("prune")
    prune.add_argument("--keep", type=int, default=10)
    restore = commands.add_parser("restore")
    restore.add_argument("backup_id")
    restore.add_argument("--confirm", required=True)
    args = parser.parse_args()
    if args.command == "create":
        result = create_backup()
    elif args.command == "list":
        result = {"backups": list_backups()}
    elif args.command == "verify":
        result = verify_backup(args.archive)
    elif args.command == "prune":
        result = {"removed": prune_backups(args.keep)}
    else:
        result = restore_offline(backup_path(args.backup_id), confirmation=args.confirm)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
