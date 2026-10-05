"""Execution bindings are server-owned, fail closed, and preserve uncertainty."""
import subprocess

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


def test_strict_default_shell_directory_is_writable_project_and_explicit_paths_stay_scoped(environment, monkeypatch):
    calls = []
    environment.started = True
    def run(*args, **kwargs):
        calls.append(kwargs['argv_override'])
        return {'ok': True, 'stdout': '', 'exit_code': 0}
    monkeypatch.setattr('core.tools.general_tools.shared._run_shell', run)
    default = environment.execute('touch server.pid', str(environment.root))
    assert default['container_cwd'] == environment.descriptor()['cwd'] == environment.mount_target
    assert default['working_dir'] == 'files/data/project'
    assert calls[-1][calls[-1].index('--workdir') + 1] == environment.mount_target
    child = environment.project / 'source'
    child.mkdir()
    explicit = environment.execute('pwd', str(child))
    assert explicit['container_cwd'] == environment.mount_target + '/source'
    rejected = environment.execute('pwd', str(environment.root / 'sessions'))
    assert rejected['ok'] is False and rejected['executed'] is False
    assert len(calls) == 2


def test_python_contract_shared_with_host_and_container():
    from core.tools.python_program import build_program, decode_program_output
    result = subprocess.run(['python3', '-c', build_program('result = {"值": input_data["值"] + 1}', {'值': 2})], capture_output=True, text=True, encoding='utf-8')
    decoded = decode_program_output({'stdout': result.stdout, 'stderr': result.stderr, 'ok': result.returncode == 0})
    assert decoded['ok'] and decoded['structured_output'] == {'值': 3} and decoded['stdout'] == ''


@pytest.mark.parametrize("mode", ["coordinator", "review"])
def test_source_ownership_mounts_and_stable_preview_binding(environment, monkeypatch, mode):
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        result = completed(*args)
        if args[:2] == ('image', 'inspect'):
            result.stdout = 'sha256:' + '1' * 64
        return result
    environment.source_mode = mode
    environment.generated_paths = ['dist']
    monkeypatch.setattr(environment, '_docker', docker)
    environment.start()
    run = next(c for c in calls if c[0] == 'run' and environment.name in c)
    mounts = [v for v in run if v.startswith('type=bind')]
    assert mounts[0].endswith(',readonly')
    assert len(mounts) == 5
    assert all('source=' + str(environment.project) in v for v in mounts)
    assert '--env=PORT=8080' in run
    broker = next(c for c in calls if c[0] == 'run' and environment.broker in c)
    assert '127.0.0.1:5279:8080' in broker and 'PROJECT_PORT=8080' in broker
    assert environment.descriptor()['preview_bind_port'] == 8080
    assert environment.descriptor()['preview_origin'] == 'http://127.0.0.1:5279'


def test_governed_file_tools_cannot_bypass_coordinator_source_ownership(environment, monkeypatch):
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    environment.source_mode = 'coordinator'
    environment.generated_paths = ['dist']
    monkeypatch.setitem(environments._BINDINGS, str(environment.root), environment)
    client = get_default_tool_runtime_client()
    ctx = ToolRuntimeContext(workspace_id='isolated', session_id='ownership', requested_by='turn_runner')
    for action, extra in [('create', {'content':'unreviewed'}), ('edit', {'old_string':'old','new_string':'new'}), ('delete', {})]:
        result = client.invoke('workspace.file', {'action':action, 'filepath':'files/data/project/source.py', **extra}, context=ctx)
        assert result.status == 'failed' and result.output['error_code'] == 'CODING_SOURCE_OWNED_BY_IMPLEMENTATION'
    assert not (environment.project / 'source.py').exists()
    result = client.invoke('workspace.file', {'action':'create','filepath':'files/data/project/dist/output.txt','content':'built'}, context=ctx)
    assert result.status == 'succeeded'


def test_ownership_transition_retires_writer_and_never_resumes_replacement(environment, monkeypatch):
    from storage.project_changes import quiescent_project
    environment.started = True
    calls = []
    monkeypatch.setattr(environment, '_docker', lambda *a, **kw: calls.append(a) or completed(*a))
    monkeypatch.setitem(environments._BINDINGS, str(environment.root), environment)
    with quiescent_project('isolated'):
        environment.coordinate(['dist'])
    assert environment.source_mode == 'coordinator' and environment.generation == 1
    assert ('pause', environment.name) in calls
    assert ('rm', '--force', environment.name) in calls
    assert ('unpause', environment.name) not in calls
    run = next(c for c in calls if c[0] == 'run')
    assert any(v.startswith('type=bind') and v.endswith(',readonly') for v in run)
    with pytest.raises(ValueError, match='contract_mismatch'):
        environment.coordinate(['src'])


