from __future__ import annotations

import re
from pathlib import Path

from core.tools.schemas import ToolInvocation
from storage.ids import validate_workspace_id
from storage.workspace_files import (
    create_workspace_text,
    is_current_workspace_write_path,
    managed_write_roots,
    write_text_atomic,
)

from core.tools.general_tools.shared import _caller_workspace, _error_inv, _generate_diff_preview, _ok, _result, _workspace_path
"""Split general tool handlers."""


def _is_current_workspace_write_path(ws: str, target: Path) -> bool:
    return is_current_workspace_write_path(ws, target)


def source_path_error(inv, environment=None):
    """Diagnose a rejected path without remapping it or granting permissions."""
    filepath = str(inv.arguments.get("filepath") or "")
    details = {"field": "filepath", "path_basis": "workspace_root",
               "managed_write_roots": list(managed_write_roots())}
    if environment is not None and environment.started and not environment.closed:
        project = environment.project.relative_to(environment.root).as_posix()
        details["active_project_dir"] = project
        safe = filepath and "\\" not in filepath and ".." not in Path(filepath).parts
        if safe and filepath.startswith(environment.mount_target + "/"):
            details["suggested_filepath"] = project + filepath[len(environment.mount_target):]
        elif safe and not Path(filepath).is_absolute() and not filepath.startswith("workspace/"):
            details["suggested_filepath"] = project + "/" + filepath
    result = _error_inv(inv, "filepath is relative to the workspace root, not the exec.run working directory; supply an explicit managed path and replan.",
                        error_code="FILE_PATH_OUTSIDE_MANAGED_STORAGE", details=details)
    result.update(executed=False, automatic_retry_allowed=False)
    return result


def handle_file_create(inv: ToolInvocation) -> dict:
    """Create a source file at an exact managed path; never overwrite."""
    ws = _caller_workspace(inv)
    filepath = str(inv.arguments.get("filepath") or "")
    try:
        content = inv.arguments.get("content")
        if not isinstance(content, str):
            return _error_inv(inv, "content must be a string")
        target = create_workspace_text(ws, filepath, content)
        return _ok(inv, f"Created {filepath}.", {
            "filepath": filepath, "size": target.stat().st_size, "created": True,
        })
    except FileExistsError:
        return _error_inv(inv, "file already exists; read it before using edit or patch")
    except (ValueError, OSError) as exc:
        return _error_inv(inv, str(exc)[:200])


def _text_line_ending(content: str) -> str:
    crlf = content.count("\r\n")
    counts = {"CRLF": crlf, "LF": content.count("\n") - crlf,
              "CR": content.count("\r") - crlf}
    endings = [kind for kind, count in counts.items() if count]
    return endings[0] if len(endings) == 1 else ("mixed" if endings else "none")


def handle_file_read(inv: ToolInvocation) -> dict:
    """Read a complete workspace text file. Rejects binary files.
    
    v3.7: Added offset for pagination — read from line N onwards.
    """
    ws = _caller_workspace(inv)
    filepath = inv.arguments.get("filepath", "")
    try:
        offset = max(0, int(inv.arguments.get("offset", 0) or 0))
        limit = inv.arguments.get("limit")
        limit = max(1, int(limit)) if limit is not None else None
        target = _workspace_path(ws, filepath)
        if not target.is_file():
            return _error_inv(inv, "file not found")
        with open(target, "rb") as f:
            head = f.read(1024)
        if b"\x00" in head:
            return _result(inv, False, {
                "ok": False,
                "error": "binary file cannot be read as text",
                "file_size": target.stat().st_size,
            })
        with target.open(encoding="utf-8", newline="") as source:
            content = source.read()
        line_ending = _text_line_ending(content)
        ends_with_newline = content.endswith(("\r", "\n"))
        lines = content.splitlines(keepends=True)
        end = min(len(lines), offset + limit) if limit is not None else len(lines)
        content = ''.join(lines[offset:end])
        return _ok(inv, f"Read {filepath}: {end - min(offset, len(lines))} of {len(lines)} line(s).", {
            "preview": content, "filepath": filepath,
            "size": len(content), "file_size_bytes": target.stat().st_size,
            "line_ending": line_ending, "ends_with_newline": ends_with_newline,
            "total_lines": len(lines),
            "offset": offset,
            "next_offset": end if end < len(lines) else None,
            "has_more": end < len(lines),
            "truncated": offset > 0 or end < len(lines),
        })
    except UnicodeError:
        return _error_inv(inv, "source is not valid UTF-8 text; use managed document extraction for other encodings/formats")
    except Exception as e:
        return _error_inv(inv, e)


