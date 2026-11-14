"""P1DESK regressions: isolated files and credential/registry substitutes only."""
import json
import os
import subprocess
import sys
import threading
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from deployment import slots
from desktop_app.backup import create_backup, read_backup
from desktop_app.updates import cleanup_verified_updates
from scripts import backup_cli, production_preflight
from storage.locking import FileLock


def test_autostart_binds_executable_and_data_root(monkeypatch):
    from desktop_app import window
    registry = {}
    fake = SimpleNamespace(HKEY_CURRENT_USER=1, REG_SZ=1,
        CreateKey=lambda *a: nullcontext(1), OpenKey=lambda *a: nullcontext(1),
        SetValueEx=lambda k, n, r, t, v: registry.update({n: v}),
        QueryValueEx=lambda *a: (registry['LZCore'], 1),
        DeleteValue=lambda *a: registry.pop('LZCore', None))
    monkeypatch.setitem(sys.modules, 'winreg', fake)
    monkeypatch.setattr(window, 'sys', SimpleNamespace(platform='win32'))
    paths = SimpleNamespace(mode='installed', app=Path('C:/Program Files/联智中枢'), data=Path('D:/用户 数据/'))
    window.set_autostart(paths, True)
    assert registry['LZCore'] == subprocess.list2cmdline([str(paths.app / 'lzcore.exe'), '--background', '--data-dir', str(paths.data)])
    assert window.autostart_enabled(paths)
    paths.data = Path('D:/other')
    assert not window.autostart_enabled(paths)
    window.set_autostart(paths, False)
    assert registry == {}


@pytest.mark.parametrize('suffix,content', [('json', '{"api_key":"example-test-key"}'), ('yaml', 'api_key: example-test-key')])
def test_encrypted_backup_refuses_plaintext_credential_loss(tmp_path, suffix, content):
    data = tmp_path / 'data'; (data / 'config').mkdir(parents=True)
    (data / 'config' / ('provider.' + suffix)).write_text(content)
    target = tmp_path / 'backup'; target.write_bytes(b'existing-backup')
    with pytest.raises(ValueError, match='明文凭据'):
        create_backup(data, target, password='test-backup-passphrase', include_credentials=True)
    assert target.read_bytes() == b'existing-backup'
    create_backup(data, target)
    archive, manifest = read_backup(target)
    with archive:
        assert b'example-test-key' not in archive.read(next(iter(manifest['files'])))


def _stage(tmp_path, version):
    source = tmp_path / 'sources' / version
    (source / 'agent').mkdir(parents=True)
    (source / 'frontend/dist').mkdir(parents=True)
    (source / 'agent/__init__.py').write_text(f'__version__ = "{version}"')
    (source / 'frontend/dist/index.html').write_text('built-ui')
    return source


def test_release_retry_preserves_rollback_and_health_failure_freezes_old_target(tmp_path, monkeypatch):
    root = tmp_path / 'releases'
    for version in ('1.0.0', '1.0.1', '1.0.2'):
        slots.stage_release(_stage(tmp_path, version), version, root=root)
    slots.activate_release('1.0.0', root=root)
    slots.activate_release('1.0.1', root=root)
    slots.activate_release('1.0.1', root=root)
    assert (root / 'previous').resolve().name == '1.0.0'
    def fail(*a):
        raise slots.ReleaseError('not ready')
    monkeypatch.setattr(slots, 'verify_health', fail)
    with pytest.raises(slots.ReleaseError):
        slots.activate_release('1.0.2', root=root, health_url='http://unused')
    assert (root / 'current').resolve().name == '1.0.1'
    assert (root / 'previous').resolve().name == '1.0.0'
    assert slots.rollback_release(root=root)['version'] == '1.0.0'


