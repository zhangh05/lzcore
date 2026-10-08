"""Canonical memory, exact archive evidence and interrupted publication contracts."""
import json
from types import SimpleNamespace

import pytest
from flask import Flask

from agent.runtime.memory_write import consolidator, event_log
from agent.runtime.ssot_context import _build_retrieved_context_block
from core.context.unified_retriever import UnifiedRetriever
from storage.context_epoch_store import save_epoch, search_epochs, read_message_chunk
from storage.memory_event_store import read_cursor
from storage.memory_governance import MemoryRecord, MemoryStore, MemoryWriteGate, confirm_memory, expire_memory
from storage.principal import storage_principal


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    return MemoryStore()


def create(store, content='规则原文', **kwargs):
    record = MemoryRecord(workspace_id='project-a', status='active', source='user',
                          memory_type='core_rule', content=content, summary=content, **kwargs)
    assert MemoryWriteGate(store).write(record)['ok']
    return record


def test_project_and_personal_scopes_preserve_owner_boundary(store):
    private = create(store)
    personal = create(store, '个人偏好', scope='global')
    assert store.get('project-b', private.memory_id) is None
    assert store.get('project-b', personal.memory_id)
    assert not store.delete_file('project-b', private.memory_id)
    assert [r['memory_id'] for r in store.list_retrievable('project-b')] == [personal.memory_id]
    with storage_principal('another-person'):
        assert MemoryStore().list_all('project-a') == []


def test_one_time_migration_is_explicit_and_preserves_full_data(store):
    record = MemoryRecord(workspace_id='project-a', status='active', source='user',
        content='以前按用户共享的完整偏好', memory_type='core_rule', metadata={'generation_origin':'user_memory_command'})
    data = record.to_dict(); data.pop('schema_version')
    root = store._dir('project-a'); root.mkdir(parents=True)
    path = root / (record.memory_id + '.json'); path.write_text(json.dumps(data))
    loaded = store.get('project-b', record.memory_id)
    assert loaded.scope == 'global' and loaded.content == record.content
    first = path.read_bytes()
    assert store.get('project-a', record.memory_id).schema_version == 2
    assert path.read_bytes() == first
    ordinary = MemoryRecord(workspace_id='project-a', status='active', content='项目事实')
    data = ordinary.to_dict(); data.pop('schema_version')
    (root/(ordinary.memory_id+'.json')).write_text(json.dumps(data))
    assert store.get('project-b', ordinary.memory_id) is None


def test_stale_projection_never_revives_after_failed_projection_hook(store, monkeypatch):
    record = create(store, '过期原文 SENTINEL')
    retriever = UnifiedRetriever('project-a')
    assert retriever.search_memory('SENTINEL')
    def fail(_record): raise OSError('projection unavailable')
    monkeypatch.setattr('storage.memory_governance._projection_hook', fail)
    expire_memory('project-a', record.memory_id)
    assert retriever.search_memory('SENTINEL') == []


def test_revision_publication_fault_never_injects_both_rules(store, monkeypatch):
    old = create(store, '以后默认自动推送提交')
    original = store._save
    def fail_cleanup(record):
        if record.memory_id == old.memory_id and record.status == 'expired': raise OSError('retirement failed')
        original(record)
    monkeypatch.setattr(store, '_save', fail_cleanup)
    newer = MemoryRecord(workspace_id='project-a', status='active', source='user', memory_type='core_rule',
        content='以后不要自动推送提交', metadata={'supersedes_memory_id':old.memory_id})
    with pytest.raises(OSError): MemoryWriteGate(store).write(newer)
    assert store.get('project-a', old.memory_id).status == 'active'
    assert [r['memory_id'] for r in store.list_retrievable('project-a')] == [newer.memory_id]
    # Only readback is needed; the gate never repeats an existing identity.
    assert MemoryWriteGate(store).write(newer)['reconciled']


def test_confirm_exact_target_without_semantic_key(store):
    old = create(store, '中文回复')
    candidate = MemoryRecord(workspace_id='project-a', memory_type='core_rule', content='以后请使用英文进行完整回复',
        source='agent_suggestion', metadata={'supersedes_memory_id':old.memory_id})
    result = MemoryWriteGate(store).write(candidate)
    assert result['status'] == 'conflict'
    assert confirm_memory('project-a', candidate.memory_id)['ok']
    assert store.get('project-a', old.memory_id).status == 'expired'
    assert [r['memory_id'] for r in store.list_retrievable('project-a')] == [candidate.memory_id]


