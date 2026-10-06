"""QA findings cannot be overridden by successful executable checks."""
import json
from types import SimpleNamespace

import pytest

from harness.test_coding_team import team as team
from agent.runtime.durable import coding_team, subagent
from agent.runtime.durable.coding_reviews import check_qa, review_qa_proposal
from core.tools.context import ToolRuntimeContext
from core.tools.project_execution import DockerProjectEnvironment
from storage.project_changes import project_path


def report(verdict='pass', findings=None):
    return json.dumps({'schema':'coding.qa_review.v1','verdict':verdict,'scope':'assigned candidate',
                      'blocking_findings':findings or [],'report':'Exact candidate review: module exports and API contracts.'})


def qa_runtime(monkeypatch, verdict='pass', findings=None):
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', lambda *a,**kw:
        SimpleNamespace(ok=True,final_response=report(verdict,findings),tool_calls=[]))


@pytest.mark.parametrize('verdict,findings,phase', [
    ('fail',['Build module exports are missing.'],'qa_rejected'),
    ('pass',['Build module exports are missing.'],'qa_rejected'),
    ('unknown',[],'qa_incomplete')])
def test_public_qa_failure_blocks_publication_even_when_all_checks_pass(team,monkeypatch,verdict,findings,phase):
    first=team.spawn();qa_runtime(monkeypatch,verdict,findings)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    candidate=subagent._load_task('parent-ws',first['subtask_id'])
    assert qa.status=='failed' and qa.coding['phase']==phase
    assert candidate.status=='succeeded' and candidate.coding['phase']==phase
    assert qa.coding['qa_review']['verdict']==('fail' if findings else verdict)
    assert qa.coding['environment']['cleanup_confirmed']
    assert not subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']
    assert not project_path('parent-ws','files/data/app').joinpath('src/value.py').exists()
    dependent=team.spawn(depends=[candidate.subtask_id])
    assert dependent['task_status']=='failed'
    # Read-only review may explicitly reassess known evidence; it cannot publish source.
    qa_runtime(monkeypatch)
    next_review=team.spawn('qa_agent',review=candidate.subtask_id)
    assert next_review['task_status']=='succeeded', next_review
    assert subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']


def test_legacy_test_only_qa_cannot_publish_without_typed_judgement(team):
    first=team.spawn();reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    del qa.coding['qa_review'];subagent._save_task(qa)
    result=subagent.merge_subagent_result('parent-task',first['subtask_id'],'parent-ws')
    assert result['error']=='coding_qa_verdict_required' and not result['automatic_retry_allowed']


def test_unknown_qa_checks_are_sticky_and_cannot_seed_source_repair(team,monkeypatch):
    first=team.spawn();calls=[]
    def execute(*a,**kw):
        calls.append(True)
        return {'ok':False,'execution_outcome':'unknown','execution_may_continue':True}
    monkeypatch.setattr(DockerProjectEnvironment,'execute',execute)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert qa.coding['phase']=='qa_unknown'
    assert review_qa_proposal(qa,report())['status']=='unknown'
    assert check_qa(qa)['status']=='unknown' and len(calls)==1
    repeated=team.spawn('qa_agent',review=first['subtask_id'])
    assert repeated['task_status']=='failed' and len(calls)==1
    repair=subagent.SubagentTask(parent_task_id='parent-task',workspace_id='parent-ws',session_id='parent-session',profile_id='coding_agent')
    with pytest.raises(ValueError,match='stopped_known'):
        coding_team.create_assignment(repair,{'project_dir':'files/data/app','responsibilities':['src'],
            'validation_commands':['true'],'revision_subtask_id':first['subtask_id']})


