"""Server-owned source handoff for a stopped, known failed implementation."""
from storage.project_changes import (
    copy_sources, manifest_digest, project_path, quiescent_project, source_manifest,
)


def _target(task):
    from .coding_team import _related
    target = _related(task, task.coding['revision_subtask_id'])
    assignment = target.coding
    validation = assignment.get('completion_validation') or {}
    environment = assignment.get('environment') or {}
    if (target.profile_id not in {'coding_agent', 'frontend_agent'}
            or target.status not in {'failed', 'cancelled'} or assignment.get('phase') != 'failed'
            or validation.get('status') != 'failed'
            or not environment.get('closed') or not environment.get('cleanup_confirmed')
            or assignment['project_dir'] != task.coding['project_dir']):
        raise ValueError('coding_revision_requires_stopped_known_failed_implementation')
    return target


def configure_revision(task):
    target = _target(task)
    assignment = task.coding
    if assignment['responsibilities'] != target.coding['responsibilities']:
        raise ValueError('coding_revision_must_preserve_source_responsibilities')
    assignment['validation_commands'] = list(target.coding['validation_commands'])
    assignment['generated_paths'] = list(target.coding.get('generated_paths', []))
    source = project_path(target.coding['branch_workspace'], assignment['project_dir'])
    with quiescent_project(target.coding['branch_workspace']):
        digest = manifest_digest(source_manifest(source, assignment['generated_paths']))
    assignment['revision_source_digest'] = digest


def seed_revision(task, branch):
    """Copy proposed source, retaining its original integrated publication base."""
    target = _target(task)
    assignment = task.coding
    baseline = dict(target.coding['baseline'])
    source = project_path(target.coding['branch_workspace'], assignment['project_dir'])
    parent = project_path(task.workspace_id, assignment['project_dir'])
    with quiescent_project(task.workspace_id), quiescent_project(target.coding['branch_workspace']):
        if source_manifest(parent, assignment['generated_paths']) != baseline:
            raise ValueError('coding_revision_integrated_baseline_changed')
        proposed = source_manifest(source, assignment['generated_paths'])
        if manifest_digest(proposed) != assignment['revision_source_digest']:
            raise ValueError('coding_revision_source_changed')
        copy_sources(source, branch, proposed)
    assignment['revision_observation'] = {
        'subtask_id': target.subtask_id, 'source_digest': assignment['revision_source_digest'],
        'completion_validation': target.coding['completion_validation'],
    }
    return baseline