def handle_file_edit(inv: ToolInvocation) -> dict:
    """Edit a current workspace-managed text file by string replacement.
    
    v3.7: dry_run=True returns preview diff without writing to file.
    """
    ws = _caller_workspace(inv)
    filepath = inv.arguments.get("filepath", "")
    old_string = inv.arguments.get("old_string", "")
    new_string = inv.arguments.get("new_string", "")
    replace_all = bool(inv.arguments.get("replace_all", False))
    dry_run = bool(inv.arguments.get("dry_run", False))
    try:
        target = _workspace_path(ws, filepath)
        if not _is_current_workspace_write_path(ws, target):
            return _error_inv(inv, "file.edit only writes to current managed workspace directories")
        if not target.is_file():
            return _error_inv(inv, "file not found")
        with target.open(encoding="utf-8", newline="") as source:
            content = source.read()
        count = content.count(old_string)
        if not count:
            return _error_inv(inv,
                f"old_string not found in file (file newlines={_text_line_ending(content)}, "
                f"old_string newlines={_text_line_ending(old_string)}). "
                "Use exact original text/newlines, or a verified unified patch for line edits.")
        if replace_all:
            new_content = content.replace(old_string, new_string)
        else:
            if count != 1:
                return _error_inv(inv, "old_string matches multiple locations; include unique context or explicitly set replace_all")
            new_content = content.replace(old_string, new_string, 1)
        if new_content == content:
            return _ok(inv, f"{filepath}: no changes made.", {"lines_changed": 0, "note": "no changes made"})
        diff_preview = _generate_diff_preview(old_string, new_string)
        if dry_run:
            return _ok(inv, "dry_run: preview only, file NOT modified", {
                "dry_run": True,
                "replacements": count,
                "diff": diff_preview,
                "diff_lines": abs(new_content.count("\n") - content.count("\n")),
            })
        write_text_atomic(target, new_content)
        lines_changed = abs(new_content.count("\n") - content.count("\n")) or count
        return _ok(inv, f"Edited {filepath}: {count} replacement(s).", {
            "lines_changed": lines_changed,
            "replacements": count,
            "preview": diff_preview,
        })
    except Exception as e:
        return _error_inv(inv, e)


def handle_file_patch(inv: ToolInvocation) -> dict:
    """Apply a unified diff patch to a current workspace-managed file."""
    ws = _caller_workspace(inv)
    filepath = inv.arguments.get("filepath", "")
    patch_text = inv.arguments.get("patch_text", "")
    try:
        target = _workspace_path(ws, filepath)
        if not _is_current_workspace_write_path(ws, target):
            return _error_inv(inv, "file.patch only writes to current managed workspace directories")
        if not target.is_file():
            return _error_inv(inv, "file not found")
        with target.open(encoding="utf-8", newline="") as source:
            original = source.read()
        try:
            new_content, lines_added, lines_removed = _apply_unified_patch(original, patch_text)
        except ValueError as exc:
            return _error_inv(inv, str(exc))
        if inv.arguments.get("dry_run"):
            return _ok(inv, "dry_run: preview only, file NOT modified", {
                "dry_run": True, "lines_added": lines_added, "lines_removed": lines_removed,
                "diff_preview": _generate_diff_preview(original, new_content),
            })
        write_text_atomic(target, new_content)
        return _ok(inv, f"Patched {filepath}: {lines_added} added line(s), {lines_removed} removed line(s).", {
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            "diff_preview": _generate_diff_preview(original[:500], new_content[:500]),
        })
    except Exception as e:
        return _error_inv(inv, e)



