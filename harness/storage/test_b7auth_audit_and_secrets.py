"""B7AUTH audit containment and extension secret identity, no OS credentials."""
import pytest


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_MASTER_KEY', 'b7-synthetic-synthetic-master-key')
    monkeypatch.setenv('LZCORE_MASTER_KEY_FILE', '')
    monkeypatch.setenv('LZCORE_OS_SECRET_STORE', 'memory')
    for flag in ('LZCORE_IDENTITY_ENABLED', 'LZCORE_AUTH_ENABLED', 'LZCORE_LOGIN_ENABLED'):
        monkeypatch.setenv(flag, 'false')
    from storage import os_secret_store
    monkeypatch.setattr(os_secret_store, '_MEMORY', {})
    return tmp_path


@pytest.mark.parametrize('getter', ['retention', 'archive'])
@pytest.mark.parametrize('audit_id', ['../identity', '..\\..\\users', 'C:users', 'C:\\users', '\\\\server\\share', '/absolute', 'a/b', 'a..b', '.', '', 'x\x00y'])
def test_audit_id_is_one_strict_segment_on_both_platforms(isolated, getter, audit_id):
    from core.runtime.retention import get_audit
    from core.runtime.archive import get_archive_audit
    read = get_audit if getter == 'retention' else get_archive_audit
    with pytest.raises(ValueError, match='invalid_audit_id'):
        read('mine', audit_id)


@pytest.mark.parametrize('getter', ['retention', 'archive'])
@pytest.mark.parametrize('link', ['file', 'directory'])
def test_audit_resolved_path_cannot_escape_its_directory(isolated, getter, link):
    from core.runtime.retention import get_audit
    from core.runtime.archive import get_archive_audit
    read = get_audit if getter == 'retention' else get_archive_audit
    outside = isolated / 'outside'
    outside.mkdir()
    (outside / 'safe.json').write_text('{"synthetic_private":true}')
    sys = isolated / 'mine' / 'sys'
    sys.mkdir(parents=True)
    if link == 'directory':
        (sys / 'audits').symlink_to(outside, target_is_directory=True)
    else:
        (sys / 'audits').mkdir()
        (sys / 'audits' / 'safe.json').symlink_to(outside / 'safe.json')
    with pytest.raises(ValueError, match='invalid_audit_path'):
        read('mine', 'safe')


def test_valid_audits_and_missing_records_keep_existing_behavior(isolated):
    from core.runtime.retention import get_audit
    from core.runtime.archive import get_archive_audit
    path = isolated / 'mine' / 'sys' / 'audits'
    path.mkdir(parents=True)
    for name, read in [('retention_123', get_audit), ('archive_123', get_archive_audit)]:
        (path / (name + '.json')).write_text('{"ok":true}')
        assert read('mine', name) == {'ok': True}
        assert read('mine', 'missing') == {}


def test_extension_identity_preserves_each_tuple_component_and_owner(isolated):
    from extensions.sdk import ExtensionSecretStore
    from backend.core import identity
    from storage.principal import storage_principal
    from storage.secret_store import get_secret, delete_secret
    for name in ('alice', 'bob'):
        identity.upsert_user(name, 'synthetic-password', 'operator', 'org', ['team', 'team_'])
    refs = []
    for username in ('alice', 'bob'):
        with storage_principal(username):
            for workspace in ('team', 'team_'):
                for extension in ('demo.one', 'demo_one'):
                    for name in ('pw', 'pw_', '口令'):
                        store = ExtensionSecretStore(extension, workspace)
                        value = '/'.join((username, workspace, extension, name))
                        ref = store.set(name, value)
                        refs.append((username, workspace, extension, ref, value))
                        assert store.get(ref) == value
                        assert ExtensionSecretStore.get(ref) == value
    assert len({item[3] for item in refs}) == len(refs)
    for username, workspace, extension, ref, value in refs:
        with storage_principal(username):
            assert ExtensionSecretStore(extension, workspace).get(ref) == value
            with pytest.raises(PermissionError):
                ExtensionSecretStore(extension, 'foreign').get(ref)
            with pytest.raises(PermissionError):
                ExtensionSecretStore('foreign', workspace).delete(ref)
        with storage_principal('bob' if username == 'alice' else 'alice'):
            for operation in (ExtensionSecretStore.get, ExtensionSecretStore.delete, get_secret, delete_secret):
                with pytest.raises(PermissionError):
                    operation(ref)
    with storage_principal('alice'):
        assert ExtensionSecretStore.delete(refs[0][3])
        assert ExtensionSecretStore.get(refs[0][3]) == ''


def test_legacy_reference_never_migrates_or_is_claimed_by_server_user(isolated):
    from extensions.sdk import ExtensionSecretStore
    from storage.principal import storage_principal
    from storage.secret_store import set_secret, get_secret
    ref = set_secret('extension/demo/team/pw', 'synthetic-legacy')
    with storage_principal('alice'):
        for operation in (ExtensionSecretStore.get, ExtensionSecretStore.delete):
            with pytest.raises(PermissionError):
                operation(ref)
    assert ExtensionSecretStore('demo', 'team').get(ref) == 'synthetic-legacy'
    assert get_secret(ref) == 'synthetic-legacy'


def test_recreated_username_cannot_claim_old_credentials(isolated):
    from extensions.sdk import ExtensionSecretStore
    from backend.core import identity
    from storage.principal import storage_principal
    identity.upsert_user('alice', 'old-password', 'operator', 'org', ['team'])
    with storage_principal('alice'):
        old = ExtensionSecretStore('demo', 'team').set('pw', 'old-value')
    identity.delete_user('alice')
    identity.upsert_user('alice', 'new-password', 'operator', 'org', ['team'])
    with storage_principal('alice'):
        with pytest.raises(PermissionError):
            ExtensionSecretStore.get(old)
        new = ExtensionSecretStore('demo', 'team').set('pw', 'new-value')
        assert new != old
        assert ExtensionSecretStore.get(new) == 'new-value'


def test_server_mode_missing_principal_and_foreign_provider_reference_fail_closed(isolated, monkeypatch):
    from extensions.sdk import ExtensionSecretStore
    from storage.principal import storage_principal
    from storage.secret_store import set_secret
    ref = set_secret('provider/synthetic', 'synthetic-platform-secret')
    with storage_principal('alice'):
        with pytest.raises(PermissionError):
            ExtensionSecretStore.get(ref)
    monkeypatch.setenv('LZCORE_IDENTITY_ENABLED', 'true')
    with pytest.raises(PermissionError):
        ExtensionSecretStore('demo', 'team').set('pw', 'synthetic')


def test_service_storage_identity_does_not_resolve_same_named_legacy_user(isolated, monkeypatch):
    from backend.core import identity
    from storage.principal import principal_storage_key
    user_id = 'usr_' + '1' * 32
    monkeypatch.setattr(identity, '_read', lambda: {'users': [{'username': 'api-token', 'user_id': user_id}]})
    assert principal_storage_key('api-token') != user_id
