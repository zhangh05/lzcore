"""File workflows exercise actual payloads, owner persistence and recovery."""
import io
import pytest


@pytest.fixture
def files_ws(tmp_path, monkeypatch):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_WORKSPACE_DIR', str(tmp_path))
    return 'file_contract'


@pytest.mark.parametrize('name,kind,binary', [
    ('数据.csv', 'csv', False), ('report.xlsx', 'xlsx', True),
    ('图.svg', 'svg', True), ('music.mp3', 'mp3', True),
    ('bundle.zip', 'zip', True), ('unknown.custom', 'binary', True),
])
def test_upload_and_tool_import_share_classification(files_ws, name, kind, binary):
    from storage.file_store import import_user_upload, resolve_file_path
    from backend.api.artifact_routes import _guess_upload_kind
    payload = b'opaque\x00bytes'
    record = import_user_upload(files_ws, io.BytesIO(payload), name)
    assert (record.file_kind, record.binary) == (kind, binary) == _guess_upload_kind(name)
    assert resolve_file_path(files_ws, record.file_id).read_bytes() == payload


def test_message_attachment_replacement_and_session_deletion(files_ws):
    from storage.file_store import import_user_upload
    from storage.message_store import SessionMessageStore
    from storage.reference_index import list_references_for_file
    from storage.session_store import delete_session_permanently
    a = import_user_upload(files_ws, io.BytesIO(b'a'), 'a.txt')
    b = import_user_upload(files_ws, io.BytesIO(b'b'), 'b.txt')
    first = SessionMessageStore('session_first', files_ws)
    other = SessionMessageStore('session_other', files_ws)
    for store in (first, first, other):
        store.write_message('run_a', 'user', 'use file', metadata={'attachments': [{'file_id': a.file_id}]})
    assert len(list_references_for_file(files_ws, a.file_id)) == 2
    first.write_message('run_a', 'user', 'replace file', metadata={'attachments': [{'file_id': b.file_id}]})
    assert len(list_references_for_file(files_ws, a.file_id)) == 1
    assert len(list_references_for_file(files_ws, b.file_id)) == 1
    assert delete_session_permanently('session_first', files_ws, confirm=True)
    assert not list_references_for_file(files_ws, b.file_id)
    assert len(list_references_for_file(files_ws, a.file_id)) == 1


def test_reference_repeated_save_is_idempotent(files_ws):
    from storage.reference_index import add_reference, list_references_for_file
    first = add_reference(files_ws, 'file_example', 'artifact', 'art_example', 'content')
    second = add_reference(files_ws, 'file_example', 'artifact', 'art_example', 'content', {'used': True})
    assert first.ref_id == second.ref_id
    assert list_references_for_file(files_ws, 'file_example')[0]['metadata']['used']


def test_mutation_keeps_referenced_bytes_and_publishes_working_version(files_ws):
    from storage.file_store import import_user_upload, resolve_file_path, get_file_record
    from storage.reference_index import add_reference
    from storage.file_mutations import managed_file_mutation
    from storage.project_changes import workspace_files_lock
    record = import_user_upload(files_ws, io.BytesIO(b'original'), 'source.txt')
    path = resolve_file_path(files_ws, record.file_id)
    add_reference(files_ws, record.file_id, 'message', 'session/run:user', 'attachment')
    with workspace_files_lock(files_ws), managed_file_mutation(files_ws, paths=[path]) as changes:
        path.write_bytes(b'updated work')
    assert resolve_file_path(files_ws, record.file_id).read_bytes() == b'original'
    assert changes[0]['file_id'] != record.file_id
    current = get_file_record(files_ws, changes[0]['file_id'])
    assert current['size_bytes'] == 12
    assert current['metadata']['previous_file_id'] == record.file_id
    assert resolve_file_path(files_ws, current['file_id']).read_bytes() == b'updated work'


def test_noop_mutation_does_not_create_another_file(files_ws):
    from storage.file_store import import_user_upload, resolve_file_path, list_files
    from storage.reference_index import add_reference
    from storage.file_mutations import managed_file_mutation
    record = import_user_upload(files_ws, io.BytesIO(b'original'), 'source.txt')
    add_reference(files_ws, record.file_id, 'message', 'session/run:user')
    with managed_file_mutation(files_ws, paths=[resolve_file_path(files_ws, record.file_id)]) as changes:
        pass
    assert changes == []
    assert len(list_files(files_ws)) == 1


def test_recycle_restore_and_permanent_clear_preserve_owner_identity(files_ws):
    from storage.file_store import import_user_upload, get_file_record, restore_file, resolve_file_path
    from storage.reference_index import add_reference, list_references_for_file
    from storage.data_management import delete_unreferenced_file
    record = import_user_upload(files_ws, io.BytesIO(b'original'), 'source.txt')
    add_reference(files_ws, record.file_id, 'message', 'session/run:user', 'attachment')
    assert not delete_unreferenced_file(files_ws, record.file_id)['ok']
    recycled = delete_unreferenced_file(files_ws, record.file_id, force=True)
    assert recycled['recoverable'] and recycled['lifecycle'] == 'soft_deleted'
    assert resolve_file_path(files_ws, record.file_id).read_bytes() == b'original'
    assert restore_file(files_ws, record.file_id)['ok']
    assert restore_file(files_ws, record.file_id)['already_active']
    purged = delete_unreferenced_file(files_ws, record.file_id, force=True, permanent=True)
    assert not purged['recoverable']
    assert get_file_record(files_ws, record.file_id)['lifecycle'] == 'purged'
    assert len(list_references_for_file(files_ws, record.file_id)) == 1
    assert not restore_file(files_ws, record.file_id)['ok']


def test_preview_range_can_continue_to_full_content(files_ws):
    from storage.file_store import import_user_upload
    from storage.data_management import text_file_content
    record = import_user_upload(files_ws, io.BytesIO('中文abcdef'.encode()), 'text.txt')
    first = text_file_content(files_ws, record.file_id, max_chars=3)
    assert first['truncated'] and first['next_offset'] == 3
    second = text_file_content(files_ws, record.file_id, max_chars=10, offset=first['next_offset'])
    assert first['content'] + second['content'] == '中文abcdef'
    assert not second['truncated']
