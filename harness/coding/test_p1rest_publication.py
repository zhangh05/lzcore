"""Preparation journals, source execute bits, and pruned traversal regressions."""
import os
from pathlib import Path

import pytest

from storage import project_changes as changes
from agent.runtime.durable import subagent, coding_team, coding_state
from harness.coding.test_coding_team import team


def test_failed_staging_retains_accepted_candidate_and_can_prepare_again(team, monkeypatch):  # noqa: F811 (pytest fixture)
    first = team.spawn()
    team.spawn('qa_agent', review=first['subtask_id'])
    task = subagent._load_task('parent-ws', first['subtask_id'])
    assert coding_state.candidate(task)['state'] == 'accepted'
    original = changes._copy_source
    def fail(source, target, expected):
        if 'coding-transactions' in target.parts:
            record = changes.publication_record(task.workspace_id, task.subtask_id)
            assert record['phase'] == 'preparing'
            raise OSError('synthetic staging failure')
        return original(source, target, expected)
    with monkeypatch.context() as patch:
        patch.setattr(changes, '_copy_source', fail)
        with pytest.raises(OSError):
            coding_team.integrate(task)
    assert coding_state.candidate(task)['state'] == 'accepted'
    assert not changes.project_path('parent-ws', 'files/data/app').joinpath('src/value.py').exists()
    assert coding_team.integrate(task)['ok']


def test_journal_creation_failure_does_not_enter_publishing(team, monkeypatch):  # noqa: F811 (pytest fixture)
    first = team.spawn()
    team.spawn('qa_agent', review=first['subtask_id'])
    task = subagent._load_task('parent-ws', first['subtask_id'])
    write = changes.atomic_write_json
    def fail(path, record):
        if path.name == 'journal.json':
            raise OSError('synthetic journal failure')
        return write(path, record)
    with monkeypatch.context() as patch:
        patch.setattr(changes, 'atomic_write_json', fail)
        with pytest.raises(OSError):
            coding_team.integrate(task)
    assert coding_state.candidate(task)['state'] == 'accepted'
    assert coding_team.integrate(task)['ok']


def test_publishing_without_apply_reads_prepared_journal_and_allows_explicit_retry(team):  # noqa: F811 (pytest fixture)
    first = team.spawn()
    team.spawn('qa_agent', review=first['subtask_id'])
    task = subagent._load_task('parent-ws', first['subtask_id'])
    record = coding_state.candidate(task)
    branch = changes.project_path(record['branch_workspace'], record['project_dir'])
    prepared = changes.publish_changes(task.workspace_id, record['project_dir'], task.subtask_id,
                                       branch, record['change'], prepare_only=True)
    assert prepared['phase'] == 'prepared'
    coding_state.transition(task.workspace_id, record['id'], 'publication_started',
                            evidence={'event_id': 'simulated-crash', 'record_id': task.subtask_id})
    observed = coding_team.integrate(task)
    assert observed['phase'] == 'rolled_back' and not observed['ok']
    assert coding_state.candidate(task)['state'] == 'conflict'
    assert coding_team.integrate(task)['ok']


def test_missing_journal_stays_unknown_without_replay(team, monkeypatch):  # noqa: F811 (pytest fixture)
    first = team.spawn()
    team.spawn('qa_agent', review=first['subtask_id'])
    task = subagent._load_task('parent-ws', first['subtask_id'])
    record = coding_state.candidate(task)
    coding_state.transition(task.workspace_id, record['id'], 'publication_started',
                            evidence={'event_id': 'legacy-missing', 'record_id': task.subtask_id})
    monkeypatch.setattr(changes, '_replace', lambda *a: pytest.fail('unknown publication replayed'))
    for _ in range(2):
        result = coding_team.integrate(task)
        assert result['phase'] == 'unknown' and not result['ok']
        assert not result['automatic_retry_allowed']


