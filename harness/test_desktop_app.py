from pathlib import Path
import json
import threading
import zipfile
import hashlib
import pytest
from agent.runtime.local_lifecycle import LocalLifecycle, install_local_lifecycle
from desktop_app.environment import resolve_paths, prepare_paths, migrate_legacy, copy_verified
from desktop_app.window import fit_window, DesktopState
from desktop_app.backup import create_backup, stage_restore, queue_restore, apply_pending_restore, read_backup


def test_distribution_data_paths(tmp_path):
    app = tmp_path / '中文 程序'; app.mkdir()
    bundle = app / '_internal'; bundle.mkdir()
    installed = resolve_paths(app, bundle, frozen=True, environ={'LOCALAPPDATA': str(tmp_path / 'user')})
    assert installed.mode == 'installed' and installed.data == tmp_path / 'user' / 'LZCore'
    (app / 'portable.json').write_text('{}')
    portable = resolve_paths(app, bundle, frozen=True, environ={})
    assert portable.mode == 'portable' and portable.data == app / 'data'
    with pytest.raises(ValueError): resolve_paths(app, bundle, frozen=True, data_dir=app)


def test_legacy_migration_retains_source_and_is_repeatable(tmp_path):
    app = tmp_path / 'app'; app.mkdir()
    (app / 'workspaces').mkdir(); (app / 'config').mkdir()
    (app / 'workspaces' / 'record.json').write_text('业务数据', encoding='utf-8')
    paths = resolve_paths(app, app, environ={})
    paths.runtime.mkdir(parents=True)
    result = migrate_legacy(paths)
    assert result['complete'] and result['migrated']
    assert (paths.workspaces / 'record.json').read_text(encoding='utf-8') == '业务数据'
    assert (app / 'workspaces' / 'record.json').is_file()
    assert migrate_legacy(paths) == result


def test_backup_restore_roundtrip_retains_old_data_and_scrubs_keys(tmp_path):
    data = tmp_path / 'data'; (data / 'workspaces').mkdir(parents=True); (data / 'config').mkdir()
    (data / 'workspaces' / 'history.json').write_text('记录', encoding='utf-8')
    (data / 'config' / 'provider.json').write_text(json.dumps({'api_key': 'never-export-raw', 'model': 'test'}))
    target = tmp_path / 'backup.zip'; create_backup(data, target)
    assert b'never-export-raw' not in zipfile.ZipFile(target).read('config/provider.json')
    staged = stage_restore(data, target)
    (data / 'workspaces' / 'history.json').write_text('新记录', encoding='utf-8')
    queue_restore(data, staged['restore_id']); result = apply_pending_restore(data)
    assert (data / 'workspaces' / 'history.json').read_text(encoding='utf-8') == '记录'
    assert (Path(result['recovery_dir']) / 'workspaces' / 'history.json').read_text(encoding='utf-8') == '新记录'
    assert apply_pending_restore(data) is None


def test_encrypted_backup_rejects_wrong_password_and_plain_credentials(tmp_path):
    data = tmp_path / 'data'; (data / 'workspaces').mkdir(parents=True)
    (data / 'workspaces' / 'data.json').write_text('sensitive-business-text')
    target = tmp_path / 'encrypted.lzbackup'; create_backup(data, target, password='long-enough-password')
    assert b'sensitive-business-text' not in target.read_bytes()
    with pytest.raises(ValueError, match='口令'): read_backup(target, 'wrong')
    archive, manifest = read_backup(target, 'long-enough-password'); archive.close()
    assert manifest['schema'] == 1
    with pytest.raises(ValueError, match='凭据'): create_backup(data, target, include_credentials=True)


@pytest.mark.parametrize('name', ['workspaces/../outside', 'workspaces/CON.json', 'workspaces/a:stream', 'workspaces/a./x', 'workspaces//a'])
def test_restore_rejects_unsafe_paths(tmp_path, name):
    target = tmp_path / 'bad.zip'; raw = b'x'
    with zipfile.ZipFile(target, 'w') as z:
        z.writestr(name, raw)
        z.writestr('manifest.json', json.dumps({'format':'lzcore-backup','schema':1,'files':{name:{'size':1,'sha256':hashlib.sha256(raw).hexdigest()}}}))
    with pytest.raises(ValueError): read_backup(target)
    assert not (tmp_path / 'outside').exists()


