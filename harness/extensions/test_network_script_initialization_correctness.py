"""Starter script initialization must preserve saved user scripts."""
from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.fixture
def script_ws(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_WORKSPACE_DIR', str(tmp_path))
    return 's2'


def test_script_first_list_preserves_saved_same_name_template(script_ws):
    from extensions.network_operations import network_scripts as scripts
    from extensions.network_operations.network_records import _store
    saved = scripts.save_inspection_script(script_ws, {
        'script_id': 'starter-h3c-health', 'name': 'User saved inspection',
        'vendors': ['h3c'], 'commands': ['display version'], 'checks': [],
    })
    before = _store(script_ws).get('scripts', saved['script_id'])
    listed = scripts.list_inspection_scripts(script_ws)
    assert len(listed) == len(scripts.STARTER_SCRIPTS)
    assert _store(script_ws).get('scripts', saved['script_id']) == before
    assert scripts.get_inspection_script(script_ws, saved['script_id'])['name'] == saved['name']
    assert _store(script_ws).get('scripts', saved['script_id']) == before


def test_script_partial_initialization_retry_preserves_existing_records(script_ws, monkeypatch):
    from extensions.network_operations import network_scripts as scripts
    from extensions.sdk import ExtensionDataStore
    original = ExtensionDataStore.save
    failed_id = scripts.STARTER_SCRIPTS[1]['script_id']
    def interrupted(self, category, identifier, record):
        if identifier == failed_id:
            raise OSError('interrupted initialization')
        return original(self, category, identifier, record)
    with monkeypatch.context() as patch:
        patch.setattr(ExtensionDataStore, 'save', interrupted)
        with pytest.raises(OSError):
            scripts.list_inspection_scripts(script_ws)
    saved = scripts.save_inspection_script(script_ws, {
        'script_id': scripts.STARTER_SCRIPTS[0]['script_id'], 'name': 'Edited after interruption',
        'vendors': ['h3c'], 'commands': ['display version'],
    })
    assert len(scripts.list_inspection_scripts(script_ws)) == len(scripts.STARTER_SCRIPTS)
    assert scripts.get_inspection_script(script_ws, saved['script_id']) == saved
    assert scripts.delete_inspection_script(script_ws, failed_id)
    assert scripts.get_inspection_script(script_ws, failed_id) is None


def test_script_concurrent_initializers_do_not_replace_a_saved_record(script_ws):
    from extensions.network_operations import network_scripts as scripts
    def save():
        return scripts.save_inspection_script(script_ws, {
            'script_id': 'starter-h3c-health', 'name': 'Concurrent user save',
            'vendors': ['h3c'], 'commands': ['display version'],
        })
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(scripts.list_inspection_scripts, script_ws),
                   pool.submit(save), pool.submit(scripts.list_inspection_scripts, script_ws)]
        for future in futures:
            future.result()
    assert scripts.get_inspection_script(script_ws, 'starter-h3c-health')['name'] == 'Concurrent user save'


def test_script_initialization_never_overwrites_an_unreadable_existing_file(script_ws):
    from extensions.network_operations import network_scripts as scripts
    from extensions.network_operations.network_records import _store
    path = _store(script_ws).root() / 'scripts' / 'starter-h3c-health.json'
    path.parent.mkdir(parents=True)
    path.write_text('{interrupted user record', encoding='utf-8')
    before = path.read_bytes()
    with pytest.raises(ValueError, match='unreadable'):
        scripts.list_inspection_scripts(script_ws)
    assert path.read_bytes() == before
    assert _store(script_ws).get('script_meta', 'starter_scripts_initialized') is None