def test_revision_cannot_cross_transient_scope_or_project(store):
    old = create(store, scope='session', session_id='other-session')
    candidate = MemoryRecord(workspace_id='project-a', scope='session', session_id='this-session',
        memory_type='core_rule', content='另一个规则', source='user',
        metadata={'supersedes_memory_id':old.memory_id})
    assert MemoryWriteGate(store).write(candidate)['error'] == 'invalid_memory_revision_target'
    candidate.workspace_id='project-b'; candidate.session_id='other-session'
    assert MemoryWriteGate(store).write(candidate)['error'] == 'invalid_memory_revision_target'


def test_governing_rules_survive_index_outage_and_context_rollover(store, monkeypatch):
    rule = create(store, '完整核心规则' * 100 + '结尾约束')
    def fail(*_a): raise OSError('index unavailable')
    monkeypatch.setattr('core.context.unified_retriever.get_retriever', fail)
    anchors = []
    block = _build_retrieved_context_block(workspace_id='project-a', session_id='session', task_id='task',
        user_input='继续', max_tokens=1, governing_rules=anchors)
    assert rule.content in block and rule.content in '\n'.join(anchors)
    assert 'context_load_failed' in block
    from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
    from core.runtime_engine.query_loop import QueryLoop
    loop = QueryLoop(SSOTRuntimeConfig(), {}, object())
    ctx = StatelessContext(workspace_id='project-a', session_id='session', request_id='request', user_input='继续',
        extras={'retrieved_context_block':block, 'governing_memory_block':'\n'.join(anchors)})
    assert rule.content in str(loop._build_initial(ctx, include_history=False))


def test_related_memory_selection_is_budgeted_by_complete_record_not_top_three(store):
    for i in range(8):
        record = MemoryRecord(workspace_id='project-a', status='active', content=f'设备检索 {i}', memory_type='semantic_fact')
        store._save(record)
    text = _build_retrieved_context_block(workspace_id='project-a', session_id='session', task_id='task', user_input='设备检索', max_tokens=3000)
    assert all(f'设备检索 {i}' in text for i in range(8))
    small = _build_retrieved_context_block(workspace_id='project-a', session_id='session', task_id='task', user_input='设备检索', max_tokens=1)
    assert 'memory_retrieval_coverage' in small and '设备检索' not in small


def api_app():
    from backend.api import memory
    app=Flask(__name__)
    app.add_url_rule('/write', view_func=memory.handle_memory_write, methods=['POST'])
    app.add_url_rule('/get/<memory_id>', view_func=memory.handle_memory_get)
    app.add_url_rule('/list', view_func=memory.handle_memory_list)
    app.add_url_rule('/search', view_func=memory.handle_memory_search, methods=['POST'])
    return app.test_client()


def test_api_full_text_revision_readback_filters_and_paging(store):
    client=api_app(); content='完整正文' * 1000 + '末尾约束'
    args=dict(workspace_id='project-a', title='长记忆', content=content, user_confirmed=True)
    first=client.post('/write', json=args).get_json()
    assert first['ok']
    read=client.get('/get/'+first['memory_id']+'?workspace_id=project-a').get_json()['record']
    assert read['content'] == content
    assert client.get('/get/'+first['memory_id']+'?workspace_id=project-b').status_code == 404
    revision=client.post('/write', json={**args, 'content':'新版约束', 'supersedes_memory_id':first['memory_id']}).get_json()
    assert revision['ok'] and revision['memory_id'] != first['memory_id']
    rows=client.get('/list?workspace_id=project-a&limit=1').get_json()
    assert rows['total'] == 1 and rows['next_offset'] is None
    history=client.get('/list?workspace_id=project-a&include_deleted=true&limit=1').get_json()
    assert history['total'] == 2 and history['next_offset'] == 1
    second=client.get('/list?workspace_id=project-a&include_deleted=true&limit=1&offset=1').get_json()
    assert len(second['records']) == 1
    personal=client.post('/write', json={**args, 'scope':'global'}).get_json()
    result=client.post('/search', json={'workspace_id':'project-b', 'query':'末尾约束', 'scope':'global'}).get_json()
    assert [r['memory_id'] for r in result['results']] == [personal['memory_id']]


