"""Run-to-artifact index repository."""

from __future__ import annotations

import json
from typing import Any, Callable

from storage.atomic_io import atomic_write_json
from storage.ids import validate_run_id, validate_workspace_id
from storage.locking import FileLock
from storage.paths import workspace_root


def read_run_artifacts(workspace_id: str, run_id: str) -> dict[str, Any] | None:
    path = _path(workspace_id, run_id)
    if not path.is_file():
        return None
    with FileLock(_lock_path(path)):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
    return data if isinstance(data, dict) else None


def mutate_run_artifacts(workspace_id: str, run_id: str, mutator: Callable[[dict], Any]) -> Any:
    path = _path(workspace_id, run_id)
    with FileLock(_lock_path(path)):
        data = {
            "workspace_id": workspace_id,
            "run_id": run_id,
            "input_artifacts": [],
            "output_artifacts": [],
            "report_artifacts": [],
            "temp_artifacts": [],
        }
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data.update(loaded)
            except json.JSONDecodeError as exc:
                raise ValueError(f"malformed run artifact index: {run_id}") from exc
            except OSError:
                raise
        result = mutator(data)
        atomic_write_json(path, data)
        return result


def remove_artifact_from_all_runs(workspace_id: str, artifact_id: str) -> int:
    """Detach deleted artifacts from both indexes and run result projections.

    Trace and result summaries remain historical evidence of the execution.
    Only live artifact references are removed.
    """
    from storage.run_record_store import is_run_record_file

    ws_id = validate_workspace_id(workspace_id)
    runs_dir = workspace_root(ws_id) / "runs"
    if not runs_dir.is_dir():
        return 0
    changed_count = 0
    for path in runs_dir.glob("*.json"):
        is_index = path.name.endswith(".artifacts.json")
        if not is_index and not is_run_record_file(path):
            continue
        run_id = path.name[:-len(".artifacts.json")] if is_index else path.stem
        try:
            validate_run_id(run_id)
        except ValueError:
            continue

        fields = (
            ("input_artifacts", "output_artifacts", "report_artifacts", "temp_artifacts")
            if is_index else ("artifact_refs",)
        )
        with FileLock(_lock_path(path)):
            # A concurrent run deletion must not recreate an empty record.
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            changed = False
            for field in fields:
                values = list(data.get(field) or [])
                kept = [
                    item for item in values
                    if (item.get("artifact_id") if isinstance(item, dict) else item) != artifact_id
                ]
                if len(kept) != len(values):
                    data[field] = kept
                    changed = True
            if changed:
                atomic_write_json(path, data)
                changed_count += 1
    return changed_count


def _path(workspace_id: str, run_id: str):
    return workspace_root(validate_workspace_id(workspace_id)) / "runs" / f"{validate_run_id(run_id)}.artifacts.json"


def _lock_path(path):
    return path.with_name(path.name + ".lock")
