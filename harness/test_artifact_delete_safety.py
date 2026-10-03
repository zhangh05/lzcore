"""Safety contract for the LLM-visible artifact deletion action."""

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


def test_hard_delete_detaches_refs_before_payload_bytes(monkeypatch):
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
    assert order == ["refs", "metadata", "payload"]


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