def test_release_interrupted_switch_recovers_before_retry(tmp_path, monkeypatch):
    root = tmp_path / 'releases'
    for version in ('1.0.0', '1.0.1'):
        slots.stage_release(_stage(tmp_path, version), version, root=root)
    slots.activate_release('1.0.0', root=root)
    original = slots._replace_link
    def interrupt(link, target):
        if link.name == 'current':
            raise KeyboardInterrupt()
        original(link, target)
    with monkeypatch.context() as patch:
        patch.setattr(slots, '_replace_link', interrupt)
        with pytest.raises(KeyboardInterrupt):
            slots.activate_release('1.0.1', root=root)
    assert (root / 'switch.json').exists()
    slots.activate_release('1.0.1', root=root)
    assert slots.rollback_release(root=root)['version'] == '1.0.0'
    assert not (root / 'switch.json').exists()


def test_release_does_not_traverse_runtime_config(tmp_path, monkeypatch):
    source = _stage(tmp_path, '1.0.0')
    (source / 'config').mkdir()
    (source / 'config/credentials.yaml').write_text('password: example-only')
    original = os.scandir
    def guarded(path):
        assert isinstance(path, int) or Path(path) != source / 'config', 'runtime config must not be traversed'
        return original(path)
    monkeypatch.setattr(os, 'scandir', guarded)
    result = slots.stage_release(source, '1.0.0', root=tmp_path / 'slots')
    assert not (Path(result['path']) / 'config').exists()
    assert 'providers' in slots._ignore(str(source / 'config'), ['providers'])
    assert (Path(result['path']) / 'frontend/dist/index.html').read_text() == 'built-ui'


@pytest.mark.parametrize('key', ['', 'short', 'example-master-key-long-enough'])
def test_preflight_validates_real_cipher_contract_without_os_store(monkeypatch, key):
    monkeypatch.setenv('LZCORE_MASTER_KEY', key)
    monkeypatch.delenv('LZCORE_MASTER_KEY_FILE', raising=False)
    monkeypatch.setenv('LZCORE_OS_SECRET_STORE', 'off')
    assert bool(production_preflight.check_secret_backend()) is (len(key) < 16)


def test_preflight_unreadable_master_file(monkeypatch, tmp_path):
    monkeypatch.delenv('LZCORE_MASTER_KEY', raising=False)
    monkeypatch.setenv('LZCORE_MASTER_KEY_FILE', str(tmp_path / 'absent'))
    monkeypatch.setenv('LZCORE_OS_SECRET_STORE', 'off')
    assert production_preflight.check_secret_backend()


@pytest.mark.parametrize('working,cleanup', [(True, True), (False, True), (True, False)])
def test_preflight_probes_and_cleans_only_new_entry(monkeypatch, working, cleanup):
    from storage import os_secret_store as store
    monkeypatch.delenv('LZCORE_MASTER_KEY', raising=False)
    monkeypatch.delenv('LZCORE_MASTER_KEY_FILE', raising=False)
    values = {}; deleted = []
    monkeypatch.setattr(store, 'backend_name', lambda: 'keychain')
    monkeypatch.setattr(store, 'set_os_secret', lambda k, v: values.update({k: v}) or True)
    monkeypatch.setattr(store, 'get_os_secret', lambda k: values[k] if working else 'mismatch')
    monkeypatch.setattr(store, 'delete_os_secret', lambda k: deleted.append(k) or cleanup)
    errors = production_preflight.check_secret_backend()
    assert bool(errors) is not (working and cleanup)
    assert deleted == list(values)
    assert all(k.startswith('preflight-') for k in deleted)
    assert all(v not in str(errors) for v in values.values())