def test_admission_pause_does_not_cancel_and_cannot_race_reservations():
    gate = LocalLifecycle(); assert gate.reserve()
    assert not gate.pause() and gate.accepting
    assert gate.pause(require_idle=False) and gate.active == 1
    assert not gate.reserve()
    gate.release(); gate.resume(); assert gate.reserve(); gate.release()


@pytest.mark.parametrize('scale', [1, 1.25, 1.5, 2])
def test_window_restoration_clamps_missing_monitor_and_invalid_geometry(scale):
    x,y,w,h = fit_window({'width':9000,'height':float('nan'),'left':-10000,'top':10000}, (-1920,0,0,1040), scale)
    assert -1920 <= x < 0 and y >= 0 and x+w <= 0 and y+h <= 1040
    assert w >= min(500*scale,1920)


def test_paused_worker_does_not_claim_jobs(monkeypatch):
    from jobs import worker
    gate = LocalLifecycle(); gate.pause(); install_local_lifecycle(gate)
    monkeypatch.setattr(worker, '_run_once', lambda: pytest.fail('worker must not claim'))
    try: assert worker.run_once()['status'] == 'paused'
    finally: install_local_lifecycle(None)


def test_desktop_origin_guard_blocks_native_methods(tmp_path):
    from types import SimpleNamespace
    from desktop_app.controller import DesktopApi
    c = SimpleNamespace(window=SimpleNamespace(evaluate_js=lambda code:'https://untrusted.example'), origin='http://127.0.0.1:8011')
    assert DesktopApi(c).open_folder()['error'] == 'native_origin_denied'


def test_tray_data_action_requires_current_session_authorization():
    from types import SimpleNamespace
    from desktop_app.tray import NativeTray
    events = []
    tray = NativeTray.__new__(NativeTray)
    tray.controller = SimpleNamespace(
        window=SimpleNamespace(evaluate_js=lambda code: 'http://127.0.0.1:8011'),
        origin='http://127.0.0.1:8011', admin_allowed=lambda: False,
        open_directory=lambda path: pytest.fail('tray must not bypass authorization'),
        show=lambda: None, emit=lambda action, **detail: events.append(action))
    tray.open_data()
    assert events == ['settings']


def test_versioned_annotations_do_not_change_topology_geometry(monkeypatch, tmp_path):
    from extensions.network_operations import topology_service as drawings, annotations
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    from storage.workspace_store import ensure_workspace
    ensure_workspace('default')
    topo = drawings.save_topology('default', {'name':'测试','nodes':[],'links':[]})
    value = annotations.save_annotations('default', topo['topology_id'], {'version':0,'strokes':[],'notes':[{'id':'a','x':10,'y':20,'text':'笔记','color':'#ef4444'}]})
    assert value['version'] == 1
    assert annotations.get_annotations('default', topo['topology_id'])['notes'][0]['text'] == '笔记'
    assert drawings.get_topology('default', topo['topology_id'])['version'] == topo['version']
    with pytest.raises(ValueError, match='version_conflict'): annotations.save_annotations('default', topo['topology_id'], {'version':0})
    with pytest.raises(ValueError): annotations.save_annotations('default', topo['topology_id'], {'version':1,'notes':[{'id':'a','x':float('nan'),'y':0,'text':'','color':'#ef4444'}]})
    drawings.delete_topology('default', topo['topology_id'])
    assert drawings._store('default').get('annotations', topo['topology_id']) is None


def test_http_barrier_rejects_new_work_and_reopens(monkeypatch):
    from backend.main import create_app
    gate = LocalLifecycle(); install_local_lifecycle(gate)
    try:
        app = create_app()
        gate.pause(require_idle=False)
        client = app.test_client()
        response = client.post('/api/auth/login', json={})
        assert response.status_code == 503 and response.json['error'] == 'desktop_paused'
        assert client.get('/api/health').status_code == 200
        gate.resume()
        assert client.get('/api/auth/status').status_code != 503
    finally: install_local_lifecycle(None)


