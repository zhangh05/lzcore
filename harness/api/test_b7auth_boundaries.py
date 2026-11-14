"""B7AUTH: synthetic identities, tenant control plane and streaming revocation."""
import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from flask import Flask

from backend.core import auth, identity


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_IDENTITY_ENABLED', 'true')
    monkeypatch.setenv('LZCORE_AUTH_ENABLED', 'true')
    monkeypatch.setenv('LZCORE_LOGIN_ENABLED', 'false')
    monkeypatch.setenv('LZCORE_SESSION_SECRET', 'b7-synthetic-session-secret')
    monkeypatch.setattr(auth, '_get_api_token', lambda: 'b7-synthetic-service-token')
    monkeypatch.setattr(auth, '_get_login_username', lambda: '')
    monkeypatch.setattr(auth, '_get_login_password', lambda: '')
    from storage.workspace_store import ensure_workspace, update_workspace_state
    for org, ws in [('org_a', 'mine'), ('org_b', 'foreign')]:
        ensure_workspace(ws)
        update_workspace_state(ws, {'organization_id': org})
        identity.ensure_organization(org, org, [ws])
    for username, role, org, ws in [
        ('writer', 'operator', 'org_a', 'mine'),
        ('admin_a', 'admin', 'org_a', 'mine'),
        ('owner', 'owner', 'org_a', 'mine'),
        ('victim', 'operator', 'org_b', 'foreign'),
    ]:
        identity.upsert_user(username, 'test-password', role, org, [ws])
    app = Flask(__name__)
    auth.register_auth_middleware(app)
    app.add_url_rule('/api/auth/login', view_func=auth.handle_auth_login, methods=['POST'])
    from backend.api.workspace_routes import register_workspace_routes
    from backend.api.runtime_routes import register_runtime_routes
    from backend.api.storage_routes import register_storage_routes
    register_workspace_routes(app)
    register_runtime_routes(app)
    register_storage_routes(app)
    from storage.principal import current_storage_principal, principal_storage_key
    app.add_url_rule('/api/probe', view_func=lambda: {'storage_id': principal_storage_key(current_storage_principal())})
    return app


def login(app, username):
    client = app.test_client()
    assert client.post('/api/auth/login', json={'username': username, 'password': 'test-password'}).status_code == 200
    return client


@pytest.mark.parametrize('operation', ['delete', 'rename', 'batch'])
def test_ordinary_writer_cannot_destroy_shared_workspace(app, operation):
    from storage.paths import workspace_root
    from storage.principal import storage_principal
    with storage_principal('writer'):
        marker = workspace_root('mine') / 'sessions' / 'protected.json'
        marker.write_text('synthetic')
    client = login(app, 'writer')
    if operation == 'delete':
        response = client.delete('/api/workspaces/mine?confirm=true')
    elif operation == 'rename':
        response = client.post('/api/workspaces/mine/rename', json={'new_workspace_id': 'renamed'})
    else:
        response = client.post('/api/workspaces/batch-delete', json={'workspace_ids': ['mine'], 'confirm': True})
    assert response.status_code == 403
    assert marker.read_text() == 'synthetic'


@pytest.mark.parametrize('targets,status', [(['mine', 'foreign'], 403), (['foreign'], 403), (['mine', '../foreign'], 400)])
def test_batch_preflights_every_target_before_deleting_anything(app, targets, status):
    from storage.paths import workspace_catalog_root
    response = login(app, 'admin_a').post('/api/workspaces/batch-delete', json={'workspace_ids': targets, 'confirm': True})
    assert response.status_code == status
    assert workspace_catalog_root('mine').exists()
    assert workspace_catalog_root('foreign').exists()


def test_same_org_admin_and_immutable_workspace_owner_can_delete(app):
    from storage.workspace_store import ensure_workspace, update_workspace_state
    ensure_workspace('owned')
    identity.assign_workspace('org_a', 'owned')
    user = identity.get_user('writer')
    update_workspace_state('owned', {'organization_id': 'org_a', 'owner_user_id': user['user_id']})
    assert login(app, 'writer').delete('/api/workspaces/owned?confirm=true').json['ok'] is True
    assert login(app, 'admin_a').delete('/api/workspaces/mine?confirm=true').json['ok'] is True


