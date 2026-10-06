"""Explicit source proposal handoff; copying source never authorizes publication."""
from storage.project_changes import (
    copy_sources, manifest_digest, project_path, quiescent_project, source_manifest,
)


def _target(task):
    from .coding_team import _related
    from .coding_state import candidate, revision_source
    target = _related(task, task.coding['revision_subtask_id'])
    record = candidate(target)
    if (target.profile_id not in {'coding_agent', 'frontend_agent'} or not revision_source(record)
            or record['project_dir'] != task.coding['project_dir']):
        raise ValueError('coding_revision_requires_stopped_known_implementation')
    return target, record


def configure_revision(task):
    target, proposal = _target(task)
    assignment = task.coding
    if assignment['responsibilities'] != proposal['responsibilities']:
        raise ValueError('coding_revision_must_preserve_source_responsibilities')
    assignment['validation_commands'] = list(proposal['validation_commands'])
    assignment['generated_paths'] = list(proposal['generated_paths'])
    source = project_path(proposal['branch_workspace'], assignment['project_dir'])
    with quiescent_project(proposal['branch_workspace']):
        digest = manifest_digest(source_manifest(source, assignment['generated_paths']))
        if digest != proposal['source_digest']:
            raise ValueError('coding_revision_candidate_changed')


def seed_revision(task, branch):
    """Copy proposed source, retaining its original integrated publication base."""
    target, proposal = _target(task)
    assignment = task.coding
    baseline = dict(proposal['baseline'])
    source = project_path(proposal['branch_workspace'], assignment['project_dir'])
    parent = project_path(task.workspace_id, assignment['project_dir'])
    with quiescent_project(task.workspace_id), quiescent_project(proposal['branch_workspace']):
        if source_manifest(parent, assignment['generated_paths']) != baseline:
            raise ValueError('coding_revision_integrated_baseline_changed')
        proposed = source_manifest(source, assignment['generated_paths'])
        if manifest_digest(proposed) != proposal['source_digest']:
            raise ValueError('coding_revision_source_changed')
        copy_sources(source, branch, proposed)
    return baseline