def _apply_unified_patch(original: str, patch_text: str) -> tuple[str, int, int]:
    """Validate the complete single-file diff before any atomic file write."""
    header = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*")
    patch = patch_text.splitlines()
    lines = original.splitlines(keepends=True)
    ending = "\r\n" if "\r\n" in original else "\n"
    result, position, index, added, removed, hunks = [], 0, 0, 0, 0, 0
    while index < len(patch) and not header.fullmatch(patch[index]):
        if not patch[index].startswith(("diff ", "index ", "--- ", "+++ ")):
            raise ValueError("no valid diff hunks found in patch_text")
        index += 1
    while index < len(patch):
        match = header.fullmatch(patch[index])
        if not match:
            raise ValueError("invalid unified diff hunk header")
        old_start, old_count, new_start, new_count = (int(v) if v is not None else 1 for v in match.groups())
        start = old_start if old_count == 0 else old_start - 1
        new_position = new_start if new_count == 0 else new_start - 1
        if start < position or start < 0 or start + old_count > len(lines):
            raise ValueError("patch hunk position is outside the current file or overlaps another hunk")
        result.extend(lines[position:start])
        if new_position != len(result):
            raise ValueError("patch new hunk position does not match preceding hunks")
        index += 1
        old, new = [], []
        last = ""
        while index < len(patch) and not header.fullmatch(patch[index]):
            line = patch[index]
            index += 1
            if line == "\\ No newline at end of file":
                if not last:
                    raise ValueError("newline marker has no preceding diff line")
                if last in {"-", " "}:
                    old[-1] = old[-1].rstrip("\r\n")
                if last in {"+", " "}:
                    new[-1] = new[-1].rstrip("\r\n")
                last = ""
                continue
            if not line or line[0] not in {"+", "-", " "}:
                raise ValueError("invalid unified diff line in patch_text")
            last = line[0]
            value = line[1:] + ending
            if last in {"-", " "}:
                old.append(value)
            if last in {"+", " "}:
                new.append(value)
            added += last == "+"
            removed += last == "-"
        if len(old) != old_count or len(new) != new_count:
            raise ValueError("patch hunk counts do not match its body")
        if lines[start:start + old_count] != old:
            raise ValueError("patch context does not match current file; re-read before retrying")
        result.extend(new)
        position = start + old_count
        hunks += 1
    if not hunks:
        raise ValueError("no valid diff hunks found in patch_text")
    result.extend(lines[position:])
    return "".join(result), added, removed

def handle_ws_list_files(inv: ToolInvocation) -> dict:
    ws = _caller_workspace(inv)
    subdir = inv.arguments.get("subdir", "")
    limit = max(1, min(int(inv.arguments.get("limit") or 50), 200))
    offset = max(0, int(inv.arguments.get("offset") or 0))
    try:
        target = _workspace_path(ws, subdir)
        if not target.exists():
            return _ok(inv, "", {"files": [], "count": 0})
        files = []
        for p in sorted(target.iterdir(), key=lambda entry: entry.name):
            relative_path = (Path(subdir) / p.name).as_posix()
            if p.is_file():
                files.append({
                    "name": p.name, "filepath": relative_path,
                    "size": p.stat().st_size, "suffix": p.suffix,
                })
            elif p.is_dir():
                files.append({"name": p.name, "filepath": relative_path, "type": "directory"})
        end = min(len(files), offset + limit)
        return _ok(inv, "", {"files": files[offset:end], "count": len(files),
                              "offset": offset, "has_more": end < len(files),
                              "next_offset": end if end < len(files) else None})
    except Exception as e:
        return _error_inv(inv, e)