def test_qa_rejected_source_is_inherited_and_repaired_before_fresh_qa_and_merge(team,monkeypatch):
    first=team.spawn();qa_runtime(monkeypatch,'fail',['VALUE must be 43.'])
    team.spawn('qa_agent',review=first['subtask_id'])
    original=subagent._load_task('parent-ws',first['subtask_id'])
    assert original.coding['phase']=='qa_rejected'
    source=project_path(original.coding['branch_workspace'],'files/data/app')
    def repair(session,turn,**kw):
        if turn.op.runtime_control.profile['profile_id']!='qa_agent':
            branch=project_path(session.workspace_id,'files/data/app')
            assert branch.joinpath('src/value.py').read_text()=='VALUE = 42\n'
            assert 'VALUE must be 43.' in turn.op.user_input
            result=team.client.invoke('workspace.file',{'action':'edit','filepath':'files/data/app/src/value.py',
                'old_string':'42','new_string':'43'},context=ToolRuntimeContext(
                    workspace_id=session.workspace_id,session_id=session.session_id,requested_by='subagent'))
            assert result.status=='succeeded'
        return SimpleNamespace(ok=True,final_response=report(),tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',repair)
    repaired=team.client.invoke('agent.manage',{'action':'spawn','profile_id':'coding_agent','instruction':'Repair QA findings',
        'background':False,'coding_assignment':{'project_dir':'files/data/app','responsibilities':['src'],
          'validation_commands':['true'],'revision_subtask_id':first['subtask_id']}},context=team.parent).output
    assert repaired['task_status']=='succeeded',repaired
    candidate=subagent._load_task('parent-ws',repaired['subtask_id'])
    assert candidate.coding['baseline']==original.coding['baseline']=={}
    assert source.joinpath('src/value.py').read_text()=='VALUE = 42\n'
    assert not subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']
    assert team.spawn('qa_agent',review=candidate.subtask_id)['task_status']=='succeeded'
    assert subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']
    assert project_path('parent-ws','files/data/app').joinpath('src/value.py').read_text()=='VALUE = 43\n'
    from scripts.benchmark_team_acceptance import verify_team
    assert verify_team('parent-ws','parent-session','files/data/app')['status']=='PASS'


def test_invalid_public_qa_proposal_is_preserved_without_validating_candidate(team,monkeypatch):
    first=team.spawn()
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',lambda *a,**kw:
       SimpleNamespace(ok=True,final_response='Public review with no structured verdict.',tool_calls=[]))
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert qa.status=='failed' and qa.coding['qa_invalid_proposal']=='Public review with no structured verdict.'
    assert subagent._load_task('parent-ws',first['subtask_id']).coding['phase']=='qa_incomplete'


@pytest.mark.parametrize('mutation',[
    lambda review:review.pop('schema'),
    lambda review:review.update(verdict='fail'),
    lambda review:review.update(verdict='unknown'),
    lambda review:review.update(blocking_findings=['Unresolved hard failure.']),
    lambda review:review.update(candidate_digest='other-source'),
])
def test_independent_team_verifier_rejects_integration_with_invalid_qa_evidence(team,mutation):
    from scripts.benchmark_team_acceptance import verify_team
    first=team.spawn();reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    assert subagent.merge_subagent_result('parent-task',first['subtask_id'],'parent-ws')['ok']
    assert verify_team('parent-ws','parent-session','files/data/app')['status']=='PASS'
    qa=subagent._load_task('parent-ws',reviewed['subtask_id']);mutation(qa.coding['qa_review']);subagent._save_task(qa)
    with pytest.raises(AssertionError,match='independent QA verdict'):
        verify_team('parent-ws','parent-session','files/data/app')


@pytest.mark.parametrize('verdict',['fail','pass'])
def test_structured_blocking_evidence_is_preserved_and_always_rejects_candidate(team,monkeypatch,verdict):
    first=team.spawn()
    finding={'id':'F1','severity':'critical','area':'browser','title':'Missing ESM exports',
             'evidence':'index.html imports createGame; build emits an IIFE.','contract':'Actual preview must boot.'}
    qa_runtime(monkeypatch,verdict,[finding])
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert qa.coding['qa_review']['blocking_findings']==[finding]
    assert qa.coding['qa_review']['verdict']=='fail' and qa.coding['phase']=='qa_rejected'
    assert subagent._load_task('parent-ws',first['subtask_id']).coding['phase']=='qa_rejected'
    assert not subagent.merge_subagent_result('parent-task',first['subtask_id'],'parent-ws')['ok']


@pytest.mark.parametrize('finding',[None,False,{}, {'title':'missing evidence'},
    {'title':'','evidence':'observed'},{'title':'observed','evidence':'  '}])