@pytest.mark.parametrize('path,method', [
    ('/api/admin/backups', 'GET'), ('/api/admin/backups', 'POST'),
    ('/api/admin/backups/synthetic/restore', 'POST'), ('/api/admin/backups/prune', 'POST'),
    ('/api/jobs/worker/run-once', 'POST'), ('/api/agent/llm/activate', 'POST'),
    ('/api/agent/llm/config', 'DELETE'), ('/api/extensions/demo/disable', 'POST'),
    ('/api/extensions/demo/uninstall', 'POST'), ('/api/extensions/repository', 'GET'),
])
def test_global_admin_operations_require_platform_authority(app, path, method):
    calls = []
    app.add_url_rule(path, endpoint='synthetic_global_operation', view_func=lambda: calls.append(True) or {'ok': True}, methods=[method])
    assert login(app, 'admin_a').open(path, method=method, json={}).status_code == 403
    assert calls == []
    if not path.startswith('/api/extensions/'):
        assert login(app, 'owner').open(path, method=method, json={}).status_code == 200
        assert calls == [True]


@pytest.mark.parametrize('kind,operation', [('retention', 'apply_retention'), ('archive', 'apply_archive')])
def test_scoped_lifecycle_operations_keep_organization_boundary(app, monkeypatch, kind, operation):
    calls = []
    def apply(workspace_id, *_args, **_kwargs):
        calls.append(workspace_id)
        return SimpleNamespace(as_dict=lambda: {'ok': True})
    monkeypatch.setattr(f'core.runtime.{kind}.{operation}', apply)
    client = login(app, 'admin_a')
    assert client.post(f'/api/workspaces/foreign/{kind}/apply', json={'confirm': True}).status_code == 403
    assert calls == []
    assert client.post(f'/api/workspaces/mine/{kind}/apply', json={'confirm': True}).status_code == 200
    assert calls == ['mine']


@pytest.mark.parametrize('change', ['recreate', 'password', 'disable', 'membership'])
def test_old_cookie_cannot_follow_account_or_permission_generation(app, change):
    client = login(app, 'writer')
    old_id = client.get('/api/probe?workspace_id=mine').json['storage_id']
    if change == 'recreate':
        identity.delete_user('writer')
        identity.upsert_user('writer', 'different-password', 'operator', 'org_a', ['mine'])
        assert identity.get_user('writer')['user_id'] != old_id
    elif change == 'membership':
        identity.upsert_membership('org_a', 'writer', 'viewer', ['mine'])
    else:
        identity.update_user_access('writer', 'operator', 'org_a', ['mine'], enabled=change != 'disable', password='different-password' if change == 'password' else '')
    assert client.get('/api/probe?workspace_id=mine').status_code == 401


def test_username_only_cookie_fails_closed(app):
    client = app.test_client()
    with client.session_transaction() as cookie:
        cookie['lzcore_user'] = 'writer'
    assert client.get('/api/probe?workspace_id=mine').status_code == 401


@pytest.mark.parametrize('kind', ['retention', 'archive'])
@pytest.mark.parametrize('audit_id', ['..%5C..%5Cusers', 'C%3Ausers', 'a..b'])
def test_http_audit_detail_rejects_windows_path_spellings(app, kind, audit_id):
    response = login(app, 'writer').get(f'/api/workspaces/mine/{kind}/audits/{audit_id}')
    assert response.status_code == 400
    assert response.json['error'] == 'invalid_audit_id'


@pytest.mark.parametrize('name', ['api-token', 'API-TOKEN', 'system', 'anonymous', 'service'])
def test_reserved_usernames_are_rejected_at_identity_and_api_validation(app, name):
    from backend.api.identity_routes import _validated_user_fields
    with pytest.raises(ValueError, match='reserved'):
        identity.upsert_user(name, 'test-password', 'viewer', 'org_a', ['mine'])
    assert _validated_user_fields(name, 'test-password', 'org_a', ['mine'])[1]
    from backend.ws.agent_ws import _ws_workspace_allowed
    assert not _ws_workspace_allowed('api-token', 'owner', [], 'foreign', write=True)


@pytest.mark.parametrize('stream', ['agent', 'storage'])
@pytest.mark.parametrize('change', ['disable', 'recreate', 'membership', 'workspace'])
def test_sse_rechecks_after_wait_before_sending_frame(app, monkeypatch, stream, change):
    def revoke():
        if change == 'recreate':
            identity.delete_user('writer')
            identity.upsert_user('writer', 'test-password', 'operator', 'org_a', ['mine'])
        elif change == 'membership':
            identity.upsert_membership('org_a', 'writer', 'viewer', [])
        elif change == 'workspace':
            identity.update_user_access('writer', 'operator', 'org_a', [])
        else:
            identity.update_user_access('writer', 'operator', 'org_a', ['mine'], enabled=False)
    if stream == 'agent':
        monkeypatch.setattr('storage.session_store.get_session', lambda *_: {'session_id': 'synthetic'})
        def subscribe(*_args, **_kwargs):
            revoke()
            return 'event: private\ndata: forbidden\n\n'
        monkeypatch.setattr('agent.runtime.session_events.subscribe', subscribe)
        path = '/api/agent/sse/stream/synthetic?workspace_id=mine'
    else:
        @contextmanager
        def subscribe(*_args, **_kwargs):
            def get(**_kwargs):
                revoke()
                return 'forbidden'
            yield SimpleNamespace(get=get)
        monkeypatch.setattr('storage.events.subscribe', subscribe)
        path = '/api/storage/events?workspace_id=mine'
    response = login(app, 'writer').get(path, buffered=False)
    iterator = iter(response.response)
    assert b'connected' in next(iterator)
    assert list(iterator) == []
    response.close()