def handle_file_search(inv: ToolInvocation) -> dict:
    """Literal source search without an index or shell; skips are explicit."""
    import fnmatch
    import os
    from core.tools.path_security import _contains_traversal

    ws, args = _caller_workspace(inv), inv.arguments
    query = str(args.get("query") or "")
    subdir, pattern = str(args.get("subdir") or "files/data"), str(args.get("pattern") or "*")
    offset, limit = max(0, int(args.get("offset") or 0)), min(200, int(args.get("limit") or 50))
    if not query or _contains_traversal(pattern) or pattern.startswith(("/", "\\")):
        return _error_inv(inv, "search requires literal query and a workspace-relative glob pattern")
    try:
        root = _workspace_path(ws, subdir)
        if not _is_current_workspace_write_path(ws, root):
            return _error_inv(inv, "source search requires files/data, files/tmp or inbox; use FileStore search for managed attachments")
        if not root.is_dir():
            return _error_inv(inv, "source search directory not found")
        matches, skipped, count, scanned, skipped_count, more = [], [], 0, 0, 0, False
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
            for name in sorted(names):
                lexical = Path(directory) / name
                relative = lexical.relative_to(root).as_posix()
                if not (fnmatch.fnmatchcase(relative, pattern) or (pattern.startswith("**/") and fnmatch.fnmatchcase(relative, pattern[3:]))):
                    continue
                if inv.cancel_check and inv.cancel_check():
                    return _error_inv(inv, "Source search cancelled", error_code="TOOL_CANCELLED")
                path = (Path(subdir) / relative).as_posix()
                try:
                    target = _workspace_path(ws, path)
                    if lexical.is_symlink():
                        raise ValueError("symlink skipped")
                    if target.stat().st_size > 4 * 1024 * 1024:
                        raise ValueError("source exceeds 4 MiB search limit")
                    raw = target.read_bytes()
                    if b"\x00" in raw:
                        raise ValueError("binary source skipped")
                    text = raw.decode("utf-8-sig")
                except (ValueError, OSError, UnicodeError) as exc:
                    skipped_count += 1
                    if len(skipped) < 20:
                        skipped.append({"filepath": path, "reason": str(exc)})
                    continue
                scanned += 1
                for line_number, line in enumerate(text.splitlines(), 1):
                    if query not in line:
                        continue
                    if count >= offset:
                        if len(matches) == limit:
                            more = True
                            break
                        column = line.index(query)
                        matches.append({"filepath": path, "line": line_number, "column": column + 1,
                                        "snippet": line[max(0, column - 80):column + len(query) + 160]})
                    count += 1
                if more:
                    break
            if more:
                break
        return _ok(inv, f"Source search returned {len(matches)} matching line(s).", {
            "matches": matches, "count": len(matches), "offset": offset,
            "has_more": more, "next_offset": offset + len(matches) if more else None,
            "coverage": {"subdir": subdir, "pattern": pattern, "scanned_files": scanned,
                         "skipped_files": skipped_count, "scan_complete": not more,
                         "skipped": skipped, "skipped_details_truncated": skipped_count > len(skipped),
                         "basis": "current UTF-8 source files; line matches, not occurrences; repeat pages against unchanged sources"},
        })
    except (ValueError, OSError) as exc:
        return _error_inv(inv, exc)