def test_write_failure_returns_unknown_id_for_readback(store, monkeypatch):
    from storage import memory_governance as governance
    original=governance.MemoryStore._save
    def save_then_fail(self, record): original(self, record); raise OSError('response uncertain')
    monkeypatch.setattr(governance.MemoryStore, '_save', save_then_fail)
    client=api_app()
    result=client.post('/write', json={'workspace_id':'project-a','title':'未知写入','content':'完整正文','user_confirmed':True})
    assert result.status_code == 409
    data=result.get_json(); assert data['status'] == 'execution_unknown'
    assert client.get('/get/'+data['memory_id']+'?workspace_id=project-a').get_json()['record']['content'] == '完整正文'


@pytest.mark.parametrize('tool_ok', [True, False])
def test_only_exact_dated_observations_can_auto_activate(store, tool_ok):
    event=event_log.append_experience(workspace_id='project-a',session_id='session',task_id='task',user_input='核查',assistant_response='',
        tool_calls=[{'tool_id':'workspace.file','ok':tool_ok,'summary':'文件读取观察原文'}],task_ok=False)
    proposal={'action':'create','memory_type':'episodic_case','scope':'workspace','content':'文件读取观察原文','summary':'文件读取历史观察',
        'score':5,'confidence':1,'evidence_event_ids':[event['event_id']],
        'evidence_quote':{'event_id':event['event_id'],'tool_index':0,'quote':'文件读取观察原文'}}
    valid=consolidator._apply(proposal,'project-a','session','task',[event],store)
    assert valid['status'] == 'active'
    record=store.get('project-a',valid['memory_id'])
    assert event['created_at'] in record.content
    assert ('工具执行成功' if tool_ok else '工具执行失败') in record.content
    invalid=consolidator._apply({**proposal,'content':'全体设备健康，业务验证完成'},'project-a','session','task',[event],store)
    assert invalid['status'] == 'pending'
    mismatch={**proposal,'evidence_quote':{**proposal['evidence_quote'],'quote':'伪造原文'}}
    assert consolidator._apply(mismatch,'project-a','session','task',[event],store)['status'] == 'pending'
    cross=consolidator._apply(proposal,'project-a','another-session','task',[event],store)
    assert cross['status'] == 'pending'


def test_generated_retirement_requires_confirmation(store):
    old=MemoryRecord(workspace_id='project-a',status='active',content='历史观察',memory_type='episodic_case',source='agent_suggestion')
    store._save(old)
    proposal={'action':'expire','target_memory_id':old.memory_id,'score':5,'reason':'过时'}
    result=consolidator._apply(proposal,'project-a','session','task',[],store)
    assert result['status'] == 'conflict' and store.get('project-a',old.memory_id).status == 'active'
    assert confirm_memory('project-a',result['memory_id'])['status'] == 'expired'
    assert store.get('project-a',old.memory_id).status == 'expired'


def test_unknown_reflection_write_is_read_back_and_not_replayed(store, monkeypatch):
    monkeypatch.setattr('storage.memory_governance.is_auto_memory_enabled',lambda _ws:True)
    event=event_log.append_experience(workspace_id='project-a',session_id='session',task_id='task',user_input='核查',assistant_response='',tool_calls=[],task_ok=True)
    proposal={'action':'create','memory_type':'semantic_fact','scope':'workspace','content':'未经核实的稳定事实候选','summary':'候选', 'score':5,'confidence':1}
    reflections=[]
    monkeypatch.setattr(consolidator,'_reflect',lambda *_a:reflections.append(True) or [proposal])
    calls=[]; original=consolidator._apply
    def fail(*args):
        calls.append(True); original(*args); raise OSError('outcome unknown')
    monkeypatch.setattr(consolidator,'_apply',fail)
    args=dict(workspace_id='project-a',session_id='session',task_id='task')
    assert consolidator.consolidate_experiences(**args)['status'] == 'retry_pending'
    assert consolidator.consolidate_experiences(**args)['status'] == 'processed'
    assert len(calls) == len(reflections) == 1
    assert read_cursor('project-a','session')['processed_event_ids'] == [event['event_id']]


