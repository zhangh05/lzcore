"""S2 knowledge generation publication and duplicate-identity regressions."""
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest


@pytest.fixture
def knowledge_store(tmp_path, monkeypatch):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    monkeypatch.setenv('LZCORE_WORKSPACE_DIR', str(tmp_path))
    from core.context.context_store import get_context_store
    return get_context_store('s2')


def chunk(identity, content='body', source_id='ksrc_s2'):
    from agent.modules.knowledge.schemas import KnowledgeChunk
    return KnowledgeChunk(chunk_id=identity, source_id=source_id, content=content, index_text=content)


def test_knowledge_replacement_write_failure_keeps_old_searchable(knowledge_store, monkeypatch):
    from agent.modules.knowledge.index import replace_chunks, search_chunks, list_chunks
    from storage import records
    replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'OriginalUniqueMarker')])
    original_bytes = knowledge_store._items_path.read_bytes()
    original = records.atomic_write_text
    attempted = []
    def fail_write(path, text):
        if path == knowledge_store._items_path:
            attempted.append(text)
            raise OSError('injected generation write failure')
        return original(path, text)
    monkeypatch.setattr(records, 'atomic_write_text', fail_write)
    with pytest.raises(OSError):
        replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'NewUniqueMarker'), chunk('new')])
    assert attempted and 'NewUniqueMarker' in attempted[0]
    assert knowledge_store._items_path.read_bytes() == original_bytes
    assert list_chunks('s2')['chunks'][0]['content'] == 'OriginalUniqueMarker'
    assert search_chunks('s2', 'OriginalUniqueMarker')['hits'][0]['content'] == 'OriginalUniqueMarker'
    assert search_chunks('s2', 'NewUniqueMarker')['hits'] == []


def test_knowledge_replacement_changes_generation_without_exposing_mixed_chunks(knowledge_store):
    from agent.modules.knowledge.index import replace_chunks, search_chunks
    replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'OldUniqueMarker'), chunk('removed')])
    old_generation = knowledge_store.get('kc_stable')['metadata']['index_generation']
    assert search_chunks('s2', 'OldUniqueMarker')['hits']
    result = replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'NewUniqueMarker'), chunk('added', 'NewUniqueMarker')])
    assert result == {'ok': True, 'source_id': 'ksrc_s2', 'replaced': 2, 'new_count': 2}
    live = knowledge_store.list_items(item_type='knowledge_chunk', limit=None)
    assert {c['chunk_id'] for c in live} == {'stable', 'added'}
    generations = {c['metadata']['index_generation'] for c in live}
    assert len(generations) == 1 and old_generation not in generations
    assert not search_chunks('s2', 'OldUniqueMarker')['hits']
    assert search_chunks('s2', 'NewUniqueMarker')['hits']


def test_knowledge_replacement_has_no_old_chunk_page_limit(knowledge_store):
    from agent.modules.knowledge.index import replace_chunks
    many = [chunk(f'old_{i}') for i in range(10005)]
    assert replace_chunks('s2', 'ksrc_s2', many)['new_count'] == 10005
    assert replace_chunks('s2', 'ksrc_s2', [])['replaced'] == 10005
    assert knowledge_store.list_items(item_type='knowledge_chunk', limit=None) == []


@pytest.mark.parametrize('method', ['save_chunks', 'replace_chunks', 'put_many'])
def test_knowledge_duplicate_batch_is_rejected_before_any_write(knowledge_store, method):
    from agent.modules.knowledge.index import save_chunks, replace_chunks
    knowledge_store.put({'item_id': 'source', 'item_type': 'knowledge_source', 'content': 'keep'})
    before = knowledge_store._items_path.read_bytes()
    with pytest.raises(ValueError, match='duplicate'):
        if method == 'save_chunks':
            save_chunks('s2', [chunk('same', 'first'), chunk('same', 'second')])
        elif method == 'replace_chunks':
            replace_chunks('s2', 'ksrc_s2', [chunk('same', 'first'), chunk('same', 'second')])
        else:
            knowledge_store.put_many([{'item_id': 'same', 'content': 'first'},
                                      {'item_id': 'same', 'content': 'second'}])
    assert knowledge_store._items_path.read_bytes() == before


@pytest.mark.parametrize('new_type', ['knowledge_chunk', 'profile'])
def test_context_store_existing_chunk_id_cannot_be_overwritten(knowledge_store, new_type):
    knowledge_store.put({'item_id': 'same', 'item_type': 'knowledge_chunk', 'content': 'original'})
    before = knowledge_store._items_path.read_bytes()
    with pytest.raises(ValueError, match='duplicate'):
        knowledge_store.put({'item_id': 'same', 'item_type': new_type, 'content': 'overwrite'})
    assert knowledge_store._items_path.read_bytes() == before
    # Other ContextStore types retain the existing upsert contract.
    knowledge_store.put({'item_id': 'source', 'item_type': 'knowledge_source', 'content': 'v1'})
    knowledge_store.put({'item_id': 'source', 'item_type': 'knowledge_source', 'content': 'v2'})
    assert knowledge_store.get('source')['content'] == 'v2'