def test_encrypted_backup_transfers_all_principal_secret_paths(monkeypatch, tmp_path):
    from storage import os_secret_store
    monkeypatch.setattr(os_secret_store, '_dpapi_unprotect', lambda blob: blob.removeprefix(b'encrypted:'))
    monkeypatch.setattr(os_secret_store, '_dpapi_protect', lambda blob: b'new-user-encrypted:'+blob)
    data=tmp_path/'data'
    secret=data/'workspaces/users/usr_test/_runtime/secrets/dpapi/account.bin'
    secret.parent.mkdir(parents=True); secret.write_bytes(b'encrypted:private-value')
    target=tmp_path/'encrypted.lzbackup'
    create_backup(data,target,password='a-password-long-enough',include_credentials=True)
    assert b'private-value' not in target.read_bytes()
    result=stage_restore(data,target,password='a-password-long-enough')
    staged=data/'.runtime/restore'/result['restore_id']/'payload/workspaces/users/usr_test/_runtime/secrets/dpapi/account.bin'
    assert staged.read_bytes()==b'new-user-encrypted:private-value'
    assert not (staged.parent/'credentials.json').exists()


def test_return_abandons_previous_shutdown_attempt(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from desktop_app import controller
    from desktop_app.environment import DesktopPaths
    paths=DesktopPaths(tmp_path,tmp_path,tmp_path,'development')
    c=controller.DesktopController(paths,'3.3.0',LocalLifecycle(),'http://localhost')
    destroyed=[]
    c.window=SimpleNamespace(evaluate_js=lambda _:c.origin,destroy=lambda:destroyed.append(True))
    c._shutdown_attempt=1; c.gate.reserve(); c.gate.pause(require_idle=False)
    monkeypatch.setattr(controller,'active_jobs',lambda:[])
    thread=threading.Thread(target=c._stop_jobs,args=(1,)); thread.start()
    assert controller.DesktopApi(c).request_exit('return')['ok']
    thread.join(timeout=2)
    assert not thread.is_alive() and not destroyed and c.gate.accepting
    c.gate.release()


def test_native_data_access_cannot_trust_reported_username(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from desktop_app.controller import DesktopController, DesktopApi
    from desktop_app.environment import DesktopPaths
    from backend.core import auth
    monkeypatch.setattr(auth, '_is_identity_enabled', lambda:True)
    from http.cookies import SimpleCookie
    c=DesktopController(DesktopPaths(tmp_path,tmp_path,tmp_path,'development'),'3.3.0',LocalLifecycle(),'http://localhost')
    c.window=SimpleNamespace(evaluate_js=lambda _:c.origin,get_cookies=lambda:[SimpleCookie('session=forged')])
    c.principal='admin'
    assert not c.admin_allowed()
    assert not DesktopApi(c).open_folder()['ok']


def test_migration_refuses_a_source_owned_by_another_thread(tmp_path):
    from desktop_app.environment import migration_source
    from storage.locking import FileLock
    source=tmp_path/'source'; lock=source/'.runtime/desktop-instance.lock'
    started=threading.Event(); finish=threading.Event()
    def owner():
        with FileLock(lock): started.set(); finish.wait(5)
    thread=threading.Thread(target=owner);thread.start();started.wait(2)
    try:
        with pytest.raises(ValueError,match='仍在使用'):
            with migration_source(source): pytest.fail('must not copy live source')
    finally: finish.set(); thread.join(2)


def test_download_storage_failure_leaves_retryable_error(tmp_path):
    from types import SimpleNamespace
    from desktop_app.updates import DesktopUpdater
    runtime=tmp_path/'runtime';runtime.write_text('not a directory')
    updater=DesktopUpdater(SimpleNamespace(runtime=runtime),'3.3.0',DesktopState(tmp_path/'prefs.json'))
    updater._download({'name':'pkg.zip'})
    assert updater.snapshot()['status']=='error' and updater.package is None


def test_signature_check_keeps_filename_out_of_command_text(monkeypatch):
    from types import SimpleNamespace
    from desktop_app import updates
    calls=[]
    monkeypatch.setattr(updates.subprocess,'run',lambda args,**kwargs:calls.append((args,kwargs)) or SimpleNamespace(returncode=0))
    path=Path("D:/中文 $(unexpected)/package.exe")
    updates.verify_authenticode(path)
    assert str(path) not in calls[0][0]
    assert calls[0][1]['env']['LZCORE_VERIFY_SIGNATURE_PATH']==str(path)
