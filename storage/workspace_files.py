"""Workspace file repository helpers for tool handlers."""

from __future__ import annotations

from pathlib import Path
import os
import tempfile

from storage.atomic_io import atomic_write_text
from storage.ids import validate_run_id
from storage.paths import workspace_root

_WRITE_DIRS = (
    "files/data",
    "files/tmp",
    "inbox",
)

_IMPORT_ROOTS = (
    "files/data",
    "files/tmp",
    "inbox",
)


def resolve_workspace_path(workspace_id: str, subpath: str = "") -> Path:
    root = workspace_root(workspace_id).resolve()
    target = (root / str(subpath or "").lstrip("/").lstrip("\\")).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("path_escape_denied") from exc
    return target


def is_current_workspace_write_path(workspace_id: str, target: Path) -> bool:
    root = resolve_workspace_path(workspace_id, "")
    try:
        rel = target.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return False
    return any(rel == allowed or rel.startswith(f"{allowed}/") for allowed in _WRITE_DIRS)


def write_text_atomic(path: Path, content: str) -> None:
    validate_source_text(content)
    atomic_write_text(path, content)


def validate_source_text(content: str) -> None:
    """Text source writes must remain readable by the text repository.

    Binary attachments use FileStore. Reject malformed text before touching a
    file rather than guessing replacements or publishing unreadable source.
    """
    if not isinstance(content, str) or '\x00' in content:
        raise ValueError('source text contains a NUL byte; correct the text before writing; binary data belongs in FileStore')
    content.encode('utf-8', errors='strict')


def create_workspace_text(workspace_id: str, subpath: str, content: str) -> Path:
    """Publish a complete source file without replacing an existing path.

    Source trees retain their requested paths; generated attachments continue
    to use FileStore. The hard link publishes atomically and fails if another
    writer has already created the target, including a dangling symlink.
    """
    validate_source_text(content)
    if not subpath or Path(subpath).is_absolute() or "\\" in subpath:
        raise ValueError("source filepath must be workspace-relative using forward slashes")
    if ".." in Path(subpath).parts:
        raise ValueError("path_escape_denied")
    lexical = workspace_root(workspace_id)
    for part in Path(subpath).parts:
        lexical = lexical / part
        if lexical.is_symlink():
            raise ValueError("source filepath must not traverse symlinks")
    target = resolve_workspace_path(workspace_id, subpath)
    if not is_current_workspace_write_path(workspace_id, target):
        raise ValueError("source creation only writes to current managed workspace directories")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Resolve again after creating parents, before publishing into that scope.
    target = resolve_workspace_path(workspace_id, subpath)
    if not is_current_workspace_write_path(workspace_id, target):
        raise ValueError("path_escape_denied")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".source-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_python_temp_script(workspace_id: str, run_id: str, content: str) -> tuple[Path, Path]:
    safe_run_id = validate_run_id(run_id)
    temp_dir = resolve_workspace_path(workspace_id, f"files/tmp/python_exec/{safe_run_id}")
    script_path = temp_dir / "script.py"
    atomic_write_text(script_path, content)
    return temp_dir, script_path


def resolve_importable_workspace_path(workspace_id: str, filepath: str) -> Path:
    target = resolve_workspace_path(workspace_id, filepath)
    root = resolve_workspace_path(workspace_id, "")
    rel = target.relative_to(root).as_posix()
    if not (rel == "inbox" or rel.startswith("inbox/")):
        raise ValueError("path_not_allowed")
    return target


def allowed_import_roots(workspace_id: str) -> list[Path]:
    root = resolve_workspace_path(workspace_id, "")
    return [root / rel for rel in _IMPORT_ROOTS]