def test_busy_execution_cannot_be_retired_by_coordination(environment, monkeypatch):
    environment.started = True
    environment._active_executions = 1
    monkeypatch.setattr(environment, '_docker', lambda *a, **kw: pytest.fail('must not retire active execution'))
    with pytest.raises(ValueError, match='execution_busy'):
        environment.coordinate(['dist'])
    assert environment.source_mode == 'implementation' and environment.generation == 0


def test_ownership_restart_failure_closes_execution_instead_of_restoring_writer(environment, monkeypatch):
    environment.started = True
    monkeypatch.setattr(environment, '_docker', completed)
    monkeypatch.setattr(environment, '_launch_project', lambda shared: (_ for _ in ()).throw(OSError('owned test outage')))
    with pytest.raises(OSError):
        environment.coordinate(['dist'])
    assert environment.closed and environment.cleanup_confirmed
    assert not environment.execute('touch unsafe', str(environment.project))['executed']


def test_governed_source_path_feedback_requires_explicit_correction(environment, monkeypatch):
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    environment.started = True
    monkeypatch.setitem(environments._BINDINGS, str(environment.root), environment)
    client = get_default_tool_runtime_client()
    ctx = ToolRuntimeContext(workspace_id='isolated', session_id='path-contract', requested_by='subagent')
    for path in ('src/main.ts', environment.mount_target + '/src/main.ts'):
        rejected = client.invoke('workspace.file', {'action':'create','filepath':path,'content':'export const value = 1;'}, context=ctx)
        assert rejected.status == 'failed'
        assert rejected.output['error_code'] == 'FILE_PATH_OUTSIDE_MANAGED_STORAGE'
        details = rejected.output['error_details']
        assert details['path_basis'] == 'workspace_root'
        assert details['suggested_filepath'] == 'files/data/project/src/main.ts'
        assert rejected.output['executed'] is False
        assert not (environment.project / 'src/main.ts').exists()
    corrected = client.invoke('workspace.file', {'action':'create','filepath':details['suggested_filepath'],'content':'export const value = 1;'}, context=ctx)
    assert corrected.status == 'succeeded'
    edited = client.invoke('workspace.file', {'action':'edit','filepath':details['suggested_filepath'],
                           'old_string':'value = 1','new_string':'value = 2'}, context=ctx)
    assert edited.status == 'succeeded'
    assert (environment.project / 'src/main.ts').read_text() == 'export const value = 2;'
    environment.source_mode = 'review'
    denied = client.invoke('workspace.file', {'action':'edit','filepath':details['suggested_filepath'],
                           'old_string':'value = 2','new_string':'value = 3'}, context=ctx)
    assert denied.output['error_code'] == 'CODING_SOURCE_OWNED_BY_IMPLEMENTATION'
    assert (environment.project / 'src/main.ts').read_text() == 'export const value = 2;'


def test_path_diagnostics_do_not_suggest_escaping_or_closed_project(environment, monkeypatch):
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    environment.started = True
    monkeypatch.setitem(environments._BINDINGS, str(environment.root), environment)
    client = get_default_tool_runtime_client()
    ctx = ToolRuntimeContext(workspace_id='isolated', session_id='escaping', requested_by='subagent')
    for path in ('../../outside.txt', '/host/private.txt', 'src\\\\main.ts'):
        result = client.invoke('workspace.file', {'action':'create','filepath':path,'content':'unsafe'}, context=ctx)
        assert result.status == 'failed'
        assert 'suggested_filepath' not in result.output.get('error_details', {})
    environment.closed = True
    result = client.invoke('workspace.file', {'action':'create','filepath':'src/main.ts','content':'unsafe'}, context=ctx)
    assert 'active_project_dir' not in result.output['error_details']


def test_container_shell_uses_same_pipeline_status_contract(environment, monkeypatch):
    observed = []
    monkeypatch.setattr(environment, '_execute', lambda argv, *a, **kw: observed.append(argv))
    environment.execute('false | tail -1', str(environment.project))
    assert observed == [['/bin/bash', '-o', 'pipefail', '-c', 'false | tail -1']]
