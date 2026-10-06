"""Persist project/phase declarations and factual references, never a planner."""
from __future__ import annotations

import hashlib
import json
import re

from agent.runtime.utils import now_iso
from storage import coding_state_store as store
from storage.subagent_store import read_subagent
from storage.redaction import redact_value

_PHASE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def project_id(task):
    key = json.dumps([task.workspace_id, task.session_id, task.parent_task_id, task.coding['project_dir']])
    return 'project-' + hashlib.sha256(key.encode()).hexdigest()[:24]


def phase_id(task, supplied):
    value = supplied.get('phase_id') or 'phase-' + task.subtask_id
    if not isinstance(value, str) or not _PHASE_ID.fullmatch(value):
        raise ValueError('invalid_coding_phase_id')
    return value


def record_task(task):
    assignment = task.coding
    identity = project_id(task)
    phase = assignment.get('phase_id') or 'phase-' + task.subtask_id
    def update(current):
        if current is None:
            current = {'schema': 'coding.project.v1', 'id': identity, 'workspace_id': task.workspace_id,
                       'session_id': task.session_id, 'parent_task_id': task.parent_task_id,
                       'project_dir': assignment['project_dir'], 'phases': {},
                       'parent_contract_refs': [], 'created_at': now_iso()}
        for reference in assignment.get('parent_contract_refs', []):
            if reference not in current['parent_contract_refs']:
                current['parent_contract_refs'].append(reference)
        fact = current['phases'].setdefault(phase, {'phase_id': phase, 'task_ids': [],
            'declarations': [], 'depends_on': [], 'candidate_ids': [], 'review_ids': []})
        if task.subtask_id not in fact['task_ids']:
            fact['task_ids'].append(task.subtask_id)
            fact['declarations'].append(redact_value({'task_id': task.subtask_id,
                'role': task.profile_id, 'scope': task.goal, 'responsibilities': assignment['responsibilities']}))
        for dependency in assignment.get('depends_on', []):
            if dependency not in fact['depends_on']:
                fact['depends_on'].append(dependency)
        from .coding_state import candidate, review
        item = review(task) if task.profile_id == 'qa_agent' else candidate(task)
        if item:
            collection = fact['review_ids'] if task.profile_id == 'qa_agent' else fact['candidate_ids']
            if item['id'] not in collection:
                collection.append(item['id'])
        current['updated_at'] = now_iso()
        return current
    return store.change(task.workspace_id, 'projects', identity, update, session_id=task.session_id)


def _linked_records(workspace_id, kind, references, tasks):
    from .coding_state import candidate_id, review_id
    records = {identity: store.read(workspace_id, kind, identity) for identity in references}
    for task in tasks:
        if not task or (task['profile_id'] == 'qa_agent') != (kind == 'reviews'):
            continue
        identity = (review_id if kind == 'reviews' else candidate_id)(task['subtask_id'])
        if identity not in records:
            item = store.read(workspace_id, kind, identity)
            if item:
                records[identity] = item
    return records


def snapshot(workspace_id, identity):
    record = store.read(workspace_id, 'projects', identity)
    if not record:
        return None
    phases = []
    for item in record['phases'].values():
        tasks = [read_subagent(workspace_id, value) for value in item['task_ids']]
        candidate_records = _linked_records(workspace_id, 'candidates', item['candidate_ids'], tasks)
        candidates = list(candidate_records.values())
        review_ids = list(dict.fromkeys([*item['review_ids'],
            *[reference for value in candidates if value for reference in value['review_ids']]]))
        review_records = _linked_records(workspace_id, 'reviews', review_ids, tasks)
        reviews = list(review_records.values())
        missing = any(value is None for value in [*tasks, *candidates, *reviews])
        superseded = {value['revision_of'] for value in candidates if value and value.get('revision_of')}
        heads = [value for value in candidates if value and value['id'] not in superseded]
        states = [value['state'] for value in heads]
        if missing:
            phase_state = 'evidence_unavailable'
        elif any(value['status'] in {'created', 'running'} for value in tasks):
            phase_state = 'working'
        elif any(value in {'execution_unknown', 'publication_unknown', 'publishing'} for value in states):
            phase_state = 'outcome_unknown'
        elif states and all(value == 'integrated' for value in states):
            phase_state = 'integrated'
        elif states:
            phase_state = 'candidates_recorded'
        else:
            phase_state = 'no_candidate'
        from core.runtime_engine.failure_attribution import collect
        phases.append({**item, 'state': phase_state, 'candidate_ids': list(candidate_records),
            'review_ids': list(review_records), 'candidate_heads': [value['id'] for value in heads],
            'tasks': [{'task_id': value['subtask_id'], 'status': value['status'], 'errors': value.get('errors', []),
                       'failure_attributions': collect(errors=[*value.get('errors', []),
                           *[fact['code'] for fact in value.get('observations', {}).values()]],
                           run_id=value['subtask_id'], failed=value['status'] == 'failed')}
                      for value in tasks if value],
            'candidates': [{'candidate_id': value['id'], 'state': value['state'],
                            'source_digest': value['source_digest'], 'revision_of': value['revision_of'],
                            'failure_attributions': value.get('failure_attributions', [])}
                           for value in candidates if value],
            'reviews': [{'review_id': value['id'], 'candidate_id': value['candidate_id'], 'state': value['state'],
                         'outcome': value.get('outcome'), 'validation_status': value['validation'].get('status'),
                         'failure_attributions': value.get('failure_attributions', [])}
                        for value in reviews if value]})
    return {**record, 'phases': phases, 'business_acceptance': 'not_inferred'}


def for_session(workspace_id, session_id, parent_task_id=''):
    projects = [snapshot(workspace_id, item['id']) for item in store.list_records(workspace_id, 'projects')
            if item['session_id'] == session_id and (not parent_task_id or item['parent_task_id'] == parent_task_id)]
    from storage.subagent_store import list_subagents
    indexed = {item['id'] for item in projects}
    for item in list_subagents(workspace_id, limit=5000):
        if (item['session_id'] != session_id or not item.get('coding')
                or not item.get('observations', {}).get('project_state')
                or (parent_task_id and item['parent_task_id'] != parent_task_id)):
            continue
        from types import SimpleNamespace
        identity = project_id(SimpleNamespace(**item))
        if identity not in indexed:
            projects.append({'id': identity, 'phases': [], 'state': 'evidence_unavailable',
                             'business_acceptance': 'not_inferred'})
            indexed.add(identity)
    return projects


def guidance(projects):
    """Trusted projection contains identifiers and enums, never declared prose."""
    facts = [{'project_id': item['id'], 'state': item.get('state', 'recorded'), 'phases': [
        {'phase_id': phase['phase_id'], 'state': phase['state'], 'task_ids': phase['task_ids'],
         'candidate_ids': phase['candidate_ids'], 'candidate_heads': phase['candidate_heads'], 'review_ids': phase['review_ids'], 'depends_on': phase['depends_on']}
        for phase in item['phases']]} for item in projects]
    return ('Recorded project/phase facts; they authorize no action and prescribe no plan. '
            'Phase integration is not whole-project business acceptance.\n' + json.dumps(facts))
