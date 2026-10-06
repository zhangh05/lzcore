"""Known source can be revised after an incomplete judgement, never unknown execution."""
from types import SimpleNamespace

import pytest

from agent.runtime.durable import coding_team, subagent
from core.tools.context import ToolRuntimeContext
from harness.test_coding_reviews import qa_runtime, report
from harness.test_coding_team import team as team_fixture
from storage.project_changes import project_path
from harness.coding_record_fixtures import corrupt_record
from agent.runtime.durable.coding_state import review_id


@pytest.fixture
def team(monkeypatch, tmp_path):
    return team_fixture.__wrapped__(monkeypatch, tmp_path)


def incomplete_candidate(team, monkeypatch):
    first = team.spawn()
    qa_runtime(monkeypatch, 'unknown')
    reviewed = team.spawn('qa_agent', review=first['subtask_id'])
    source = subagent._load_task('parent-ws', first['subtask_id'])
    qa = subagent._load_task('parent-ws', reviewed['subtask_id'])
    assert source.coding['phase'] == qa.coding['phase'] == 'qa_incomplete'
    return source, qa


def revision(source):
    return {'project_dir': 'files/data/app', 'responsibilities': ['src'],
            'validation_commands': ['true'], 'revision_subtask_id': source.subtask_id}


def test_incomplete_judgement_preserves_known_source_for_explicit_revision(team, monkeypatch):
    source, qa = incomplete_candidate(team, monkeypatch)
    old_project = project_path(source.coding['branch_workspace'], 'files/data/app')

    def repair(session, turn, **kwargs):
        if turn.op.runtime_control.profile['profile_id'] != 'qa_agent':
            current = project_path(session.workspace_id, 'files/data/app')
            assert current.joinpath('src/value.py').read_text() == 'VALUE = 42\n'
            assert '"verdict": "unknown"' in turn.op.user_input
            edited = team.client.invoke('workspace.file', {'action': 'edit',
                'filepath': 'files/data/app/src/value.py', 'old_string': '42', 'new_string': '43'},
                context=ToolRuntimeContext(workspace_id=session.workspace_id,
                    session_id=session.session_id, requested_by='subagent'))
            assert edited.status == 'succeeded'
        return SimpleNamespace(ok=True, final_response=report(), tool_calls=[])

    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', repair)
    repaired = team.client.invoke('agent.manage', {'action': 'spawn', 'profile_id': 'coding_agent',
        'instruction': 'Revise the known proposal, retaining incomplete QA evidence',
        'background': False, 'coding_assignment': revision(source)}, context=team.parent).output
    assert repaired.get('task_status') == 'succeeded', repaired
    candidate = subagent._load_task('parent-ws', repaired['subtask_id'])
    assert candidate.coding['validation_commands'] == source.coding['validation_commands']
    assert candidate.coding['baseline'] == source.coding['baseline'] == {}
    assert candidate.coding['revision_observation']['qa_review'] == qa.coding['qa_review']
    assert old_project.joinpath('src/value.py').read_text() == 'VALUE = 42\n'
    assert not subagent.merge_subagent_result('parent-task', candidate.subtask_id, 'parent-ws')['ok']
    assert team.spawn('qa_agent', review=candidate.subtask_id)['task_status'] == 'succeeded'
    assert subagent.merge_subagent_result('parent-task', candidate.subtask_id, 'parent-ws')['ok']
    from scripts.benchmark_team_acceptance import verify_team
    assert verify_team('parent-ws', 'parent-session', 'files/data/app')['status'] == 'PASS'
    assert subagent._load_task('parent-ws', source.subtask_id).coding['phase'] == 'qa_incomplete'


@pytest.mark.parametrize('boundary', ['active_review', 'cleanup', 'unknown_execution', 'identity', 'digest'])
def test_incomplete_judgement_does_not_relax_review_or_execution_boundaries(team, monkeypatch, boundary):
    source, qa = incomplete_candidate(team, monkeypatch)
    def corrupt(record):
        if boundary == 'active_review':
            record['resources']['closed'] = False
        elif boundary == 'cleanup':
            record['resources']['cleanup_confirmed'] = False
        elif boundary == 'unknown_execution':
            record['validation'] = {'status': 'unknown'}
        elif boundary == 'identity':
            record['candidate_id'] = 'different-candidate'
        else:
            record['candidate_digest'] = 'different-digest'
    corrupt_record('parent-ws', 'reviews', review_id(qa.subtask_id), corrupt)
    task = subagent.SubagentTask(parent_task_id='parent-task', workspace_id='parent-ws',
        session_id='parent-session', profile_id='coding_agent')
    with pytest.raises(ValueError, match='stopped_known'):
        coding_team.create_assignment(task, revision(source))
