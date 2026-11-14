"""Restore must share the normal index writer's transaction and identity checks."""

import io
import threading
from pathlib import Path

import pytest

from storage import index
from storage.file_bundle import export_bundle, restore_bundle
from storage.file_store import import_user_upload, write_agent_output
from storage.paths import workspace_root


@pytest.fixture
def bundle_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_WORKSPACE_DIR", str(tmp_path))
    return "bundle_index_atomic"


def test_restore_and_normal_write_interleave_without_losing_identity(bundle_workspace, monkeypatch):
    ws = bundle_workspace
    restored = import_user_upload(ws, io.BytesIO(b"restored payload"), "restore.txt")
    bundle = export_bundle(ws)
    idx = workspace_root(ws) / "index/files.jsonl"
    idx.write_text("", encoding="utf-8")
    (workspace_root(ws) / restored.path).unlink()
    existing = write_agent_output(ws, "existing", "report", "text")
    read_barrier = threading.Barrier(2, timeout=5)
    probe_barrier = threading.Barrier(2, timeout=5)
    original_read = Path.read_text
    restore_reads = 0
    results, errors = [], []

    def paused_read(path, *args, **kwargs):
        nonlocal restore_reads
        raw = original_read(path, *args, **kwargs)
        if path == idx and threading.current_thread().name == "bundle-restore":
            restore_reads += 1
            if restore_reads == 2:  # final transactional read, after preflight
                read_barrier.wait()
                probe_barrier.wait()
        return raw

    monkeypatch.setattr(Path, "read_text", paused_read)

    def restore():
        try:
            results.append(restore_bundle(ws, bundle, preview=False))
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=restore, name="bundle-restore", daemon=True)
    thread.start()
    normal = None
    blocked = False
    try:
        read_barrier.wait()
        try:
            with index.IndexLock(ws, timeout=0):
                # With the old, separate restore lock this commits before the
                # stale restore snapshot is published, deterministically losing it.
                normal = write_agent_output(ws, "normal", "report", "text")
        except TimeoutError:
            blocked = True
        probe_barrier.wait()
        if blocked:
            normal = write_agent_output(ws, "normal", "report", "text")
    finally:
        thread.join(timeout=10)
    assert not thread.is_alive()
    assert errors == []
    assert results[0]["restored"]
    assert blocked, "restore must hold the normal writer's files.lock"
    assert {r["file_id"] for r in index.read_file_records(ws)} == {
        restored.file_id, existing.file_id, normal.file_id,
    }
    assert not list(idx.parent.glob("*.tmp.*"))
    assert not (workspace_root(ws) / "sys/file-restore.intent.json").exists()


def test_restore_rechecks_identity_changed_after_preflight(bundle_workspace, monkeypatch):
    ws = bundle_workspace
    record = import_user_upload(ws, io.BytesIO(b"payload"), "restore.txt")
    bundle = export_bundle(ws)
    merge = index.merge_file_records
    changed = {**record.as_dict(), "source": "concurrent-writer"}

    def race(workspace_id, additions):
        index.append_file_record(workspace_id, changed)
        return merge(workspace_id, additions)

    monkeypatch.setattr(index, "merge_file_records", race)
    with pytest.raises(ValueError, match="identity_conflict"):
        restore_bundle(ws, bundle, preview=False)
    assert index.read_file_records(ws) == [changed]
    assert (workspace_root(ws) / "sys/file-restore.intent.json").exists()
