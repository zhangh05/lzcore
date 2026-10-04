"""Disposable build execution for immutable reviewed project snapshots.

Standard build tools may delete their output root. A bind-mounted writable
directory inside a read-only project cannot provide that contract. Assigned
argv checks therefore run in their own project copy; only declared outputs
return, after stopping descendants and proving that source stayed identical.
"""
from __future__ import annotations

import shutil
import socket
import uuid
from pathlib import Path

from storage.project_changes import copy_sources, source_manifest, manifest_digest, quiescent_project
from storage.paths import workspace_root


def _check_tree(path: Path, boundary: Path, *, links: bool) -> None:
    for item in [path, *path.rglob("*")]:
        if item.is_symlink():
            if not links:
                raise ValueError("validation_output_symlink_forbidden")
            item.resolve(strict=True).relative_to(boundary)


def execute_validation(owner, command, cwd, *, env=None, timeout=None, cancel_check=None):
    from core.tools.project_execution import isolated_project

    if owner.closed or not owner.started:
        return {"ok": False, "executed": False, "error_code": "ISOLATED_ENVIRONMENT_CLOSED"}
    directory = Path(cwd).resolve()
    if directory == owner.root:
        directory = owner.project
    if directory != owner.project:
        return {"ok": False, "executed": False, "error": "validation requires the assigned project directory"}
    stage_id = "validation-" + uuid.uuid4().hex
    relative = owner.project.relative_to(owner.root)
    stage = workspace_root(stage_id) / relative
    stage_environment = None
    result = {"ok": False, "executed": False}
    try:
        # Freeze the authoritative project while taking and validating a copy.
        with quiescent_project(owner.workspace_id):
            if owner.closed:
                raise ValueError("validation_owner_closed")
            baseline = source_manifest(owner.project, owner.generated_paths)
            copy_sources(owner.project, stage, baseline)
            # Carry prior generated outputs between separately declared checks.
            for path in owner.generated_paths:
                original = owner.project / path
                if original.exists():
                    _check_tree(original, owner.project, links=False)
                    shutil.copytree(original, stage / path, dirs_exist_ok=True)
            for cache in ("node_modules", ".venv"):
                original = owner.project / cache
                if original.exists():
                    _check_tree(original, owner.project, links=True)
                    shutil.copytree(original, stage / cache, symlinks=False)
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            with isolated_project(stage_id, stage, port, image=owner.image_id or owner.image) as stage_environment:
                result = stage_environment.execute(command, str(stage), env=env, timeout=timeout, cancel_check=cancel_check)
                if not stage_environment.close():
                    raise RuntimeError("validation_cleanup_unconfirmed")
            if source_manifest(stage, owner.generated_paths) != baseline:
                raise ValueError("validation_modified_source")
            if source_manifest(owner.project, owner.generated_paths) != baseline:
                raise ValueError("validation_candidate_changed")
            if result.get("ok") and result.get("exit_code") == 0:
                for path in owner.generated_paths:
                    output = stage / path
                    if not output.exists():
                        continue
                    if not output.is_dir():
                        raise ValueError("validation_output_requires_directory")
                    _check_tree(output, stage, links=False)
                    destination = owner.project / path
                    _check_tree(destination, owner.project, links=False)
                    destination.mkdir(parents=True, exist_ok=True)
                    # Retain the mounted root inode; replace only its contents.
                    for child in destination.iterdir():
                        shutil.rmtree(child) if child.is_dir() else child.unlink()
                    shutil.copytree(output, destination, dirs_exist_ok=True)
            result["validation_snapshot"] = {
                "source_digest": manifest_digest(baseline),
                "source_unchanged": True,
                "cleanup_confirmed": True,
            }
    except (OSError, ValueError, RuntimeError) as exc:
        result.update(ok=False, exit_code=1, error=str(exc), automatic_retry_allowed=False)
    finally:
        if stage_environment is None:
            from core.tools.project_execution import environment_for
            stage_environment = environment_for(stage_id)
        if stage_environment is not None:
            result["validation_environment"] = stage_environment.descriptor()
            if not stage_environment.cleanup_confirmed:
                result.update(ok=False, execution_outcome="unknown", automatic_retry_allowed=False)
        # These are owned scratch copies, never an implementation/QA branch.
        if stage_environment is None or stage_environment.cleanup_confirmed:
            try:
                shutil.rmtree(workspace_root(stage_id))
            except FileNotFoundError:
                pass
            except OSError as exc:
                result.update(ok=False, exit_code=1, error=f"validation_scratch_cleanup_failed: {type(exc).__name__}", automatic_retry_allowed=False)
    result.update(working_dir=relative.as_posix(), container_cwd=owner.mount_target,
                  runner="project_validation_snapshot", isolation_level=owner.isolation_level)
    return result
