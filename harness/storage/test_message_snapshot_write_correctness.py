"""S2 persistence failures use temporary workspaces and synthetic content only."""
import json
from pathlib import Path

import pytest


@pytest.fixture
def message_ws(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_WORKSPACE_DIR', str(tmp_path))
    from storage.message_store import SessionMessageStore
    return SessionMessageStore('session_s2', 's2')


def fail(*args, **kwargs):
    raise OSError('injected write failure')


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('failure', ['payload', 'empty_payload', 'metadata', 'empty_metadata', 'metadata_after_write', 'reference', 'message'])
def test_large_message_failure_preserves_body_and_cleans_artifacts(message_ws, monkeypatch, existing, failure):
    from storage import file_store, message_store, artifact_metadata_store, reference_index
    from storage.paths import workspace_root
    store = message_ws
    if existing:
        store.write_message('run1', 'user', 'previous readable body')
    before = {p.name: p.read_bytes() for p in store._messages_dir().glob('*.json')}
    if failure == 'payload':
        monkeypatch.setattr(file_store, 'write_agent_output', fail)
    elif failure == 'empty_payload':
        monkeypatch.setattr(file_store, 'write_agent_output', lambda **kw: None)
    elif failure == 'metadata':
        monkeypatch.setattr(artifact_metadata_store, 'create_artifact_metadata', fail)
    elif failure == 'empty_metadata':
        monkeypatch.setattr(artifact_metadata_store, 'create_artifact_metadata', lambda **kw: {'artifact_id': ''})
    elif failure == 'metadata_after_write':
        original = artifact_metadata_store.create_artifact_metadata
        def after(**kwargs):
            original(**kwargs)
            fail()
        monkeypatch.setattr(artifact_metadata_store, 'create_artifact_metadata', after)
    elif failure == 'reference':
        monkeypatch.setattr(reference_index, 'add_reference', fail)
    else:
        monkeypatch.setattr(message_store, '_atomic_write', fail)
    with pytest.raises(OSError):
        store.write_message('run1', 'user', 'x' * 50001)
    assert {p.name: p.read_bytes() for p in store._messages_dir().glob('*.json')} == before
    assert file_store.list_files('s2', lifecycle='') == []
    assert artifact_metadata_store.list_artifact_records('s2') == []
    assert reference_index.list_references('s2') == []
    assert not list(workspace_root('s2').rglob('*.txt'))
    assert [m['content'] for m in store.get_messages()] == (['previous readable body'] if existing else [])


def test_large_message_success_remains_readable(message_ws):
    content = '长消息正文' * 12000
    assert message_ws.write_message('run1', 'user', content) == 'run1:user'
    assert message_ws.get_messages()[0]['content'] == content
    assert message_ws.get_messages()[0]['artifact_ref']['file_id']


def snapshot_for(store, messages):
    from storage.records import atomic_save_json
    atomic_save_json(store.ws_id, ('sessions', store.session_id, 'snapshots', 'test.json'), {
        'messages': messages, 'message_count': len(messages),
    })


def test_rewind_staging_failure_preserves_history_and_references(message_ws, monkeypatch):
    from storage.message_store import SessionMessageStore
    from storage.session_snapshot import rewind_session
    from storage.reference_index import list_references
    store = message_ws
    store.write_message('current', 'user', 'current history', {'attachments': [{'file_id': 'file_old'}]})
    before = store.get_messages()
    references = list_references(store.ws_id)
    snapshot_for(store, [
        {'run_id': 'old1', 'role': 'user', 'content': 'a' * 50001},
        {'run_id': 'old2', 'role': 'assistant', 'content': 'second'},
    ])
    original = SessionMessageStore._write_message
    def write(self, run_id, *args, **kwargs):
        if run_id == 'old2':
            fail()
        return original(self, run_id, *args, **kwargs)
    monkeypatch.setattr(SessionMessageStore, '_write_message', write)
    assert rewind_session(store.ws_id, store.session_id, 'test', False)['ok'] is False
    assert store.get_messages() == before
    assert list_references(store.ws_id) == references
    from storage.file_store import list_files
    assert list_files(store.ws_id, lifecycle='') == []
    assert not list(store._messages_dir().parent.glob('.rewind-*'))


@pytest.mark.parametrize('failure', ['directory_switch', 'reference_switch'])
def test_rewind_commit_failure_rolls_back(message_ws, monkeypatch, failure):
    import storage.session_snapshot as snapshots
    from storage.reference_index import list_references
    store = message_ws
    store.write_message('current', 'user', 'unchanged', {'attachments': [{'file_id': 'file_old'}]})
    before = store.get_messages()
    refs = list_references(store.ws_id)
    snapshot_for(store, [{'run_id': 'restored', 'role': 'user', 'content': 'target',
                          'metadata': {'attachments': [{'file_id': 'file_new'}]}}])
    if failure == 'directory_switch':
        original = snapshots.os.replace
        def replace(src, dst):
            if Path(src).name.startswith('.rewind-stage-'):
                fail()
            return original(src, dst)
        monkeypatch.setattr(snapshots.os, 'replace', replace)
    else:
        original = snapshots._message_references
        def references(ws, sid, replacement):
            if any(r['file_id'] == 'file_new' for r in replacement):
                fail()
            return original(ws, sid, replacement)
        monkeypatch.setattr(snapshots, '_message_references', references)
    assert snapshots.rewind_session(store.ws_id, store.session_id, 'test', False)['ok'] is False
    assert store.get_messages() == before
    assert list_references(store.ws_id) == refs


@pytest.mark.parametrize('crash_after_install', [False, True])
def test_rewind_interrupted_switch_recovers_on_next_message_read(message_ws, monkeypatch, crash_after_install):
    import storage.session_snapshot as snapshots
    store = message_ws
    store.write_message('current', 'user', 'original')
    snapshot_for(store, [{'run_id': 'target', 'role': 'user', 'content': 'restored'}])
    original = snapshots.os.replace
    def crash(src, dst):
        result = original(src, dst)
        name = Path(src).name if crash_after_install else Path(dst).name
        if name.startswith('.rewind-stage-' if crash_after_install else '.rewind-backup-'):
            raise SystemExit('simulated process interruption')
        return result
    with monkeypatch.context() as patch:
        patch.setattr(snapshots.os, 'replace', crash)
        with pytest.raises(SystemExit):
            snapshots.rewind_session(store.ws_id, store.session_id, 'test', False)
    assert [m['content'] for m in store.get_messages()] == ['original']
    assert not list(store._messages_dir().parent.glob('.rewind-*'))


@pytest.mark.parametrize('messages', [
    [{'run_id': 'bad', 'role': 'user', 'content': ''}],
    [{'run_id': 'bad', 'role': 'user', 'content': 'placeholder', 'artifact_unavailable': True}],
    [{'run_id': 'same', 'role': 'user', 'content': 'one'}, {'run_id': 'same', 'role': 'user', 'content': 'two'}],
])
def test_rewind_rejects_unrestorable_snapshot(message_ws, messages):
    from storage.session_snapshot import rewind_session
    store = message_ws
    store.write_message('current', 'user', 'original')
    snapshot_for(store, messages)
    assert rewind_session(store.ws_id, store.session_id, 'test', False)['ok'] is False
    assert [m['content'] for m in store.get_messages()] == ['original']


@pytest.mark.parametrize('empty', [False, True])
def test_rewind_publishes_complete_history_and_allows_later_writes(message_ws, empty):
    from storage.session_snapshot import rewind_session
    from storage.reference_index import list_references
    store = message_ws
    store.write_message('current', 'user', 'removed', {'attachments': [{'file_id': 'file_old'}]})
    messages = [] if empty else [
        {'run_id': 'old', 'role': 'user', 'content': 'restored', 'created_at': '2026-01-01',
         'metadata': {'attachments': [{'file_id': 'file_new'}]}},
        {'run_id': 'old', 'role': 'assistant', 'content': 'b' * 50001, 'created_at': '2026-01-02'},
    ]
    snapshot_for(store, messages)
    assert rewind_session(store.ws_id, store.session_id, 'test')['dry_run'] is True
    assert store.get_messages()[0]['content'] == 'removed'
    assert rewind_session(store.ws_id, store.session_id, 'test', False) == {
        'ok': True, 'message_count': len(messages), 'dry_run': False}
    assert [m['content'] for m in store.get_messages()] == [m['content'] for m in messages]
    if not empty:
        assert store.get_messages()[0]['created_at'] == '2026-01-01'
    assert all(r['file_id'] != 'file_old' for r in list_references(store.ws_id))
    store.write_message('later', 'user', 'next turn', {'created_at': '2026-01-03'})
    assert store.get_message_count() == len(messages) + 1
    assert not list(store._messages_dir().parent.glob('.rewind-*'))


def test_rewind_serializes_concurrent_message_writer(message_ws, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from storage.message_store import SessionMessageStore
    from storage.session_snapshot import rewind_session
    store = message_ws
    store.write_message('original', 'user', 'before rewind')
    snapshot_for(store, [{'run_id': 'target', 'role': 'user', 'content': 'restored'}])
    staging = threading.Event()
    resume = threading.Event()
    writer_started = threading.Event()
    original = SessionMessageStore._write_message
    def stage(self, *args, **kwargs):
        if getattr(self, '_defer_references', False):
            staging.set()
            assert resume.wait(timeout=5)
        return original(self, *args, **kwargs)
    def writer():
        writer_started.set()
        return store.write_message('concurrent', 'user', 'arrived during rewind')
    monkeypatch.setattr(SessionMessageStore, '_write_message', stage)
    with ThreadPoolExecutor(max_workers=2) as pool:
        rewind = pool.submit(rewind_session, store.ws_id, store.session_id, 'test', False)
        assert staging.wait(timeout=5)
        write = pool.submit(writer)
        assert writer_started.wait(timeout=5)
        resume.set()
        assert rewind.result(timeout=5)['ok'] is True
        assert write.result(timeout=5) == 'concurrent:user'
    assert {m['content'] for m in store.get_messages()} == {'restored', 'arrived during rewind'}


def test_large_message_unknown_file_commit_is_cleaned_by_exact_identity(message_ws, monkeypatch):
    from storage import index, file_store
    from storage.paths import workspace_root
    monkeypatch.setattr(index, 'append_file_record', fail)
    with pytest.raises(file_store.FileCommitUnknown):
        message_ws.write_message('run1', 'user', 'x' * 50001)
    assert message_ws.get_messages() == []
    assert file_store.list_files(message_ws.ws_id, lifecycle='') == []
    assert not list((workspace_root(message_ws.ws_id) / 'sys/file-commits').glob('*.json'))
    assert not list((workspace_root(message_ws.ws_id) / 'files').rglob('*.txt'))
