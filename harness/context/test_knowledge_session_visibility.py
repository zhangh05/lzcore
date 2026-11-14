"""Session knowledge ownership is enforced before ranking and deduplication."""

import pytest

from agent.modules.knowledge import service
from core.context.context_store import get_context_store
from core.context.unified_retriever import get_retriever


def _chunk(store, item_id, *, scope="session", metadata=None, source_id="", **extra):
    store.put({"item_id": item_id, "item_type": "knowledge_chunk", "scope": scope,
        "content": "UniqueSessionEvidence " + item_id, "metadata": metadata or {},
        "source_id": source_id, **extra})


@pytest.mark.parametrize("entry", ["generic", "knowledge", "context", "explicit"])
def test_session_owner_matches_on_every_retrieval_entry(entry, monkeypatch):
    workspace_id = "session-visibility-ws"
    store = get_context_store(workspace_id)
    _chunk(store, "owned", metadata={"session_id": "session-a"})
    retriever = get_retriever(workspace_id)
    monkeypatch.setattr(retriever, "search_memory", lambda *_a, **_k: [])
    def search(session_id):
        kwargs = {"session_id": session_id} if session_id is not None else {}
        if entry == "context":
            return retriever.retrieve_for_context("UniqueSessionEvidence", **kwargs)["knowledge_hits"]
        if entry == "explicit":
            return service.search_chunks(workspace_id, "UniqueSessionEvidence", **kwargs)["hits"]
        return (retriever.search if entry == "generic" else retriever.search_knowledge)(
            "UniqueSessionEvidence", **kwargs)
    assert len(search("session-a")) == 1
    assert search("session-b") == []
    assert search(None) == []


@pytest.mark.parametrize("location", ["chunk", "metadata", "source", "source_metadata"])
def test_legacy_scope_projections_cannot_widen_session_visibility(location):
    store = get_context_store("legacy-session-ws")
    chunk = {"scope": "workspace", "metadata": {"scope": "workspace"}}
    source = {"item_id": "source", "item_type": "knowledge_source", "scope": "workspace", "metadata": {}}
    target = {"chunk": chunk, "metadata": chunk["metadata"], "source": source,
              "source_metadata": source["metadata"]}[location]
    target.update(scope="session", session_id="session-a")
    store.put(source)
    _chunk(store, "legacy", source_id="source", **chunk)
    retriever = get_retriever("legacy-session-ws")
    assert retriever.search_knowledge("UniqueSessionEvidence", session_id="session-b") == []
    assert len(retriever.search_knowledge("UniqueSessionEvidence", session_id="session-a")) == 1


def test_missing_or_conflicting_owners_fail_closed_before_top_k_and_dedup():
    store = get_context_store("session-filter-ws")
    # All have identical content; invisible hits must not dedup the public hit.
    for i in range(30):
        _chunk(store, f"unowned-{i}", content="UniqueSessionEvidence shared document")
    store.put({"item_id": "conflicting-source", "item_type": "knowledge_source",
        "scope": "session", "metadata": {"session_id": "session-b"}})
    _chunk(store, "conflicting", source_id="conflicting-source", metadata={"session_id": "session-a"})
    _chunk(store, "public", scope="workspace", content="UniqueSessionEvidence shared document")
    retriever = get_retriever("session-filter-ws")
    for session_id in ("", "session-a", "session-b"):
        hits = retriever.search_knowledge("UniqueSessionEvidence", top_k=1, session_id=session_id)
        assert [hit["item_id"] for hit in hits] == ["public"]


def test_subagent_context_without_session_does_not_inject_foreign_knowledge():
    from agent.runtime.ssot_context import _build_retrieved_context_block
    store = get_context_store("subagent-session-ws")
    _chunk(store, "foreign-secret-document", metadata={"session_id": "session-a"})
    block = _build_retrieved_context_block(workspace_id="subagent-session-ws",
        user_input="UniqueSessionEvidence", task_id="task",
        session_id="session-b", include_workspace_memory=False)
    assert "foreign-secret-document" not in str(block)