def test_ws_queued_frames_and_broadcasts_stop_after_revocation(app, monkeypatch):
    from backend.ws import agent_ws
    client = login(app, 'writer')
    with client.session_transaction() as cookie:
        snapshot = dict(cookie)
    with app.test_request_context('/ws/agent'):
        from flask import session
        session.update(snapshot)
        authority = auth.capture_stream_authority()
    principal = auth.storage_principal_for_authority(authority)
    assert agent_ws._ws_workspace_allowed(principal, 'operator', ['mine'], 'mine', write=True, authority=authority)
    sent = []
    # Drain the real sender deterministically without starting its worker.
    monkeypatch.setattr(agent_ws.threading.Thread, 'start', lambda _: None)
    outbox = agent_ws._SocketOutbox(SimpleNamespace(send=sent.append))
    outbox.authority = authority
    outbox.workspace_ids.add('mine')
    outbox.send('private queued frame')
    identity.update_user_access('writer', 'operator', 'org_a', ['mine'], enabled=False)
    assert not agent_ws._ws_workspace_allowed(principal, 'operator', ['mine'], 'mine', write=True, authority=authority)
    outbox._run()
    assert sent == [] and outbox.closed.is_set()
    monkeypatch.setattr(agent_ws, '_active_ws_connections', {'test': (principal, 'mine', outbox)})
    agent_ws._send_broadcast_recipient('test', outbox, 'private broadcast')
    assert 'test' not in agent_ws._active_ws_connections
    assert sent == []


@pytest.mark.parametrize('change', ['disable', 'recreate', 'workspace'])
def test_real_ws_subscription_drops_revoked_recipient(app, monkeypatch, change):
    from backend.ws import agent_ws
    from flask import session
    client = login(app, 'writer')
    with client.session_transaction() as cookie:
        snapshot = dict(cookie)
    monkeypatch.setattr(agent_ws, '_active_ws_connections', {})
    monkeypatch.setattr(agent_ws, '_ensure_broadcast_listener', lambda: None)
    monkeypatch.setattr('agent.runtime.turn_replay.ensure_replay_listener', lambda: None)
    handlers = {}
    def route(path):
        def register(handler):
            handlers[path] = handler
            return handler
        return register
    monkeypatch.setattr(agent_ws, 'sock', SimpleNamespace(init_app=lambda _: None, route=route))
    monkeypatch.setattr(agent_ws, '_SocketOutbox', lambda ws: SimpleNamespace(send=ws.send, close=lambda: None))
    agent_ws.register_ws_routes(app)
    sent = []
    first = True
    def receive(**_kwargs):
        nonlocal first
        if first:
            first = False
            return json.dumps({'type': 'ping', 'workspace_id': 'mine'})
        assert len(agent_ws._active_ws_connections) == 1
        key, (_, _, outbox) = next(iter(agent_ws._active_ws_connections.items()))
        if change == 'recreate':
            identity.delete_user('writer')
            identity.upsert_user('writer', 'test-password', 'operator', 'org_a', ['mine'])
        else:
            identity.update_user_access('writer', 'operator', 'org_a', [] if change == 'workspace' else ['mine'], enabled=change != 'disable')
        agent_ws._send_broadcast_recipient(key, outbox, 'private event')
        assert key not in agent_ws._active_ws_connections
        return None
    ws = SimpleNamespace(send=lambda raw: sent.append(json.loads(raw)), receive=receive)
    with app.test_request_context('/ws/agent', environ_base={'REMOTE_ADDR': '127.0.0.1'}):
        session.update(snapshot)
        handlers['/ws/agent'](ws)
    assert sent == [{'type': 'pong', 'message': 'connected'}]


def test_verified_storage_principal_stays_pinned_after_same_name_recreation(app):
    from storage.principal import principal_storage_key, storage_principal, current_storage_principal
    user = identity.get_user('writer')
    principal = auth.storage_principal_for_authority({'principal_type': 'session', 'username': 'writer', 'user_id': user['user_id']})
    identity.delete_user('writer')
    identity.upsert_user('writer', 'different-password', 'viewer', 'org_a', ['mine'])
    with storage_principal(principal):
        assert principal_storage_key(current_storage_principal()) == user['user_id']
        assert principal_storage_key(current_storage_principal()) != identity.get_user('writer')['user_id']
