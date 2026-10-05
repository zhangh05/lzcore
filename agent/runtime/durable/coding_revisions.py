"""Explicit source proposal handoff; copying source never authorizes publication."""
from storage.project_changes import (
    copy_sources, manifest_digest, project_path, quiescent_project, source_manifest,
)


def _target(task):
    from .coding_team import _related
    target = _related(task, task.coding['revision_subtask_id'])
    assignment = target.coding
    validation = assignment.get('completion_validation') or {}
    environment = assignment.get('environment') or {}
    failed_source = (target.status in {'failed', 'cancelled'} and assignment.get('phase') == 'failed'
                     and validation.get('status') == 'failed')
    ready_proposal = (target.status == 'succeeded' and assignment.get('phase') in {'changes_ready', 'validated'}
                      and validation.get('status') == 'passed'
                      and validation.get('source_digest') == assignment.get('candidate_digest'))
    if assignment.get('phase') == 'qa_rejected':
        review = _related(task, assignment.get('qa_rejection_subtask_id', ''))
        failed_source = (review.status == 'failed' and review.coding.get('phase') == 'qa_rejected'
                         and (review.coding.get('qa_review') or {}).get('verdict') == 'fail'
                         and (review.coding.get('environment') or {}).get('closed')
                         and (review.coding.get('environment') or {}).get('cleanup_confirmed'))
    if (target.profile_id not in {'coding_agent', 'frontend_agent'}
            or not (failed_source or ready_proposal)
            or not environment.get('closed') or not environment.get('cleanup_confirmed')
            or assignment['project_dir'] != task.coding['project_dir']):
        raise ValueError('coding_revision_requires_stopped_known_implementation')
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
        if target.coding.get('candidate_digest') and digest != target.coding['candidate_digest']:
            raise ValueError('coding_revision_candidate_changed')
    assignment['revision_source_digest'] = digest


def seed_revision(task, branch):
    """Copy proposed source, retaining its original integrated publication base."""
    from .coding_team import _related
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
    if target.coding.get('phase') == 'qa_rejected':
        review = _related(task, target.coding['qa_rejection_subtask_id'])
        assignment['revision_observation']['qa_review'] = review.coding['qa_review']
    return baseline


def revision_readiness(assignment, validation):
    """A copied passing proposal is not a completed source revision.

    Dependency/environment repair may recover failed checks without editing
    source. Inherited passing checks alone cannot evidence a new revision;
    semantic correctness still requires exact independent QA in either case.
    Unknown execution always retains its original reconciliation boundary.
    """
    if not assignment.get('revision_subtask_id') or validation.get('status') != 'passed':
        return validation
    previous = (assignment.get('revision_observation') or {}).get('completion_validation') or {}
    changed = validation['source_digest'] != assignment.get('revision_source_digest')
    recovered = previous.get('status') == 'failed' and any(
        (type(check.get('result', {}).get('exit_code')) is int
         and check['result']['exit_code'] != 0)
        or check.get('result', {}).get('runtime_status') == 'failed'
        for check in previous.get('checks', [])
    )
    evidence = {'source_changed': changed, 'previous_checks_recovered': recovered}
    if changed or recovered:
        return {**validation, 'revision_evidence': evidence}
    return {**validation, 'status': 'failed', 'revision_evidence': evidence,
            'readiness_gap': 'unchanged_source_proposal',
            'recovery_instruction': '[SERVER COMPLETION CONTRACT]\nThe assigned source revision is unchanged. '
            'Its inherited executable checks already passed; passing them again does not repair the assigned defects. '
            'Use actual available tools to revise the source and preserve the full goal and tests. '
            'A future-work promise cannot complete this assignment. Exact independent QA and integration remain required.'}