def test_execute_bits_survive_snapshot_staging_publish_and_readback(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    project = changes.project_path('parent-ws', 'files/data/app')
    project.mkdir(parents=True)
    script = project / 'check.sh'
    script.write_text('#!/bin/sh\nexit 0\n')
    script.chmod(0o755)
    baseline = changes.source_manifest(project)
    branch = tmp_path / 'branch'
    changes.copy_sources(project, branch, baseline)
    assert (branch / 'check.sh').stat().st_mode & 0o111 == 0o111
    assert changes.source_manifest(branch) == baseline
    (branch / 'check.sh').chmod(0o700)  # chmod-only changes must be visible.
    current = changes.source_manifest(branch)
    assert current != baseline and changes.manifest_digest(current) != changes.manifest_digest(baseline)
    change = changes.changeset(baseline, current, ['.'])
    result = changes.publish_changes('parent-ws', 'files/data/app', 'sub-12345678', branch, change)
    assert result['ok'] and script.stat().st_mode & 0o111 == 0o100
    assert changes.reconcile_publication('parent-ws', 'files/data/app', 'sub-12345678', change)['ok']
    script.chmod(0o644)
    assert changes.reconcile_publication('parent-ws', 'files/data/app', 'sub-12345678', change)['phase'] == 'unknown'


def test_rollback_restores_original_executable_bits(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    project = changes.project_path('parent-ws', 'files/data/app')
    project.mkdir(parents=True)
    branch = tmp_path / 'branch'
    branch.mkdir()
    for name in ('a.sh', 'b.sh'):
        (project / name).write_text('before')
        (project / name).chmod(0o755)
        (branch / name).write_text('after')
    change = changes.changeset(changes.source_manifest(project), changes.source_manifest(branch), ['.'])
    replace = changes._replace
    failed = [False]
    def interrupt(target, source):
        if target.name == 'b.sh' and not failed[0]:
            failed[0] = True
            raise OSError('synthetic interruption')
        return replace(target, source)
    monkeypatch.setattr(changes, '_replace', interrupt)
    result = changes.publish_changes('parent-ws', 'files/data/app', 'sub-12345678', branch, change)
    assert result['phase'] == 'rolled_back'
    assert all((project / name).stat().st_mode & 0o111 == 0o111 for name in ('a.sh', 'b.sh'))


def test_source_scan_prunes_before_descending_and_rejects_source_symlinks(monkeypatch, tmp_path):
    project = tmp_path / 'project'
    for name in ('node_modules/deep', 'dist/nested', 'src'):
        (project / name).mkdir(parents=True)
        (project / name / 'file').write_text('test')
    scandir = os.scandir
    seen = []
    def inspect(path):
        seen.append(Path(path))
        assert 'node_modules' not in Path(path).parts and 'dist' not in Path(path).parts
        return scandir(path)
    monkeypatch.setattr(os, 'scandir', inspect)
    assert set(changes.source_manifest(project, ['dist'])) == {'src/file'}
    assert project / 'src' in seen
    (project / 'linked').symlink_to(project / 'src', target_is_directory=True)
    with pytest.raises(ValueError, match='symlink'):
        changes.source_manifest(project, ['dist'])


def test_scan_io_failure_is_not_an_empty_source(monkeypatch, tmp_path):
    def fail(*a):
        raise PermissionError('synthetic source inaccessible')
    monkeypatch.setattr(os, 'scandir', fail)
    with pytest.raises(PermissionError):
        changes.source_manifest(tmp_path)


def test_uncertain_partial_publication_only_reads_back(monkeypatch, tmp_path):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    project = changes.project_path('parent-ws', 'files/data/app')
    project.mkdir(parents=True)
    branch = tmp_path / 'branch'
    branch.mkdir()
    for name in ('a', 'b'):
        (project / name).write_text('before')
        (branch / name).write_text('after')
    change = changes.changeset(changes.source_manifest(project), changes.source_manifest(branch), ['.'])
    prepared = changes.publish_changes('parent-ws', 'files/data/app', 'sub-12345678', branch, change, prepare_only=True)
    prepared.pop('ok')
    prepared['phase'] = 'applying'
    changes.atomic_write_json(changes._transaction_root('parent-ws', 'sub-12345678') / 'journal.json', prepared)
    (project / 'a').write_text('after')
    monkeypatch.setattr(changes, '_replace', lambda *a: pytest.fail('uncertain source was rewritten'))
    observed = changes.publish_changes('parent-ws', 'files/data/app', 'sub-12345678', branch, change)
    assert not observed['ok'] and observed['phase'] == 'unknown' and not observed['automatic_retry_allowed']
    assert (project / 'a').read_text() == 'after' and (project / 'b').read_text() == 'before'
