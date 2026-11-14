"""Safety contract for the LLM-visible artifact deletion action."""

from pathlib import Path

import pytest

from core.tools.schemas import ToolInvocation


def test_hard_delete_detaches_run_refs_and_preserves_execution_history(tmp_path, monkeypatch):
    import json

    import artifacts.store as artifact_store
    import storage.run_artifact_store as run_artifacts
    from artifacts.schemas import ArtifactRecord
    from storage.atomic_io import atomic_write_json
    from storage import reference_index

    runs = tmp_path / "runs"
    runs.mkdir()
    record_path = runs / "run_test.json"
    index_path = runs / "run_test.artifacts.json"
    trace_path = runs / "run_test.trace.json"
    atomic_write_json(record_path, {
        "artifact_refs": [{"artifact_id": "art_deleted"}, "art_deleted", {"artifact_id": "art_kept"}],
        "final_response_summary": "Historical output",
        "status": "succeeded",
    })
    atomic_write_json(index_path, {"output_artifacts": [{"artifact_id": "art_deleted"}, {"artifact_id": "art_kept"}]})
    atomic_write_json(trace_path, {"artifact_refs": [{"artifact_id": "art_deleted"}]})
    original_trace = trace_path.read_bytes()
    monkeypatch.setattr(run_artifacts, "workspace_root", lambda _ws: tmp_path)
    artifact = ArtifactRecord(artifact_id="art_deleted", workspace_id="test_ws")
    monkeypatch.setattr(artifact_store, "get_artifact", lambda *_args: artifact)
    monkeypatch.setattr(artifact_store, "_records_in_index_order", lambda *_args: [artifact])
    monkeypatch.setattr(artifact_store, "_remove_from_knowledge_index", lambda *_args: None)
    monkeypatch.setattr(reference_index, "list_references_for_owner", lambda *_args: [])
    monkeypatch.setattr("storage.events.publish", lambda *_args: None)

    def remove_metadata(*_args):
        # References must be detached before metadata disappears, so failed
        # reference cleanup leaves the artifact addressable for a retry.
        assert json.loads(record_path.read_text())["artifact_refs"] == [{"artifact_id": "art_kept"}]

    monkeypatch.setattr(artifact_store, "_remove_artifact_record_permanently", remove_metadata)
    assert artifact_store.delete_artifact("test_ws", "art_deleted", hard=True)
    assert json.loads(record_path.read_text()) == {
        "artifact_refs": [{"artifact_id": "art_kept"}],
        "final_response_summary": "Historical output",
        "status": "succeeded",
    }
    assert json.loads(index_path.read_text())["output_artifacts"] == [{"artifact_id": "art_kept"}]
    assert trace_path.read_bytes() == original_trace
    assert run_artifacts.remove_artifact_from_all_runs("test_ws", "art_deleted") == 0


def test_workspace_artifact_delete_is_recoverable(monkeypatch):
    import artifacts.store as artifact_store
    from core.tools.general_tools.artifact_tools import handle_artifact_delete_soft

    called = {}

    def fake_delete(workspace_id, artifact_id, *, hard=False):
        called.update(workspace_id=workspace_id, artifact_id=artifact_id, hard=hard)
        return True

    monkeypatch.setattr(artifact_store, "delete_artifact", fake_delete)
    result = handle_artifact_delete_soft(ToolInvocation(
        tool_id="workspace.artifact", workspace_id="test_ws",
        arguments={"action": "delete", "artifact_id": "art_test"},
    ))

    assert called == {"workspace_id": "test_ws", "artifact_id": "art_test", "hard": False}
    assert result["ok"] is True
    assert result["recoverable"] is True
    assert result["lifecycle"] == "deleted"


