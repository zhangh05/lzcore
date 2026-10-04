"""Execution bindings are server-owned, fail closed, and preserve uncertainty."""
import subprocess
from pathlib import Path

import pytest

from core.tools import project_execution as environments
from core.tools.project_execution import DockerProjectEnvironment, isolated_project, environment_for


@pytest.fixture
def environment(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_CODING_DOCKER_COMMAND', '["docker"]')
    project = tmp_path / 'isolated' / 'files/data/project'
    item = DockerProjectEnvironment('isolated', project, 5279)
    yield item
    environments._BINDINGS.pop(str(item.root), None)


def completed(*args, **kwargs):
    return subprocess.CompletedProcess(args, 0, '', '')


def test_environment_accepts_only_generated_project_mount(environment):
    with pytest.raises(ValueError, match='generated_project'):
        DockerProjectEnvironment('isolated', environment.root / 'sessions', 5279)
    with pytest.raises(ValueError):
        DockerProjectEnvironment('isolated', environment.root.parent / 'another/files/data/project', 5279)


def test_container_contract_no_host_mounts_credentials_or_privileges(environment, monkeypatch):
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        result = completed(*args)
        if args[:2] == ('image', 'inspect'):
            result.stdout = 'sha256:' + '1' * 64
        return result
    monkeypatch.setattr(environment, '_docker', docker)
    environment.start()
    run = next(call for call in calls if environment.name in call and call[0] == 'run')
    assert '--read-only' in run and '--cap-drop=ALL' in run and '--security-opt=no-new-privileges' in run
    assert run[run.index('--network') + 1] == environment.network
    assert [value for value in run if value.startswith('type=bind')] == [f'type=bind,source={environment.project},target={environment.mount_target}']
    assert ('network', 'create', '--internal', environment.network) in calls
    assert not any('docker.sock' in value or '/Users/' in value and not value.startswith('type=bind,source=') for value in run)


def test_timeout_cleanup_failure_never_claims_stopped(environment, monkeypatch):
    environment.started = True
    monkeypatch.setattr('core.tools.general_tools.shared._run_shell', lambda *a, **kw: {'ok': False, 'process_tree_killed': True})
    def offline(*a, **kw):
        raise subprocess.TimeoutExpired('docker', 10)
    monkeypatch.setattr(environment, '_docker', offline)
    result = environment.execute('sleep 90', str(environment.project), timeout=1)
    assert result['execution_may_continue'] and not result['isolated_environment_stopped']
    assert result['execution_outcome'] == 'unknown' and not result['automatic_retry_allowed']
    assert not environment.execute('touch unsafe', str(environment.project))['executed']
    monkeypatch.setattr(environment, '_docker', completed)
    assert environment.close() and environment.cleanup_confirmed


def test_closed_binding_never_falls_back_to_host(environment, monkeypatch):
    monkeypatch.setattr(DockerProjectEnvironment, 'start', lambda self: self)
    monkeypatch.setattr(DockerProjectEnvironment, '_docker', completed)
    with isolated_project('isolated', environment.project, 5279) as active:
        assert environment_for('isolated') is active
    assert environment_for('isolated').closed
    assert not environment_for('isolated').execute('echo host_escape', str(environment.project))['executed']


def test_env_does_not_inherit_credentials(environment, monkeypatch):
    monkeypatch.setenv('UNIT_API_KEY', 'fake-test-key')
    _, env = environments._client_configuration()
    assert 'UNIT_API_KEY' not in env
    # Client HOME is used by Docker/Lima; it is never supplied as container env.


def test_python_contract_shared_with_host_and_container():
    from core.tools.python_program import build_program, decode_program_output
    result = subprocess.run(['python3', '-c', build_program('result = {"值": input_data["值"] + 1}', {'值': 2})], capture_output=True, text=True, encoding='utf-8')
    decoded = decode_program_output({'stdout': result.stdout, 'stderr': result.stderr, 'ok': result.returncode == 0})
    assert decoded['ok'] and decoded['structured_output'] == {'值': 3} and decoded['stdout'] == ''
