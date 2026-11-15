"""Model-visible exec.run must not offer action=python when no runner can execute it."""
from core.runtime_engine import loop_tool_catalog
from core.tools import python_runner
from core.tools.canonical_registry import CANONICAL_REGISTRY


def _exec_def(monkeypatch, available: bool) -> dict:
    monkeypatch.setattr(python_runner, "python_execution_available", lambda: available)
    loop_tool_catalog._TOOL_DEFINITION_CACHE.clear()
    registry = {"exec.run": CANONICAL_REGISTRY["exec.run"]}
    [tool] = loop_tool_catalog._build_cached_tool_definitions(registry)
    return tool["function"]


def test_python_hidden_when_unavailable(monkeypatch):
    fn = _exec_def(monkeypatch, available=False)
    props = fn["parameters"]["properties"]
    assert props["action"]["enum"] == ["shell", "slash"]
    assert "code" not in props and "input_data" not in props
    assert "not available" in fn["description"]
    assert "python=>" not in fn["description"]


def test_python_offered_when_available(monkeypatch):
    fn = _exec_def(monkeypatch, available=True)
    props = fn["parameters"]["properties"]
    assert "python" in props["action"]["enum"]
    assert "code" in props


def test_canonical_registry_is_not_mutated(monkeypatch):
    _exec_def(monkeypatch, available=False)
    schema = CANONICAL_REGISTRY["exec.run"].input_schema
    assert "python" in schema["properties"]["action"]["enum"]
    assert "code" in schema["properties"]
