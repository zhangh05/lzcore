import pytest
from flask import Flask

from agent.runtime.durable import coding_project, subagent
from backend.api.state_routes import register_state_routes
from harness.test_coding_team import team as team
from storage.principal import storage_principal


def test_project_and_task_state_api_preserve_principal_workspace_session_scope(team):
    app = Flask(__name__)
    register_state_routes(app)
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    with app.test_client() as client:
        response = client.get('/api/runtime/sessions/parent-session/coding-projects?workspace_id=parent-ws')
        assert response.status_code == 200 and response.json['projects'][0]['id'] == coding_project.project_id(worker)
        assert client.get('/api/runtime/sessions/other-session/coding-projects?workspace_id=parent-ws').json['projects'] == []
        assert client.get('/api/runtime/sessions/parent-session/coding-projects').status_code == 400
        with storage_principal('unrelated-owner'):
            assert client.get('/api/runtime/sessions/parent-session/coding-projects?workspace_id=parent-ws').json['projects'] == []
            assert not client.get('/api/runtime/sessions/parent-session/task-state?workspace_id=parent-ws').json['task_state']


def test_hard_deleted_session_cannot_revive_coding_objects(team):
    from storage.session_store import delete_session_permanently
    from storage import coding_state_store
    first = team.spawn()
    worker = subagent._load_task('parent-ws', first['subtask_id'])
    team.spawn('qa_agent', review=first['subtask_id'])
    delete_session_permanently('parent-session', 'parent-ws', confirm=True)
    for kind in ['projects', 'candidates', 'reviews']:
        assert coding_state_store.list_records('parent-ws', kind) == []
    with pytest.raises(ValueError, match='coding_session_deleted'):
        coding_project.record_task(worker)


def test_http_rejects_foreign_resume_before_claiming_turn(monkeypatch):
    from backend.api.agent_routes import agent_message
    app = Flask(__name__)
    def forbidden(*args, **kwargs):
        raise AssertionError('invalid resume dispatched a worker')
    monkeypatch.setattr('jobs.lifecycle.claim_session_turn', forbidden)
    with app.test_request_context('/api/agent/message', method='POST', json={
        'workspace_id': 'parent-ws', 'session_id': 'parent-session', 'message': 'continue',
        'metadata': {'resume_task_id': 'foreign', 'client_request_id': 'request-test'},
    }):
        response, status = agent_message()
        assert status == 400 and response.json['error'] == 'INVALID_RESUME_TASK'