def handle_ws_write_artifact_file(inv: ToolInvocation) -> dict:
    ws = _caller_workspace(inv)
    filename = inv.arguments.get("filename", "output.txt")
    content = str(inv.arguments.get("content", ""))
    try:
        validate_workspace_id(ws)
        safe_name = re.sub(r'[^a-zA-Z0-9_.-]', '_', filename or "output.txt")
        suffix = Path(safe_name).suffix.lstrip(".") or "txt"
        from storage.file_types import classify_file
        if classify_file(safe_name)['binary'] and suffix != 'svg':
            return _error_inv(inv, 'Binary output requires publishing a real generated file; text content cannot create this format.')
        title = Path(safe_name).stem or "output"
        from storage.file_store import write_agent_output
        rec = write_agent_output(
            workspace_id=ws,
            content=content,
            logical_type="artifact_output",
            file_kind=suffix,
            title=title,
            ext=suffix,
            source="workspace.file",
            run_id=str(inv.run_id or ""),
            session_id=str(inv.session_id or ""),
        )
        output = {
            "filepath": rec.path,
            "file_id": rec.file_id,
            "size": rec.size_bytes,
        }
        if str(inv.arguments.get("action") or "") == "write_artifact":
            from storage.artifact_metadata_store import create_artifact_metadata
            from storage.reference_index import add_reference

            artifact = create_artifact_metadata(
                workspace_id=ws,
                file_record=rec,
                artifact_type="agent_file",
                title=safe_name,
                scope="session" if inv.session_id else "workspace",
                sensitivity="internal",
                run_id=str(inv.run_id or ""),
                session_id=str(inv.session_id or ""),
                source="workspace.file",
                metadata={"storage_managed": True},
                created_by=str(inv.requested_by or "agent"),
            )
            add_reference(
                ws,
                rec.file_id,
                "artifact",
                artifact["artifact_id"],
                "content",
                metadata={"run_id": str(inv.run_id or "")},
            )
            output.update({
                "artifact_id": artifact["artifact_id"],
                "artifact_ids": [artifact["artifact_id"]],
                "artifact_type": artifact["artifact_type"],
            })
        return _ok(inv, "", output)
    except Exception as e:
        return _error_inv(inv, e)


def handle_ws_get_metadata(inv: ToolInvocation) -> dict:
    ws = _caller_workspace(inv)
    try:
        target = _workspace_path(ws)
        return _ok(inv, "", {
            "workspace_id": ws,
            "exists": target.exists(),
            "artifact_count": len(list((target / "files").iterdir())) if (target / "files").exists() else 0,
        })
    except Exception as e:
        return _error_inv(inv, e)


def handle_file_read_image(inv: ToolInvocation) -> dict:
    """Read image metadata and transport real image evidence to the model."""
    ws = _caller_workspace(inv)
    filepath = inv.arguments.get("filepath", "")
    try:
        target = _workspace_path(ws, filepath)
        if not target.is_file():
            return _error_inv(inv, f"file not found: {filepath}")
        if target.stat().st_size > 20 * 1024 * 1024:
            return _error_inv(inv, "image too large (>20MB)")
        suffix = target.suffix.lower()
        img_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico", ".svg"}
        if suffix not in img_exts:
            return _error_inv(inv, f"not an image file: {suffix}")
        if suffix == '.svg':
            return _error_inv(inv, 'SVG source can be read with workspace.file read and previewed; visual evidence requires rendering to a raster image in the available execution environment.')
        from storage.image_transport import image_for_evidence
        from core.runtime_engine.evidence import managed_image_evidence
        fid, dimensions = image_for_evidence(ws, target, run_id=str(inv.run_id or ''), session_id=str(inv.session_id or ''))
        dims = f'{dimensions[0]}x{dimensions[1]}'
        return _ok(inv, f"Image {target.name} ({dims})", {
            "file_id": fid,
            "evidence_parts": [managed_image_evidence(fid)],
            "filename": target.name,
            "size": target.stat().st_size,
            "format": suffix.lstrip("."),
            "dimensions": dims,
            "filepath": filepath,
            "workspace_id": ws,
            "note": "Image evidence is delivered through the current model evidence transport.",
        })
    except Exception as e:
        return _error_inv(inv, e)


__all__ = ['handle_file_create', 'handle_file_read', 'handle_file_edit', 'handle_file_patch', 'handle_ws_list_files', 'handle_ws_write_artifact_file', 'handle_ws_get_metadata']