def test_unknown_missing_reflection_write_stays_unresolved(store, monkeypatch):
    monkeypatch.setattr('storage.memory_governance.is_auto_memory_enabled',lambda _ws:True)
    event_log.append_experience(workspace_id='project-a',session_id='session',task_id='task',user_input='核查',assistant_response='',tool_calls=[],task_ok=True)
    proposal={'action':'create','memory_type':'semantic_fact','content':'未写入候选','summary':'候选','score':5,'confidence':1}
    monkeypatch.setattr(consolidator,'_reflect',lambda *_a:[proposal])
    calls=[]
    def fail(*args): calls.append(True); raise OSError('unknown')
    monkeypatch.setattr(consolidator,'_apply',fail)
    args=dict(workspace_id='project-a',session_id='session',task_id='task')
    assert consolidator.consolidate_experiences(**args)['status'] == 'retry_pending'
    assert consolidator.consolidate_experiences(**args)['status'] == 'retry_pending'
    assert len(calls) == 1


def test_archive_chinese_search_exact_readback_pagination_alias_and_scope(store):
    common={'role':'user','content':'业务核查的完整原文' * 300 + '原文结尾'}
    first=save_epoch('project-a','session','request-1',[common,{'role':'tool','content':'另一条业务核查证据','tool_call_id':'call-1'}],{})
    second=save_epoch('project-a','session','request-2',[common],{},parent_id=first['checkpoint_id'])
    result=search_epochs('project-a','session','业务核查',limit=1)
    assert result['total'] == 2 and result['next_offset'] == 1
    row=result['records'][0]
    chunk=read_message_chunk('project-a','session',row['checkpoint_id'],row['message_index'],row['char_offset'],row['char_limit'])
    assert chunk['text_chunk'] == row['excerpt']
    alias=search_epochs('project-a','session','业务核查',checkpoint_id=second['checkpoint_id'])
    assert alias['total'] == 1 and alias['records'][0]['checkpoint_id'] == second['checkpoint_id']
    assert search_epochs('project-a','another-session','业务核查')['total'] == 0
    with storage_principal('another-person'):
        assert search_epochs('project-a','session','业务核查')['total'] == 0


def test_archive_derived_index_damage_rebuilds_but_archive_tamper_fails(store):
    from storage.records import workspace_record_dir
    record=save_epoch('project-a','session','request',[{'role':'user','content':'原文证据'}],{})
    assert search_epochs('project-a','session','原文证据')['total'] == 1
    root=workspace_record_dir('project-a','sessions','session','context_epochs')
    (root/'search.sqlite').write_bytes(b'corrupt derived projection')
    assert search_epochs('project-a','session','原文证据')['total'] == 1
    path=root/(record['checkpoint_id']+'.json')
    value=json.loads(path.read_text()); value['payload']['messages'][0]['content']='改写证据'
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError,match='integrity_failed'):
        search_epochs('project-a','session','改写证据')


def test_candidate_edit_keeps_complete_revision_chain(store):
    from core.tools.general_tools.memory_tools import handle_memory_update
    from core.tools.schemas import ToolInvocation
    old=create(store,'原来的完整核心规则：先核对提交。')
    candidate=MemoryRecord(workspace_id='project-a',memory_type='core_rule',source='agent_suggestion',
        content='候选规则完整正文：提交后核对。',metadata={'supersedes_memory_id':old.memory_id})
    assert MemoryWriteGate(store).write(candidate)['status']=='conflict'
    result=handle_memory_update(ToolInvocation(tool_id='memory.manage',workspace_id='project-a',
        arguments={'memory_id':candidate.memory_id,'content':'修改候选完整正文：发布前核对。'}))
    assert result['ok'] and result['memory_id'] != candidate.memory_id
    assert confirm_memory('project-a',result['memory_id'])['ok']
    assert store.get('project-a',old.memory_id).status=='expired'
    assert [r['memory_id'] for r in store.list_retrievable('project-a')]==[result['memory_id']]


def test_tool_confirmation_never_claims_personal_user_review(store):
    from core.tools.general_tools.memory_tools import handle_memory_confirm
    from core.tools.schemas import ToolInvocation
    record=MemoryRecord(workspace_id='project-a',source='agent_suggestion',content='完整待确认规则正文',memory_type='core_rule')
    assert MemoryWriteGate(store).write(record)['status']=='pending'
    result=handle_memory_confirm(ToolInvocation(tool_id='memory.manage',workspace_id='project-a',arguments={'memory_id':record.memory_id}))
    assert result['ok']
    assert store.get('project-a',record.memory_id).metadata['authority']=='operator_confirm'