def test_cli_restore_refuses_active_desktop_and_holds_lock_for_restore(tmp_path, monkeypatch):
    from storage import backend
    from jobs import queue
    from core.runtime.backup import BackupError
    data = tmp_path / 'data'; data.mkdir()
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(data / 'workspaces'))
    monkeypatch.setenv('LZCORE_DESKTOP_DATA_DIR', str(data))
    monkeypatch.delenv('LZCORE_EVENT_BUS_MODE', raising=False)
    monkeypatch.setattr(backend, 'backend_mode', lambda: 'filesystem')
    monkeypatch.setattr(queue, 'queue_mode', lambda: 'filesystem')
    lock = data / '.runtime/desktop-instance.lock'
    entered = threading.Event(); release = threading.Event()
    def hold():
        with FileLock(lock):
            entered.set(); release.wait(5)
    thread = threading.Thread(target=hold); thread.start()
    assert entered.wait(3)
    calls = []
    monkeypatch.setattr(backup_cli, 'restore_backup', lambda *a, **k: calls.append(1))
    try:
        with pytest.raises(BackupError, match='in use'):
            backup_cli.restore_offline(tmp_path / 'archive', confirmation='RESTORE')
        assert not calls
    finally:
        release.set(); thread.join(3)
    backup_cli.restore_offline(tmp_path / 'archive', confirmation='RESTORE')
    assert calls == [1]
    monkeypatch.setattr(queue, 'queue_mode', lambda: 'redis')
    with pytest.raises(BackupError, match='multi-process'):
        backup_cli.restore_offline(tmp_path / 'archive', confirmation='RESTORE')


def _completed_update(runtime, name, version, *, verified=False, phase='completed'):
    folder = runtime / 'updates' / name; folder.mkdir(parents=True)
    backup = runtime / 'program-backups' / name; backup.mkdir(parents=True)
    (backup / 'old-program').write_text('rollback-copy')
    (folder / 'package.zip').write_bytes(b'package')
    (folder / 'unpacked').mkdir()
    (folder / 'result.json').write_text(json.dumps({'ok': True, 'version': version, 'startup_verified': verified}))
    (folder / 'transaction.json').write_text(json.dumps({'phase': phase, 'backup': str(backup)}))
    return folder, backup


def test_cleanup_requires_target_start_and_keeps_one_backup(tmp_path):
    old, old_backup = _completed_update(tmp_path, 'a' * 32, '1.0.0', verified=True)
    current, current_backup = _completed_update(tmp_path, 'b' * 32, '1.0.1')
    pending, pending_backup = _completed_update(tmp_path, 'c' * 32, '1.0.2', phase='prepared')
    unknown, unknown_backup = _completed_update(tmp_path, 'd' * 32, '1.0.3')
    cleanup_verified_updates(tmp_path, '1.0.1')
    assert not old.exists() and not old_backup.exists()
    assert current_backup.exists() and not (current / 'package.zip').exists()
    assert not (current / 'unpacked').exists()
    assert (pending / 'package.zip').exists() and pending_backup.exists()
    assert (unknown / 'package.zip').exists() and unknown_backup.exists()
    cleanup_verified_updates(tmp_path, '1.0.1')
    assert current_backup.exists()


def test_cleanup_failed_deletion_retries_without_touching_user_data(tmp_path, monkeypatch):
    from desktop_app import updates
    folder, backup = _completed_update(tmp_path, 'a' * 32, '1.0.0')
    user = tmp_path / 'user'; user.mkdir(); (user / 'record').write_text('keep')
    original = updates.shutil.rmtree
    def fail(path, *a, **kw):
        if Path(path).name == 'unpacked':
            raise OSError('locked')
        return original(path, *a, **kw)
    with monkeypatch.context() as patch:
        patch.setattr(updates.shutil, 'rmtree', fail)
        cleanup_verified_updates(tmp_path, '1.0.0')
    cleanup_verified_updates(tmp_path, '1.0.0')
    assert not (folder / 'unpacked').exists()
    assert backup.exists() and (user / 'record').read_text() == 'keep'


def test_cleanup_ignores_malformed_records_and_outside_snapshot(tmp_path):
    folder, backup = _completed_update(tmp_path, 'a' * 32, '1.0.0')
    (folder / 'transaction.json').write_text('[]')
    cleanup_verified_updates(tmp_path, '1.0.0')
    assert (folder / 'package.zip').exists()
    (folder / 'transaction.json').write_text(json.dumps({'phase': 'completed', 'backup': str(tmp_path / 'outside')}))
    cleanup_verified_updates(tmp_path, '1.0.0')
    assert (folder / 'package.zip').exists() and backup.exists()