def test_soft_deleted_artifact_does_not_soft_delete_its_filestore_payload(monkeypatch):
    import artifacts.store as artifact_store
    from artifacts.schemas import ArtifactRecord
    from storage import file_store

    record = ArtifactRecord(
        artifact_id="art_test", workspace_id="test_ws", file_id="file_shared",
        lifecycle="active",
    )
    monkeypatch.setattr(artifact_store, "get_artifact", lambda *_args: record)
    monkeypatch.setattr(artifact_store, "_remove_from_knowledge_index", lambda *_args: None)
    monkeypatch.setattr(artifact_store, "_save_artifact_record", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(file_store, "soft_delete_file", lambda *_args: (_ for _ in ()).throw(AssertionError("payload must remain active")))

    assert artifact_store.delete_artifact("test_ws", "art_test", hard=False) is True
    assert record.lifecycle == "deleted"


def test_hard_delete_removes_payload_before_refs_and_metadata(monkeypatch):
    import artifacts.store as artifact_store
    from artifacts.schemas import ArtifactRecord
    from storage import file_store
    from storage import reference_index

    record = ArtifactRecord(
        artifact_id="art_payload", workspace_id="test_ws", file_id="file_only",
        lifecycle="active",
    )
    order = []
    monkeypatch.setattr(artifact_store, "get_artifact", lambda *_args: record)
    monkeypatch.setattr(artifact_store, "_records_in_index_order", lambda *_args: [record])
    monkeypatch.setattr(artifact_store, "_remove_from_knowledge_index", lambda *_args: None)
    monkeypatch.setattr(reference_index, "list_references_for_file", lambda *_args: [
        {"ref_id": "ref_artifact", "owner_type": "artifact", "owner_id": "art_payload"},
    ])
    monkeypatch.setattr(reference_index, "list_references_for_owner", lambda *_args: [
        {"ref_id": "ref_artifact", "owner_type": "artifact", "owner_id": "art_payload"},
    ])
    monkeypatch.setattr(reference_index, "remove_reference", lambda *_args: True)
    monkeypatch.setattr(artifact_store, "_remove_artifact_from_run_indexes", lambda *_args: order.append("refs") or None)
    monkeypatch.setattr(artifact_store, "_remove_artifact_record_permanently", lambda *_args: order.append("metadata") or None)
    monkeypatch.setattr(file_store, "delete_file_permanently", lambda *_args: order.append("payload") or True)

    assert artifact_store.delete_artifact("test_ws", "art_payload", hard=True) is True
    assert order == ["payload", "refs", "metadata"]


def test_hard_delete_preserves_payload_referenced_by_non_artifact_owner(monkeypatch):
    """Hard delete must keep a payload still owned by a message or knowledge source."""
    import artifacts.store as artifact_store
    from artifacts.schemas import ArtifactRecord
    from storage import file_store
    from storage import reference_index

    record = ArtifactRecord(
        artifact_id="art_test", workspace_id="test_ws", file_id="file_shared",
        lifecycle="active",
    )
    removed_refs = []
    monkeypatch.setattr(artifact_store, "get_artifact", lambda *_args: record)
    monkeypatch.setattr(artifact_store, "_records_in_index_order", lambda *_args: [record])
    monkeypatch.setattr(artifact_store, "_remove_from_knowledge_index", lambda *_args: None)
    monkeypatch.setattr(artifact_store, "_remove_artifact_record_permanently", lambda *_args: None)
    monkeypatch.setattr(artifact_store, "_remove_artifact_from_run_indexes", lambda *_args: None)
    monkeypatch.setattr(file_store, "delete_file_permanently", lambda *_args: (_ for _ in ()).throw(
        AssertionError("shared payload must remain available")
    ))
    monkeypatch.setattr(reference_index, "list_references_for_file", lambda *_args: [
        {"ref_id": "ref_artifact", "owner_type": "artifact", "owner_id": "art_test"},
        {"ref_id": "ref_message", "owner_type": "message", "owner_id": "msg_1"},
    ])
    monkeypatch.setattr(reference_index, "list_references_for_owner", lambda *_args: [
        {"ref_id": "ref_artifact", "owner_type": "artifact", "owner_id": "art_test"},
    ])
    monkeypatch.setattr(reference_index, "remove_reference", lambda _ws, ref_id: removed_refs.append(ref_id) or True)

    assert artifact_store.delete_artifact("test_ws", "art_test", hard=True) is True
    assert removed_refs == ["ref_artifact"]


@pytest.fixture
def permanent_delete_case(tmp_path, monkeypatch):
    import artifacts.store as artifact_store
    from artifacts.schemas import ArtifactRecord
    from storage.atomic_io import atomic_write_json
    from storage.file_store import create_file_record

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    root = tmp_path / "test_ws"
    path = root / "files/data/delete.txt"
    path.parent.mkdir(parents=True)
    path.write_text("synthetic payload", encoding="utf-8")
    create_file_record("test_ws", "artifact_output", "text", "files/data/delete.txt", file_id="file_only")
    record = ArtifactRecord(
        artifact_id="art_payload", workspace_id="test_ws", file_id="file_only",
        relative_path="files/data/delete.txt", lifecycle="active",
    )
    artifact_store._save_artifact_record(record, add_to_index=True)
    run_path = root / "runs/run_delete.json"
    atomic_write_json(run_path, {"status": "succeeded", "artifact_refs": [record.artifact_id]})
    events, knowledge_cleanup = [], []
    monkeypatch.setattr("storage.events.publish", lambda *args: events.append(args))
    monkeypatch.setattr(artifact_store, "_remove_from_knowledge_index", lambda *args: knowledge_cleanup.append(args))
    return record, path, run_path, events, knowledge_cleanup


def _move_payload_to_trash(record, path):
    from storage import index
    from storage.file_store import soft_delete_file

    trash = path.parents[2] / ".trash/delete.txt"
    trash.parent.mkdir()
    path.rename(trash)
    assert soft_delete_file(record.workspace_id, record.file_id)
    assert index.update_file_record(record.workspace_id, record.file_id, {"metadata": {"trash_path": ".trash/delete.txt"}})
    return trash


@pytest.mark.parametrize("payload_kind", ["managed", "trash", "legacy"])
def test_payload_unlink_failure_preserves_metadata_refs_and_retry(permanent_delete_case, monkeypatch, payload_kind):
    import artifacts.store as artifact_store
    from storage.file_store import get_file_record
    from storage.reference_index import list_references

    record, path, run_path, events, knowledge_cleanup = permanent_delete_case
    replacement = None
    if payload_kind == "trash":
        replacement = path
        path = _move_payload_to_trash(record, path)
        replacement.write_text("new unrelated payload", encoding="utf-8")
    elif payload_kind == "legacy":
        record.file_id = ""
        artifact_store._save_artifact_record(record)
    artifact_before = artifact_store.get_artifact("test_ws", record.artifact_id)
    file_before = get_file_record("test_ws", "file_only")
    refs_before = list_references("test_ws")
    run_before = run_path.read_bytes()
    unlink = Path.unlink

    def fail_payload_unlink(target, *args, **kwargs):
        if target == path:
            raise PermissionError("synthetic payload busy")
        return unlink(target, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_payload_unlink)
        assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is False
    assert path.read_text(encoding="utf-8") == "synthetic payload"
    assert artifact_store.get_artifact("test_ws", record.artifact_id) == artifact_before
    assert get_file_record("test_ws", "file_only") == file_before
    assert list_references("test_ws") == refs_before
    assert run_path.read_bytes() == run_before
    assert knowledge_cleanup == []
    assert events == []

    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert not path.exists()
    assert artifact_store.get_artifact("test_ws", record.artifact_id) is None
    if payload_kind != "legacy":
        assert get_file_record("test_ws", "file_only") is None
    if replacement is not None:
        assert replacement.read_text(encoding="utf-8") == "new unrelated payload"
    assert list_references("test_ws") == []
    assert events == [("test_ws", "artifact", "deleted", record.artifact_id)]


@pytest.mark.parametrize("trashed", [False, True])
@pytest.mark.parametrize("failure", ["false", "exception", "after_replace"])
def test_filestore_metadata_failure_keeps_retryable_identity(permanent_delete_case, monkeypatch, trashed, failure):
    import artifacts.store as artifact_store
    from storage import index
    from storage.file_store import get_file_record
    from storage.reference_index import list_references

    record, path, run_path, events, _ = permanent_delete_case
    if trashed:
        path = _move_payload_to_trash(record, path)
    file_before = get_file_record("test_ws", record.file_id)
    refs_before = list_references("test_ws")
    run_before = run_path.read_bytes()
    delete_metadata = index.delete_file_record

    def fail_metadata(*args):
        assert not path.exists()
        if failure == "after_replace":
            assert delete_metadata(*args) is True
        if failure != "false":
            raise OSError("synthetic index failure")
        return False

    with monkeypatch.context() as patch:
        patch.setattr(index, "delete_file_record", fail_metadata)
        assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is False
    assert not path.exists()
    assert get_file_record("test_ws", record.file_id) == (None if failure == "after_replace" else file_before)
    assert artifact_store.get_artifact("test_ws", record.artifact_id) == record
    assert list_references("test_ws") == refs_before
    assert run_path.read_bytes() == run_before
    assert events == []
    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert get_file_record("test_ws", record.file_id) is None
    assert artifact_store.get_artifact("test_ws", record.artifact_id) is None
    assert list_references("test_ws") == []


@pytest.mark.parametrize("stage", ["run_refs", "missing_file_index", "owner_refs", "artifact_metadata", "artifact_index"])
def test_artifact_cleanup_failure_retries_after_filestore_is_gone(permanent_delete_case, monkeypatch, stage):
    import artifacts.store as artifact_store
    from storage import reference_index
    from storage.file_store import get_file_record

    record, path, _, events, _ = permanent_delete_case
    remove_metadata = artifact_store._remove_artifact_record_permanently

    def fail_cleanup(*args):
        if stage == "artifact_index":
            remove_metadata(*args)
        raise OSError("synthetic cleanup failure")

    with monkeypatch.context() as patch:
        if stage == "owner_refs":
            patch.setattr(reference_index, "remove_reference", lambda *_: False)
        else:
            target = "_remove_artifact_from_run_indexes" if stage in {"run_refs", "missing_file_index"} else "_remove_artifact_record_permanently"
            patch.setattr(artifact_store, target, fail_cleanup)
        assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is False
    assert not path.exists()
    assert get_file_record("test_ws", record.file_id) is None
    assert artifact_store.get_artifact("test_ws", record.artifact_id) == record
    assert events == []
    if stage == "missing_file_index":
        (path.parents[2] / "index/files.jsonl").unlink()
    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert artifact_store.get_artifact("test_ws", record.artifact_id) is None
    assert reference_index.list_references("test_ws") == []
    assert events == [("test_ws", "artifact", "deleted", record.artifact_id)]


@pytest.mark.parametrize("failure", [
    "read_error", "invalid_utf8", "invalid_json", "non_object",
    "invalid_file_id", "missing_path", "invalid_metadata", "invalid_trash_path", "wrong_workspace",
])
def test_filestore_index_failure_preserves_payload_and_artifact_state(permanent_delete_case, monkeypatch, failure):
    import json

    import artifacts.store as artifact_store
    from storage import index
    from storage.reference_index import list_references

    record, path, run_path, events, knowledge_cleanup = permanent_delete_case
    index_path = index._index_path("test_ws")
    index_before = index_path.read_bytes()
    refs_before = list_references("test_ws")
    run_before = run_path.read_bytes()
    read_text = Path.read_text

    def fail_index_read(target, *args, **kwargs):
        if target == index_path:
            raise PermissionError("synthetic index unreadable")
        return read_text(target, *args, **kwargs)

    if failure == "invalid_utf8":
        index_path.write_bytes(b"\xff\n")
    elif failure == "invalid_json":
        index_path.write_text('{"file_id":', encoding="utf-8")
    elif failure == "non_object":
        index_path.write_text('[]\n', encoding="utf-8")
    elif failure != "read_error":
        invalid = json.loads(index_before)
        if failure == "invalid_file_id":
            invalid["file_id"] = []
        elif failure == "missing_path":
            del invalid["path"]
        elif failure == "invalid_metadata":
            invalid["metadata"] = []
        elif failure == "invalid_trash_path":
            invalid["metadata"] = {"trash_path": 123}
        else:
            invalid["workspace_id"] = "other_ws"
        # A valid matching row must not mask corruption later in the index.
        index_path.write_bytes(index_before + (json.dumps(invalid) + "\n").encode())
    failed_index = index_path.read_bytes()
    with monkeypatch.context() as patch:
        if failure == "read_error":
            patch.setattr(Path, "read_text", fail_index_read)
        assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is False
    assert index_path.read_bytes() == failed_index
    assert path.read_text(encoding="utf-8") == "synthetic payload"
    assert artifact_store.get_artifact("test_ws", record.artifact_id) == record
    assert list_references("test_ws") == refs_before
    assert run_path.read_bytes() == run_before
    assert events == []
    assert knowledge_cleanup == []
    index_path.write_bytes(index_before)
    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert not path.exists()
    assert artifact_store.get_artifact("test_ws", record.artifact_id) is None


def test_filestore_permanent_delete_uses_last_matching_record(permanent_delete_case):
    import artifacts.store as artifact_store
    from storage import index
    from storage.file_store import get_file_record

    record, old_path, _, _, _ = permanent_delete_case
    current_path = old_path.with_name("current.txt")
    current_path.write_text("current payload", encoding="utf-8")
    current = get_file_record("test_ws", record.file_id)
    current["path"] = "files/data/current.txt"
    index.append_file_record("test_ws", current)
    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert not current_path.exists()
    assert old_path.read_text(encoding="utf-8") == "synthetic payload"
    assert get_file_record("test_ws", record.file_id) is None


@pytest.mark.parametrize("legacy", [False, True])
def test_hard_delete_preserves_payload_shared_with_another_artifact(permanent_delete_case, legacy):
    import artifacts.store as artifact_store
    from dataclasses import replace
    from storage.file_store import get_file_record

    record, path, _, _, _ = permanent_delete_case
    if legacy:
        record.file_id = ""
        artifact_store._save_artifact_record(record)
    other = replace(record, artifact_id="art_retained")
    artifact_store._save_artifact_record(other, add_to_index=True)
    assert artifact_store.delete_artifact("test_ws", record.artifact_id, hard=True) is True
    assert artifact_store.get_artifact("test_ws", record.artifact_id) is None
    assert artifact_store.get_artifact("test_ws", other.artifact_id) == other
    assert path.read_text(encoding="utf-8") == "synthetic payload"
    assert get_file_record("test_ws", "file_only") is not None


def test_consumed_evidence_cleanup_removes_only_owned_finished_cache(monkeypatch, tmp_path):
    from artifacts.store import save_artifact, cleanup_consumed_tool_evidence, get_artifact
    from storage.atomic_io import atomic_write_json
    from storage.records import workspace_record_file
    from storage.file_store import get_file_record
    from storage.reference_index import add_reference

    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    producer = 'network.operations.topology'
    def cache(run_id, **changes):
        fields = dict(workspace_id='test_ws', content='已消费的图纸中间结果', artifact_type='tool_evidence',
            run_id=run_id, source='runtime_tool_evidence', metadata={'producer_id': producer, 'hidden_from_default_listing': True})
        fields.update(changes)
        record = save_artifact(**fields)
        assert record is not None
        return record
    for run_id, status in [('run_done', 'ok'), ('run_active', 'running'), ('run_unknown', 'unknown')]:
        atomic_write_json(workspace_record_file('test_ws', 'runs', f'{run_id}.json'),
            {'run_id': run_id, 'status': status, 'finished_at': '2026-10-03T00:00:00Z'})
    other_workspace = cache('run_done', workspace_id='other_ws')
    removable = cache('run_done')
    active = cache('run_active')
    unknown = cache('run_unknown')
    missing = cache('run_missing')
    reused = cache('run_done')
    add_reference('test_ws', reused.file_id, 'knowledge', 'source_retained', 'source')
    report = cache('run_done', artifact_type='report')
    upload = cache('run_done', source='upload')
    other_tool = cache('run_done', metadata={'producer_id': 'example.collect', 'hidden_from_default_listing': True})
    explicit = cache('run_done', metadata={'producer_id': producer})
    promoted = cache('run_done')
    from storage.artifact_metadata_store import upsert_artifact_record
    row = promoted.__dict__.copy(); row['lifecycle'] = 'promoted'
    upsert_artifact_record('test_ws', row)
    assert cleanup_consumed_tool_evidence('test_ws', producer, exclude_run_id='run_done') == []
    assert cleanup_consumed_tool_evidence('test_ws', producer) == [removable.artifact_id]
    assert get_artifact('test_ws', removable.artifact_id) is None
    assert get_file_record('test_ws', removable.file_id) is None
    for record in [active, unknown, missing, reused, report, upload, other_tool, explicit, promoted]:
        assert get_artifact('test_ws', record.artifact_id) is not None
        assert get_file_record('test_ws', record.file_id) is not None
    assert cleanup_consumed_tool_evidence('test_ws', producer) == []
    assert get_file_record('other_ws', other_workspace.file_id) is not None
