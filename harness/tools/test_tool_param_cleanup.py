"""Published tool arguments must be honoured by their handlers.

memory.manage tags are stored and searchable; web.manage max_length and
system.manage status/operation were never read, so they are retired from the
schema while older saved calls keep running.
"""

import pytest

from core.tools.canonical_registry import RETIRED_ARGUMENTS, drop_retired_arguments
from core.tools.catalog_snapshot import build_catalog_snapshot
from core.tools.executor import _validate_arguments
from core.tools.schemas import ToolInvocation
from storage.memory_governance import MemoryStore, normalize_memory_tags


@pytest.fixture
def isolated_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    try:
        import core.context.context_store as context_store
        context_store._stores.clear()
    except Exception:
        pass
    return tmp_path


def _schema(tool_id: str) -> dict:
    snapshot = build_catalog_snapshot()
    tools = snapshot.get("tools") if isinstance(snapshot, dict) else snapshot
    for tool in tools:
        if tool.get("tool_id") == tool_id or tool.get("id") == tool_id:
            return tool.get("input_schema") or tool.get("parameters") or {}
    raise AssertionError(f"{tool_id} missing from catalog")


def test_normalize_memory_tags_trims_dedupes_and_bounds():
    raw = ["  BGP  ", "bgp", "", None, "x" * 50] + [f"t{i}" for i in range(20)]
    tags = normalize_memory_tags(raw)
    assert tags[0] == "BGP"
    assert "bgp" not in tags
    assert len(tags[1]) == 32
    assert len(tags) == 10
    assert normalize_memory_tags("单个") == ["单个"]
    assert normalize_memory_tags({"a": 1}) == []


def test_memory_create_stores_tags_and_search_matches_them(isolated_memory):
    from core.tools.general_tools.memory_tools import handle_memory_create, handle_memory_search

    created = handle_memory_create(ToolInvocation(
        tool_id="memory.manage", workspace_id="ws_tags",
        arguments={"action": "create", "title": "核心交换机巡检",
                   "content": "每周一上午检查核心交换机的电源与风扇告警。",
                   "tags": ["巡检", " 巡检 ", "hardware"]},
    ))
    assert created.get("ok") is not False, created
    memory_id = created.get("memory_id") or (created.get("data") or {}).get("memory_id")
    record = MemoryStore().get("ws_tags", memory_id)
    assert record.metadata["tags"] == ["巡检", "hardware"]

    hits = MemoryStore().search("ws_tags", "hardware", limit=5)
    assert [h["memory_id"] for h in hits] == [memory_id]

    found = handle_memory_search(ToolInvocation(
        tool_id="memory.manage", workspace_id="ws_tags",
        arguments={"action": "search", "query": "hardware"},
    ))
    results = found.get("results") or (found.get("data") or {}).get("results")
    assert results and results[0]["tags"] == ["巡检", "hardware"]


@pytest.mark.parametrize("tool_id, retired", sorted(RETIRED_ARGUMENTS.items()))
def test_retired_arguments_are_not_published(tool_id, retired):
    properties = _schema(tool_id).get("properties") or {}
    assert not set(retired) & set(properties)


def test_retired_arguments_are_dropped_before_validation():
    legacy = {"action": "fetch", "url": "https://example.com", "max_length": 500}
    cleaned = drop_retired_arguments("web.manage", legacy)
    assert "max_length" not in cleaned and legacy["max_length"] == 500
    assert _validate_arguments(cleaned, _schema("web.manage")) == []
    assert any("max_length" in e for e in _validate_arguments(legacy, _schema("web.manage")))

    system_call = {"action": "health", "status": "x", "operation": "y"}
    assert drop_retired_arguments("system.manage", system_call) == {"action": "health"}
    assert drop_retired_arguments("memory.manage", system_call) is system_call


def test_tags_reach_the_installed_bm25_ranker(isolated_memory):
    from agent.runtime.memory_hooks import install_memory_governance_hooks
    from core.tools.general_tools.memory_tools import handle_memory_create

    install_memory_governance_hooks()
    created = handle_memory_create(ToolInvocation(
        tool_id="memory.manage", workspace_id="ws_tags_bm25",
        arguments={"action": "create", "title": "机房温度",
                   "content": "二号机房空调在夏季需要提前开启。", "tags": ["hvac"]},
    ))
    memory_id = created.get("memory_id") or (created.get("data") or {}).get("memory_id")
    hits = MemoryStore().search("ws_tags_bm25", "hvac", limit=5)
    assert [h["memory_id"] for h in hits] == [memory_id]