def test_cli_restore_excludes_new_desktop_for_entire_real_restore(tmp_path, monkeypatch):
    from core.runtime.backup import create_backup as make_archive
    from storage import backend
    from jobs import queue
    data = tmp_path / 'data'; workspace = data / 'workspaces'; workspace.mkdir(parents=True)
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(workspace))
    monkeypatch.setenv('LZCORE_DESKTOP_DATA_DIR', str(data))
    monkeypatch.setenv('LZCORE_BACKUP_DIR', str(tmp_path / 'archives'))
    monkeypatch.setenv('LZCORE_EVENT_BUS_MODE', 'memory')
    monkeypatch.setattr(backend, 'backend_mode', lambda: 'filesystem')
    monkeypatch.setattr(queue, 'queue_mode', lambda: 'filesystem')
    record = workspace / 'record.txt'; record.write_text('before')
    archive = make_archive(); record.write_text('after')
    original = backup_cli.restore_backup
    refused = []
    def restore(*args, **kwargs):
        def try_desktop():
            try:
                with FileLock(data / '.runtime/desktop-instance.lock', timeout=0):
                    refused.append(False)
            except TimeoutError:
                refused.append(True)
        thread = threading.Thread(target=try_desktop); thread.start(); thread.join(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(backup_cli, 'restore_backup', restore)
    assert backup_cli.restore_offline(Path(archive['path']), confirmation='RESTORE')['ok']
    assert refused == [True]
    assert record.read_text() == 'before'


def test_preflight_configuration_includes_credential_backend_failure(monkeypatch):
    from backend.core import auth
    from storage import backend, object_store
    from jobs import queue
    from core.tools.python_runner import DockerStrongIsolationRunner
    monkeypatch.setattr(backend, 'validate_backend_configuration', lambda: [])
    monkeypatch.setattr(backend, 'backend_mode', lambda: 'postgres')
    monkeypatch.setattr(object_store, 'object_store_mode', lambda: 's3')
    monkeypatch.setattr(queue, 'queue_mode', lambda: 'redis')
    monkeypatch.setattr(auth, '_secret_value', lambda key: 'test-value-' * 4)
    monkeypatch.setattr(auth, '_get_login_password', lambda: 'test-value-' * 4)
    monkeypatch.setattr(auth, '_get_api_token', lambda: 'test-value-' * 4)
    monkeypatch.setattr(DockerStrongIsolationRunner, 'available', lambda: object())
    monkeypatch.setenv('LZCORE_EVENT_BUS_MODE', 'redis')
    monkeypatch.setenv('LZCORE_EVENT_BUS_URL', 'redis://test.invalid')
    monkeypatch.setenv('LZCORE_IDENTITY_ENABLED', 'true')
    monkeypatch.setenv('LZCORE_SESSION_SECURE', 'true')
    monkeypatch.setenv('LZCORE_PYTHON_CONTAINER_IMAGE', 'test@sha256:' + 'a' * 64)
    monkeypatch.setenv('LZCORE_REQUIRE_OIDC', 'false')
    monkeypatch.setenv('LZCORE_OIDC_ENABLED', 'false')
    monkeypatch.setattr(production_preflight, 'check_secret_backend', lambda: ['credential backend unavailable'])
    assert production_preflight.check_configuration() == ['credential backend unavailable']


def test_update_cleanup_waits_for_trusted_page_load(monkeypatch, tmp_path):
    from desktop_app.controller import DesktopController
    calls = []
    monkeypatch.setattr('desktop_app.controller.cleanup_verified_updates', lambda *args: calls.append(args))
    controller = DesktopController(SimpleNamespace(runtime=tmp_path), '1.0.0', None, 'http://127.0.0.1:8011')
    assert calls == []
    controller.window = SimpleNamespace(evaluate_js=lambda _: 'https://untrusted.invalid')
    controller.on_loaded()
    assert calls == []
    controller.window = SimpleNamespace(evaluate_js=lambda _: controller.origin)
    controller.on_loaded()
    assert calls == [(tmp_path, '1.0.0')]
