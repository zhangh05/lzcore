import pytest


@pytest.fixture(autouse=True)
def _full_tool_surface(monkeypatch):
    """Prompt contracts are checked against the complete catalog.

    The live surface hides exec.run python when no runner is configured; that
    projection has its own tests (harness/tools/test_python_availability_surface.py).
    """
    monkeypatch.setattr("core.tools.python_runner.python_execution_available", lambda: True)
    from core.runtime_engine import loop_tool_catalog
    loop_tool_catalog._TOOL_DEFINITION_CACHE.clear()