def test_knowledge_replacement_rejects_cross_source_identity(knowledge_store):
    from agent.modules.knowledge.index import replace_chunks
    replace_chunks('s2', 'ksrc_other', [chunk('owned', 'keep', 'ksrc_other')])
    with pytest.raises(ValueError):
        replace_chunks('s2', 'ksrc_s2', [chunk('owned', 'overwrite')])
    assert knowledge_store.get('kc_owned')['content'] == 'keep'
    with pytest.raises(ValueError):
        replace_chunks('s2', 'ksrc_s2', [chunk('wrong_source', source_id='ksrc_other')])


def test_knowledge_concurrent_rebuilds_publish_one_complete_generation(knowledge_store):
    from agent.modules.knowledge.index import replace_chunks
    barrier = threading.Barrier(2)
    def rebuild(label):
        barrier.wait(timeout=5)
        replace_chunks('s2', 'ksrc_s2', [chunk(f'{label}_{i}', label) for i in range(3)])
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(rebuild, ['generation_a', 'generation_b']))
    live = knowledge_store.list_items(item_type='knowledge_chunk', limit=None)
    assert len(live) == 3
    assert len({c['content'] for c in live}) == 1
    assert len({c['metadata']['index_generation'] for c in live}) == 1


def test_chunk_mixed_long_short_sections_have_unique_ids_and_all_bodies(knowledge_store):
    from agent.modules.knowledge.chunking import chunk_document
    from agent.modules.knowledge.schemas import NormalizedDocument
    from agent.modules.knowledge.index import save_chunks, search_chunks
    document = NormalizedDocument(
        source_id='ksrc_synthetic', title='Mixed document',
        normalized_markdown='# Long\n\n' + 'a' * 2000 + '\n\n' + 'b' * 2000
                            + '\n\n# Short\n\nUniqueTail\n\n# Unaffected\n\nStableTail',
    )
    parents, children = chunk_document(document)
    all_chunks = parents + children
    assert len({c.chunk_id for c in all_chunks}) == len(all_chunks)
    assert [c.chunk_index for c in parents] == list(range(len(parents)))
    assert [c.chunk_index for c in children] == list(range(len(children)))
    assert next(c for c in children if 'StableTail' in c.content).chunk_id == 'kch_synthetic_c00002_0'
    assert save_chunks('s2', all_chunks) == len(all_chunks)
    live = knowledge_store.list_items(item_type='knowledge_chunk', limit=None)
    assert len(live) == len(all_chunks)
    for text in ('a' * 2000, 'b' * 2000, 'UniqueTail', 'StableTail'):
        assert any(text in c['content'] for c in live if c['chunk_type'] == 'child')
    assert search_chunks('s2', 'UniqueTail')['hits']


def test_knowledge_reindex_failure_uses_atomic_replacement(knowledge_store, monkeypatch):
    from agent.modules.knowledge import ingestion, index
    from storage import records
    index.replace_chunks('s2', 'ksrc_s2', [chunk('old', 'still searchable')])
    before = knowledge_store._items_path.read_bytes()
    monkeypatch.setattr(ingestion._store, 'read_source', lambda *a: {
        'content': '# Revised\n\nNew text', 'title': 'Revised', 'metadata': {},
    })
    monkeypatch.setattr(records, 'atomic_write_text', lambda *a: (_ for _ in ()).throw(OSError('fault')))
    with pytest.raises(OSError):
        ingestion.reindex_source('s2', 'ksrc_s2')
    assert knowledge_store._items_path.read_bytes() == before


def test_context_store_explicit_chunk_updates_preserve_body_and_reject_collisions(knowledge_store):
    from agent.modules.knowledge.index import replace_chunks
    from agent.modules.knowledge.store import rename_source, disable_source
    knowledge_store.put({'item_id': 'ksrc_s2', 'item_type': 'knowledge_source', 'content': 'preview'})
    replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'original')])
    assert rename_source('s2', 'ksrc_s2', 'New title')['title'] == 'New title'
    assert knowledge_store.get('kc_stable')['title'] == 'New title'
    assert disable_source('s2', 'ksrc_s2')['enabled'] is False
    assert knowledge_store.get('kc_stable')['disabled'] is True
    assert disable_source('s2', 'ksrc_s2', False)['enabled'] is True
    changed = knowledge_store.get('kc_stable')
    changed['content'] = 'overwrite'
    with pytest.raises(ValueError, match='cannot change'):
        knowledge_store.update_knowledge_chunks([changed])
    assert knowledge_store.get('kc_stable')['content'] == 'original'
    with pytest.raises(ValueError, match='duplicate'):
        knowledge_store.put_many([knowledge_store.get('kc_stable')])


def test_knowledge_post_replace_durability_error_restores_old_generation(knowledge_store, monkeypatch):
    from agent.modules.knowledge.index import replace_chunks
    from storage import atomic_io
    replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'OriginalUniqueMarker')])
    before = knowledge_store._items_path.read_bytes()
    def fail_fsync(path):
        raise OSError('injected directory fsync error after replacement')
    monkeypatch.setattr(atomic_io, '_fsync_parent_directory', fail_fsync)
    with pytest.raises(OSError):
        replace_chunks('s2', 'ksrc_s2', [chunk('stable', 'NewUniqueMarker')])
    assert knowledge_store._items_path.read_bytes() == before
