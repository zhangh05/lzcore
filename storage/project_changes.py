"""Principal-scoped coding branches and recoverable compare-and-swap publication.

The model never supplies baseline hashes or file contents for integration.
Changes are derived from the actual isolated branch, staged durably, and
published under the same workspace lock as governed file operations.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from storage.atomic_io import atomic_write_json
from storage.locking import FileLock
from storage.paths import workspace_root

IGNORED = frozenset({".git", "node_modules", ".venv", "__pycache__", ".pytest_cache"})
MAX_BYTES = 64 * 1024 * 1024


def workspace_files_lock(workspace_id: str) -> FileLock:
    return FileLock(
        workspace_root(workspace_id) / "sys/workspace-files.lock", timeout=300
    )


def project_path(workspace_id: str, relative: str) -> Path:
    path = PurePosixPath(relative)
    if (
        path.is_absolute()
        or ".." in path.parts
        or path.parts[:2] != ("files", "data")
        or len(path.parts) < 3
    ):
        raise ValueError("coding_project_must_be_under_files_data")
    root = workspace_root(workspace_id).resolve()
    target = root.joinpath(*path.parts)
    if any(
        part.is_symlink() for part in (target, *target.parents) if part != root.parent
    ):
        raise ValueError("coding_project_symlink_forbidden")
    target.resolve().relative_to(root)
    return target


def validate_generated_paths(values: list[str] | None) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > 20:
        raise ValueError("invalid_generated_paths")
    result = []
    for value in values:
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ValueError("invalid_generated_path")
        path = PurePosixPath(value)
        if (
            path.is_absolute()
            or ".." in path.parts
            or not path.parts
            or any("*" in part or "?" in part for part in path.parts)
        ):
            raise ValueError("invalid_generated_path")
        normalized = path.as_posix()
        if normalized in (
            ".",
            "package.json",
            "package-lock.json",
            "pyproject.toml",
            "requirements.txt",
        ):
            raise ValueError("generated_path_cannot_hide_project_contract")
        result.append(normalized)
    return sorted(set(result))


def source_manifest(
    project: Path, generated_paths: list[str] | None = None
) -> dict[str, str]:
    generated = validate_generated_paths(generated_paths)
    result, total = {}, 0
    if not project.exists():
        return result
    for path in sorted(project.rglob("*")):
        relative = path.relative_to(project)
        if any(part in IGNORED for part in relative.parts) or any(
            relative.as_posix() == output
            or relative.as_posix().startswith(output + "/")
            for output in generated
        ):
            continue
        if path.is_symlink():
            raise ValueError("coding_source_symlink_forbidden")
        if path.is_file():
            size = path.stat().st_size
            total += size
            if total > MAX_BYTES or len(result) >= 10000:
                raise ValueError("coding_source_capacity_exceeded")
            result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def manifest_digest(manifest: dict) -> str:
    return hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def validate_responsibilities(values: list[str]) -> list[str]:
    if not values:
        raise ValueError("coding_file_responsibilities_required")
    result = []
    for value in values:
        path = PurePosixPath(value)
        if value == ".":
            result.append(".")
            continue
        if path.is_absolute() or ".." in path.parts or not path.parts or "\\" in value:
            raise ValueError("invalid_coding_file_responsibility")
        result.append(path.as_posix().rstrip("/"))
    return sorted(set(result))


def in_responsibility(path: str, responsibilities: list[str]) -> bool:
    return any(
        value == "." or path == value or path.startswith(value + "/")
        for value in responsibilities
    )


def copy_sources(source: Path, destination: Path, manifest: dict[str, str]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for relative, expected in manifest.items():
        data = (source / relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("coding_baseline_changed_during_snapshot")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def changeset(
    baseline: dict[str, str], current: dict[str, str], responsibilities: list[str]
) -> dict:
    changes = {
        path: {"before": baseline.get(path), "after": current.get(path)}
        for path in sorted(baseline.keys() | current.keys())
        if baseline.get(path) != current.get(path)
    }
    forbidden = [
        path for path in changes if not in_responsibility(path, responsibilities)
    ]
    if forbidden:
        raise ValueError("coding_responsibility_violation: " + ", ".join(forbidden))
    return {"files": changes, "digest": manifest_digest(changes)}


def _transaction_root(workspace_id: str, change_id: str) -> Path:
    if (
        not change_id.startswith("sub-")
        or len(change_id) != 12
        or any(c not in "0123456789abcdef" for c in change_id[4:])
    ):
        raise ValueError("invalid_coding_change_id")
    return workspace_root(workspace_id) / "sys/coding-transactions" / change_id


def publication_record(workspace_id: str, change_id: str) -> dict:
    """Read the durable publication evidence; caller holds the workspace lock."""
    return json.loads((_transaction_root(workspace_id, change_id) / "journal.json").read_text(encoding="utf-8"))


def _next_publication_order(workspace_id: str) -> int:
    # The same principal-scoped workspace lock covers reservation and apply.
    # A crash may leave a gap, never reuse an order or infer a completed write.
    path = workspace_root(workspace_id) / "sys/coding-publication-sequence.json"
    previous = json.loads(path.read_text(encoding="utf-8"))["order"] if path.exists() else 0
    if type(previous) is not int or previous < 0:
        raise ValueError("invalid_coding_publication_sequence")
    order = previous + 1
    atomic_write_json(path, {"schema": "coding.publication_sequence.v1", "order": order})
    return order


@contextmanager
def quiescent_project(workspace_id: str):
    """Serialize API writers and freeze project descendants during publication."""
    from core.tools.project_execution import environment_for

    with workspace_files_lock(workspace_id):
        environment = environment_for(workspace_id)
        paused = (
            environment is not None and environment.started and not environment.closed
        )
        if paused:
            environment._docker("pause", environment.name)
        generation = environment.generation if environment is not None else None
        try:
            yield
        finally:
            if paused and not environment.closed and environment.generation == generation:
                environment._docker("unpause", environment.name)


def _hash(path: Path) -> str | None:
    if path.is_symlink() or path.exists() and not path.is_file():
        raise ValueError("coding_publication_target_invalid")
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _replace(target: Path, source: Path | None) -> None:
    if source is None:
        target.unlink(missing_ok=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".coding-" + uuid.uuid4().hex)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def _recover(transaction: Path, project: Path, record: dict) -> dict:
    """Read back a prepared transaction; never overwrite an unrelated edit."""
    observed = {path: _hash(project / path) for path in record["files"]}
    if all(
        observed[path] == change["after"] for path, change in record["files"].items()
    ):
        record["phase"] = "integrated"
    elif any(
        observed[path] not in (change["before"], change["after"])
        for path, change in record["files"].items()
    ):
        record["phase"] = "unknown"
        record["observed"] = observed
    else:
        for path, change in record["files"].items():
            if observed[path] != change["before"]:
                _replace(
                    project / path,
                    transaction / "before" / path
                    if change["before"] is not None
                    else None,
                )
        record["phase"] = "rolled_back"
    atomic_write_json(transaction / "journal.json", record)
    return record


def publish_changes(
    workspace_id: str,
    project_relative: str,
    change_id: str,
    branch: Path,
    change: dict,
    *,
    generated_paths: list[str] | None = None,
) -> dict:
    generated = validate_generated_paths(generated_paths)
    project = project_path(workspace_id, project_relative)
    transaction = _transaction_root(workspace_id, change_id)
    with quiescent_project(workspace_id):
        journal = transaction / "journal.json"
        if journal.exists():
            record = json.loads(journal.read_text(encoding="utf-8"))
            if (
                record["digest"] != change["digest"]
                or record["project"] != project_relative
                or record.get("generated_paths", []) != generated
            ):
                raise ValueError("coding_transaction_identity_mismatch")
            if record["phase"] in {"prepared", "applying", "unknown"}:
                record = _recover(transaction, project, record)
            if record["phase"] in {"integrated", "unknown"}:
                return {"ok": record["phase"] == "integrated", **record}
        observed = source_manifest(project, generated)
        conflicts = [
            path
            for path, item in change["files"].items()
            if observed.get(path) != item["before"]
        ]
        if conflicts:
            return {
                "ok": False,
                "phase": "conflict",
                "conflicts": conflicts,
                "automatic_retry_allowed": False,
            }
        branch_manifest = source_manifest(branch, generated)
        if any(
            branch_manifest.get(path) != item["after"]
            for path, item in change["files"].items()
        ):
            raise ValueError("coding_validated_candidate_changed")
        transaction.mkdir(parents=True, exist_ok=True)
        for path, item in change["files"].items():
            for kind, source, expected in (
                ("before", project, item["before"]),
                ("after", branch, item["after"]),
            ):
                if expected is not None:
                    target = transaction / kind / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes((source / path).read_bytes())
                    if _hash(target) != expected:
                        raise ValueError("coding_transaction_snapshot_changed")
        record = {
            "schema": "coding.publication.v2",
            "publication_order": _next_publication_order(workspace_id),
            "project": project_relative,
            "generated_paths": generated,
            "digest": change["digest"],
            "files": change["files"],
            "phase": "prepared",
        }
        atomic_write_json(journal, record)
        try:
            record["phase"] = "applying"
            atomic_write_json(journal, record)
            for path, item in change["files"].items():
                _replace(
                    project / path,
                    transaction / "after" / path if item["after"] is not None else None,
                )
            record = _recover(transaction, project, record)
        except OSError:
            # Publication may have partially applied. Reconcile exact hashes;
            # an unrelated edit changes the outcome to unknown, never success.
            try:
                record = _recover(transaction, project, record)
            except OSError:
                return {
                    "ok": False,
                    "phase": "unknown",
                    "automatic_retry_allowed": False,
                }
        return {"ok": record["phase"] == "integrated", **record}


def reconcile_publication(workspace_id, project_relative, change_id, change, *, generated_paths=None):
    """Read back an uncertain publication without replacing any source file."""
    transaction = _transaction_root(workspace_id, change_id)
    project = project_path(workspace_id, project_relative)
    with quiescent_project(workspace_id):
        journal = transaction / "journal.json"
        if not journal.exists():
            return {"ok": False, "phase": "unknown", "automatic_retry_allowed": False,
                    "reason": "publication_journal_unavailable"}
        record = json.loads(journal.read_text(encoding="utf-8"))
        if (record["project"] != project_relative or record["digest"] != change["digest"]
                or record["files"] != change["files"]
                or record.get("generated_paths", []) != validate_generated_paths(generated_paths)):
            raise ValueError("coding_transaction_identity_mismatch")
        observed = {path: _hash(project / path) for path in record["files"]}
        if all(observed[path] == item["after"] for path, item in record["files"].items()):
            record["phase"] = "integrated"
        elif all(observed[path] == item["before"] for path, item in record["files"].items()):
            record["phase"] = "rolled_back"
        else:
            record.update(phase="unknown", observed=observed)
        atomic_write_json(journal, record)
        return {"ok": record["phase"] == "integrated", **record, "automatic_retry_allowed": False}
