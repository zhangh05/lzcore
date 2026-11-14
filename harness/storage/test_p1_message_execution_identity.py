"""Stable request projection keys and execution IDs are separate contracts."""
from types import SimpleNamespace

import pytest

from agent.core.session import AgentSession
from agent.core.turn import AgentTurn
from agent.protocol.op import AgentOp
from agent.runtime.result import AgentResult
from agent.runtime.ssot_context import _load_context_messages
from agent.runtime.ssot_persistence import _persist_inflight_user_message
from agent.runtime.turn_persistence import persist_run_record
from storage.message_store import SessionMessageStore


def turn_for(session):
    return AgentTurn.from_op(AgentOp.user_message(
        user_input="保留原始目标及约束", workspace_id=session.workspace_id,
        session_id=session.session_id, metadata={"client_request_id": "req1"},
    ))


@pytest.mark.parametrize("terminal", [True, False])
def test_request_key_survives_writers_while_history_uses_real_run_id(terminal):
    session = AgentSession(session_id="identity-session", workspace_id="identity-ws")
    turn = turn_for(session)
    _persist_inflight_user_message(session, turn, turn.op.user_input)
    store = SessionMessageStore(session.session_id, session.workspace_id)
    message_id = store.get_messages()[0]["message_id"]
    assert message_id.startswith("request_")
    if terminal:
        assert persist_run_record(session, turn, AgentResult(ok=True, final_response="done"), SimpleNamespace(metadata={}))
    users = [m for m in store.get_messages() if m["role"] == "user"]
    assert len(users) == 1
    assert users[0]["message_id"] == message_id
    assert users[0]["run_id"] == turn.turn_id
    assert users[0]["metadata"]["client_request_id"] == "req1"
    assert _load_context_messages(session)[0]["run_id"] == turn.turn_id
    from agent.app.facade import _restore_session_history
    _restore_session_history(session, session.session_id, session.workspace_id)
    assert session.history[0].run_id == turn.turn_id


def test_interrupted_request_resumes_and_coding_contract_finds_original_objective():
    from agent.runtime.task_state import begin_task_state, reconcile_active_task_states, resolve_task_state
    from agent.runtime.durable.coding_team import parent_contract

    session = AgentSession(session_id="identity-session", workspace_id="identity-ws")
    turn = turn_for(session)
    checkpoint = begin_task_state(workspace_id=session.workspace_id, session_id=session.session_id,
                                  run_id=turn.turn_id, user_input=turn.op.user_input)
    _persist_inflight_user_message(session, turn, turn.op.user_input)
    assert reconcile_active_task_states(session.workspace_id)["interrupted"] == 1
    resumed = resolve_task_state(workspace_id=session.workspace_id, session_id=session.session_id,
                                user_input="继续", messages=_load_context_messages(session))
    assert resumed and resumed["task_id"] == checkpoint["task_id"]
    task = SimpleNamespace(workspace_id=session.workspace_id, session_id=session.session_id,
                           parent_task_id=checkpoint["task_id"])
    contract = parent_contract(task)
    assert contract[0]["run_id"] == turn.turn_id and contract[0]["content"] == turn.op.user_input
    assert parent_contract(task, references=contract) == contract


def test_legacy_request_without_execution_link_does_not_guess_run_identity():
    from agent.runtime.task_state import begin_task_state, reconcile_active_task_states, resolve_task_state
    session = AgentSession(session_id="legacy-session", workspace_id="identity-ws")
    task = begin_task_state(workspace_id=session.workspace_id, session_id=session.session_id,
                            run_id="real-run", user_input="original")
    SessionMessageStore(session.session_id, session.workspace_id).write_message(
        "request_legacy", "user", "original", {"client_request_id": "req-legacy"})
    reconcile_active_task_states(session.workspace_id)
    messages = _load_context_messages(session)
    assert resolve_task_state(workspace_id=session.workspace_id, session_id=session.session_id,
                              user_input="继续", messages=messages) is None
    assert resolve_task_state(workspace_id=session.workspace_id, session_id=session.session_id,
                              user_input="继续", messages=messages, resume_task_id=task["task_id"])


def test_rewind_keeps_request_message_identity_and_execution_link():
    from storage.session_snapshot import _apply_rewind
    session = AgentSession(session_id="identity-session", workspace_id="identity-ws")
    turn = turn_for(session)
    _persist_inflight_user_message(session, turn, turn.op.user_input)
    store = SessionMessageStore(session.session_id, session.workspace_id)
    before = store.get_messages()
    _apply_rewind(session.workspace_id, session.session_id, before)
    after = store.get_messages()
    assert after[0]["message_id"] == before[0]["message_id"]
    assert after[0]["run_id"] == turn.turn_id
    _persist_inflight_user_message(session, turn, turn.op.user_input)
    assert len(store.get_messages()) == 1
