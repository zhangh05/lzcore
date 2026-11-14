"""Temporary file lifecycle must preserve indexed owners and availability."""

import io
import os

import pytest

from core.runtime import archive, retention


@pytest.fixture
def temporary_file(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_WORKSPACE_DIR", str(tmp_path))
    from storage.file_store import import_user_upload, resolve_file_path
    record = import_user_upload("temp_lifecycle", io.BytesIO(b"synthetic image"), "image.png",
                                logical_type="tmp", file_kind="png", binary=True)
    path = resolve_file_path("temp_lifecycle", record.file_id)
    os.utime(path, (1_600_000_000, 1_600_000_000))
    return record, path


def _apply(operation):
    if operation == "retention":
        return retention.apply_retention("temp_lifecycle", dry_run=False, confirm=True)
    return archive.apply_archive("temp_lifecycle", dry_run=False, confirm=True)


@pytest.mark.parametrize("operation", ["retention", "archive"])
@pytest.mark.parametrize("owner_type", ["message", "artifact", "job"])
def test_retention_archive_preserve_referenced_temporary_files(temporary_file, operation, owner_type):
    from storage.file_store import get_file_record, resolve_file_path
    from storage.reference_index import add_reference, list_references_for_file
    record, path = temporary_file
    add_reference(record.workspace_id, record.file_id, owner_type, "synthetic-owner")
    result = _apply(operation)
    assert path.read_bytes() == b"synthetic image"
    assert resolve_file_path(record.workspace_id, record.file_id) == path
    assert get_file_record(record.workspace_id, record.file_id)["lifecycle"] == "active"
    assert list_references_for_file(record.workspace_id, record.file_id)
    assert any(item["path"] == path.name and item["reason"] == "active_file_ref" for item in result.blocked_items)


def test_retention_purges_unreferenced_file_and_updates_index(temporary_file):
    from storage.file_store import get_file_record, list_files
    record, path = temporary_file
    result = _apply("retention")
    assert not path.exists()
    assert result.deleted_counts["artifacts"] == 1
    assert get_file_record(record.workspace_id, record.file_id)["lifecycle"] == "purged"
    assert list_files(record.workspace_id) == []


def test_archive_keeps_unreferenced_managed_identity_resolvable(temporary_file):
    from storage.file_store import resolve_file_path
    record, path = temporary_file
    result = _apply("archive")
    assert resolve_file_path(record.workspace_id, record.file_id).read_bytes() == b"synthetic image"
    assert result.moved_counts == {}
    assert {"path": path.name, "reason": "managed_file_archive_unsupported"} in result.blocked_items


@pytest.mark.parametrize("operation", ["retention", "archive"])
def test_retention_archive_recheck_references_after_preview(temporary_file, monkeypatch, operation):
    from storage.reference_index import add_reference
    record, path = temporary_file
    if operation == "retention":
        original = retention.preview_retention
        target_module, target_name = retention, "preview_retention"
    else:
        # An unindexed temporary file becomes managed and referenced between
        # preview and apply. Archive must not use the earlier ownership snapshot.
        from storage import index
        assert index.delete_file_record(record.workspace_id, record.file_id)
        original = archive.preview_archive_candidates
        target_module, target_name = archive, "preview_archive_candidates"
    def preview_then_link(*args, **kwargs):
        result = original(*args, **kwargs)
        assert any(c["name"] == path.name for c in result.candidates)
        if operation == "archive":
            from storage import index
            index.append_file_record(record.workspace_id, record)
        add_reference(record.workspace_id, record.file_id, "message", "late-owner")
        return result
    monkeypatch.setattr(target_module, target_name, preview_then_link)
    result = _apply(operation)
    assert path.is_file()
    assert {"path": path.name, "reason": "active_file_ref"} in result.blocked_items


@pytest.mark.parametrize("operation", ["retention", "archive"])
@pytest.mark.parametrize("index_name", ["files.jsonl", "references.jsonl"])
def test_retention_archive_fail_closed_on_corrupt_indexes(temporary_file, operation, index_name):
    record, path = temporary_file
    root = path.parents[2]
    with (root / "index" / index_name).open("a", encoding="utf-8") as stream:
        stream.write("\n{malformed}\n")
    result = _apply(operation)
    assert path.is_file()
    assert {"path": path.name, "reason": "file_index_unavailable"} in result.blocked_items
    assert result.warnings


@pytest.mark.parametrize("stage", ["tombstone", "purge"])
def test_retention_index_failure_never_leaves_missing_payload_active(temporary_file, monkeypatch, stage):
    from storage import index
    from storage.file_store import get_file_record, list_files
    record, path = temporary_file
    update = index.update_file_record
    def fail_update(workspace, file_id, changes):
        if changes.get("lifecycle") == ("soft_deleted" if stage == "tombstone" else "purged"):
            return False
        return update(workspace, file_id, changes)
    monkeypatch.setattr(index, "update_file_record", fail_update)
    result = _apply("retention")
    assert result.deleted_counts["artifacts"] == 0 and result.warnings
    if stage == "tombstone":
        assert path.exists() and get_file_record(record.workspace_id, record.file_id)["lifecycle"] == "active"
    else:
        assert not path.exists() and list_files(record.workspace_id) == []
        assert get_file_record(record.workspace_id, record.file_id)["lifecycle"] == "soft_deleted"


def test_retention_directory_preserves_nested_reference(temporary_file):
    from storage import index
    from storage.reference_index import add_reference
    record, path = temporary_file
    nested = path.parent / "old-bundle"
    nested.mkdir()
    moved = nested / path.name
    path.rename(moved)
    index.update_file_record(record.workspace_id, record.file_id, {"path": f"files/tmp/old-bundle/{path.name}"})
    add_reference(record.workspace_id, record.file_id, "message", "nested-owner")
    os.utime(nested, (1_600_000_000, 1_600_000_000))
    result = _apply("retention")
    assert moved.exists()
    assert {"path": "old-bundle", "reason": "active_file_ref"} in result.blocked_items