def test_malformed_blocking_evidence_cannot_be_accepted_or_inferred(team,monkeypatch,finding):
    first=team.spawn();qa_runtime(monkeypatch,'fail',[finding])
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert qa.status=='failed' and not qa.coding.get('qa_review')
    assert qa.coding['qa_invalid_proposal']==report('fail',[finding])
    assert subagent._load_task('parent-ws',first['subtask_id']).coding['phase']=='qa_incomplete'


def test_known_qa_rejection_has_review_summary_instead_of_provider_failure(team,monkeypatch):
    first=team.spawn()
    def runtime(session,turn,**kw):
        return SimpleNamespace(ok=True,final_response=report('fail',['Real interface defect.']),tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',runtime)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert qa.status=='failed' and qa.coding['phase']=='qa_rejected'
    assert 'Independent QA verdict fail' in qa.summary and 'LLM call failed' not in qa.summary


def test_ready_unpublished_proposal_can_be_explicitly_revised_without_a_prior_qa_pass(team,monkeypatch):
    first=team.spawn();original=subagent._load_task('parent-ws',first['subtask_id'])
    assert original.coding['phase']=='changes_ready' and original.coding['completion_validation']['status']=='passed'
    source=project_path(original.coding['branch_workspace'],'files/data/app')
    def repair(session,turn,**kw):
        if turn.op.runtime_control.profile['profile_id']!='qa_agent':
            branch=project_path(session.workspace_id,'files/data/app')
            assert branch.joinpath('src/value.py').read_text()=='VALUE = 42\n'
            result=team.client.invoke('workspace.file',{'action':'edit','filepath':'files/data/app/src/value.py',
                'old_string':'42','new_string':'43'},context=ToolRuntimeContext(
                    workspace_id=session.workspace_id,session_id=session.session_id,requested_by='subagent'))
            assert result.status=='succeeded'
        return SimpleNamespace(ok=True,final_response=report(),tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',repair)
    repaired=team.client.invoke('agent.manage',{'action':'spawn','profile_id':'coding_agent','instruction':'Repair independently observed semantic failure',
        'background':False,'coding_assignment':{'project_dir':'files/data/app','responsibilities':['src'],
            'validation_commands':['true'],'revision_subtask_id':first['subtask_id']}},context=team.parent).output
    assert repaired['task_status']=='succeeded',repaired
    candidate=subagent._load_task('parent-ws',repaired['subtask_id'])
    assert candidate.coding['revision_observation']['completion_validation']['status']=='passed'
    assert candidate.coding['baseline']==original.coding['baseline']=={}
    assert source.joinpath('src/value.py').read_text()=='VALUE = 42\n'
    assert not project_path('parent-ws','files/data/app').joinpath('src/value.py').exists()
    assert not subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']
    assert team.spawn('qa_agent',review=candidate.subtask_id)['task_status']=='succeeded'
    assert subagent.merge_subagent_result('parent-task',candidate.subtask_id,'parent-ws')['ok']
    assert project_path('parent-ws','files/data/app').joinpath('src/value.py').read_text()=='VALUE = 43\n'


@pytest.mark.parametrize('mutation',['source','unknown','active','integrated'])
def test_ready_revision_rejects_tampered_unknown_active_or_published_proposals(team,mutation):
    first=team.spawn();original=subagent._load_task('parent-ws',first['subtask_id'])
    if mutation=='source':project_path(original.coding['branch_workspace'],'files/data/app').joinpath('src/value.py').write_text('tampered')
    elif mutation=='unknown':original.coding['completion_validation']['status']='unknown'
    elif mutation=='active':original.coding['environment']['closed']=False
    else:original.coding['phase']='integrated'
    subagent._save_task(original)
    task=subagent.SubagentTask(parent_task_id='parent-task',workspace_id='parent-ws',session_id='parent-session',profile_id='coding_agent')
    with pytest.raises(ValueError,match='candidate_changed|stopped_known'):
        coding_team.create_assignment(task,{'project_dir':'files/data/app','responsibilities':['src'],
            'validation_commands':['true'],'revision_subtask_id':first['subtask_id']})


def test_unchanged_revision_requires_fresh_exact_qa_instead_of_forced_edit(team,monkeypatch):
    first=team.spawn()
    qa_runtime(monkeypatch)
    repaired=team.client.invoke('agent.manage',{'action':'spawn','profile_id':'coding_agent',
        'instruction':'Reassess candidate','background':False,'coding_assignment':{
            'project_dir':'files/data/app','responsibilities':['src'],'validation_commands':['true'],
            'revision_subtask_id':first['subtask_id']}},context=team.parent).output
    task=subagent._load_task('parent-ws',repaired['subtask_id'])
    assert task.status=='succeeded' and task.coding['candidate_digest']==task.coding['revision_source_digest']
    assert not subagent.merge_subagent_result('parent-task',task.subtask_id,'parent-ws')['ok']
    assert team.spawn('qa_agent',review=task.subtask_id)['task_status']=='succeeded'
    assert subagent.merge_subagent_result('parent-task',task.subtask_id,'parent-ws')['ok']
    from scripts.benchmark_team_acceptance import verify_team
    assert verify_team('parent-ws','parent-session','files/data/app')['status']=='PASS'


def test_revision_recovery_of_known_failed_checks_can_keep_source_unchanged(team,monkeypatch):
    monkeypatch.setattr(DockerProjectEnvironment,'execute',lambda *a,**kw:{'ok':False,'exit_code':1})
    first=team.spawn()
    monkeypatch.setattr(DockerProjectEnvironment,'execute',lambda *a,**kw:{'ok':True,'exit_code':0})
    qa_runtime(monkeypatch)
    repaired=team.client.invoke('agent.manage',{'action':'spawn','profile_id':'coding_agent',
        'instruction':'Repair dependency environment','background':False,'coding_assignment':{
            'project_dir':'files/data/app','responsibilities':['src'],'validation_commands':['true'],
            'revision_subtask_id':first['subtask_id']}},context=team.parent).output
    task=subagent._load_task('parent-ws',repaired['subtask_id'])
    assert task.status=='succeeded' and task.coding['candidate_digest']==task.coding['revision_source_digest']
    assert task.coding['completion_validation']['status']=='passed'
    assert not subagent.merge_subagent_result('parent-task',task.subtask_id,'parent-ws')['ok']
    assert team.spawn('qa_agent',review=task.subtask_id)['task_status']=='succeeded'
    assert subagent.merge_subagent_result('parent-task',task.subtask_id,'parent-ws')['ok']


def test_cached_passing_checks_and_unknown_do_not_replay_execution(team,monkeypatch):
    first=team.spawn();task=subagent._load_task('parent-ws',first['subtask_id'])
    task.coding.update(revision_subtask_id='prior',revision_source_digest=task.coding['candidate_digest'],
        revision_observation={'completion_validation':{'status':'passed'}})
    def unexpected(*a,**kw):raise AssertionError('Cached checks must not execute again')
    monkeypatch.setattr(DockerProjectEnvironment,'execute',unexpected)
    assert coding_team.check_implementation(task)['status']=='passed'
    unknown={'status':'unknown','automatic_retry_allowed':False}
    task.coding['completion_validation']=unknown
    project_path(task.coding['branch_workspace'],'files/data/app').joinpath('src/value.py').write_text('changed')
    assert coding_team.check_implementation(task)==unknown



@pytest.mark.parametrize('verdict,findings,expected', [('pass', [], 'succeeded'),
    ('fail', ['Observed interface mismatch.'], 'failed'), ('unknown', [], 'failed'),
    ('pass', ['Observed interface mismatch.'], 'failed')])
def test_native_review_allows_prose_final_and_preserves_verdict(team,monkeypatch,verdict,findings,expected):
    first=team.spawn();recordings=[]
    def runtime(session,turn,**kw):
        review=json.loads(report(verdict,findings))
        # Identity values supplied by a model cannot replace the server binding.
        review.update(candidate_digest='forged',review_subtask_id='forged')
        recorded=team.client.invoke('agent.review',{'review':review},
            context=ToolRuntimeContext(workspace_id=session.workspace_id,session_id=session.session_id,
                                       requested_by='subagent'))
        recordings.append(recorded)
        assert recorded.status=='succeeded',recorded
        assert recorded.output['review']['review_subtask_id']==first['subtask_id']
        return SimpleNamespace(ok=True,final_response='自然语言 QA 报告，保留检查范围和实际发现。',tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',runtime)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    qa=subagent._load_task('parent-ws',reviewed['subtask_id'])
    assert recordings and recordings[0].status=='succeeded', recordings
    assert qa.status==expected,qa.errors
    assert qa.coding['qa_final_report']=='自然语言 QA 报告，保留检查范围和实际发现。'
    assert qa.coding['qa_review']['candidate_digest']!='forged'
    merged=subagent.merge_subagent_result('parent-task',first['subtask_id'],'parent-ws')
    assert bool(merged['ok'])==(expected=='succeeded')
    if expected=='succeeded':
        from scripts.benchmark_team_acceptance import verify_team
        assert verify_team('parent-ws','parent-session','files/data/app')['status']=='PASS'


def test_review_tool_rejects_parent_wrong_session_and_closed_binding(team,monkeypatch):
    first=team.spawn();contexts=[]
    def runtime(session,turn,**kw):
        contexts.append(ToolRuntimeContext(workspace_id=session.workspace_id,
            session_id=session.session_id,requested_by='subagent'))
        wrong=ToolRuntimeContext(workspace_id=session.workspace_id,session_id='other-session',requested_by='subagent')
        assert team.client.invoke('agent.review',{'review':json.loads(report())},context=wrong).status!='succeeded'
        # Public arguments cannot override a missing trusted session identity.
        missing=ToolRuntimeContext(workspace_id=session.workspace_id,requested_by='subagent')
        assert team.client.invoke('agent.review',{'session_id':session.session_id,
            'review':json.loads(report())},context=missing).status!='succeeded'
        return SimpleNamespace(ok=True,final_response=report(),tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',runtime)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    assert reviewed['task_status']=='succeeded',subagent._load_task('parent-ws',reviewed['subtask_id']).errors
    for context in [team.parent,contexts[0]]:
        assert team.client.invoke('agent.review',{'review':json.loads(report())},context=context).status!='succeeded'


def test_native_review_crosses_query_loop_and_governed_tool_gateway(team,monkeypatch):
    import asyncio
    from agent.llm.schemas import LLMResponse, LLMToolCall
    from agent.runtime.ssot_tools import _make_tool_handler
    from core.runtime_engine.budget_controller import BudgetController
    from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
    from core.runtime_engine.query_loop import QueryLoop
    from core.runtime_engine.tool_runtime import ToolRuntime
    from core.tools.canonical_registry import CANONICAL_REGISTRY

    first=team.spawn();observations=[]
    def runtime(session,turn,**kw):
        config=SSOTRuntimeConfig(max_llm_calls=3)
        tool_runtime=ToolRuntime(config)
        tool_runtime.register('agent.review',_make_tool_handler(client=team.client,tool_id='agent.review',
            workspace_id=session.workspace_id,session_id=session.session_id,
            run_id='local-review',trace_id='local-review',requested_by='subagent'))
        replies=iter([LLMResponse(tool_calls=[LLMToolCall(id='record',name='agent__review',
            arguments={'review':json.loads(report())})]),LLMResponse(content='Reviewed. 自然语言总结。')])
        entry=CANONICAL_REGISTRY['agent.review']
        ctx=StatelessContext(session.workspace_id,session.session_id,'local-review','Review exact candidate',extras={'caller_type':'subagent'})
        result=asyncio.run(QueryLoop(config,{'agent.review':{'description':entry.description,
            'args_schema':entry.input_schema}},tool_runtime,llm_invoke=lambda **kw:next(replies)).run(
                ctx,BudgetController(config),None))
        observations.append(result)
        return SimpleNamespace(ok=result.error is None,final_response=result.final_response,tool_calls=[])
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn',runtime)
    reviewed=team.spawn('qa_agent',review=first['subtask_id'])
    assert observations and observations[0].error is None,observations
    assert len(observations[0].tool_results)==1 and observations[0].tool_results[0].ok,observations[0].tool_results
    assert reviewed['task_status']=='succeeded',reviewed
    assert subagent.merge_subagent_result('parent-task',first['subtask_id'],'parent-ws')['ok']
