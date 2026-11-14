from __future__ import annotations

import json

import pytest

from extensions import runtime
from extensions.registry import ExtensionRegistry
from extensions.state import get_extension_state


@pytest.mark.parametrize("problem", ["incompatible", "missing", "import", "contribution", "malformed", "tool_conflict"])
def test_bad_optional_extension_does_not_prevent_loading_healthy_extensions(monkeypatch, tmp_path, problem):
    root = tmp_path / "plugins"
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    for identifier in ("bad.sample", "healthy.sample"):
        source = root / identifier
        source.mkdir(parents=True)
        manifest = {"extension_id": identifier, "name": identifier, "version": "1.0.0", "capabilities": ["test"]}
        if identifier == "bad.sample":
            if problem == "incompatible":
                manifest["min_platform_version"] = "99.0.0"
            elif problem != "malformed":
                manifest["entrypoint"] = "hooks/main.py:register"
                hook = source / "hooks" / "main.py"
                hook.parent.mkdir()
                if problem == "import":
                    hook.write_text("raise RuntimeError('synthetic import failure')\n")
                elif problem == "contribution":
                    hook.write_text("def register():\n    return {'register_routes': 42}\n")
                elif problem == "tool_conflict":
                    hook.write_text("def register():\n    return {}\n")
        (source / "extension.json").write_text("bad-json" if identifier == "bad.sample" and problem == "malformed"
                                                 else json.dumps(manifest))

    class IsolatedRegistry(ExtensionRegistry):
        def __init__(self):
            super().__init__([root])

    monkeypatch.setattr(runtime, "ExtensionRegistry", IsolatedRegistry)
    if problem == "tool_conflict":
        from types import SimpleNamespace
        from core.tools.canonical_registry import CANONICAL_REGISTRY
        core_tool_id = next(iter(CANONICAL_REGISTRY))
        monkeypatch.setattr(runtime, "_build_tools", lambda manifest, contribution:
                            ((SimpleNamespace(tool_id=core_tool_id), lambda _: {}),)
                            if manifest.extension_id == "bad.sample" else ())
    runtime.reset_extension_cache_for_tests()
    try:
        loaded = runtime.load_extensions(refresh=True)
        assert [item.manifest.extension_id for item in loaded] == ["healthy.sample"]
        assert runtime._LOAD_ERRORS
        catalog = runtime.public_extension_catalog()
        assert any(item["extension_id"] == "healthy.sample" for item in catalog)
        if problem != "malformed":
            state = get_extension_state("bad.sample")
            assert not state["enabled"] and state["status"] == "quarantined"
        if problem in {"incompatible", "malformed"}:
            from backend.main import create_app
            monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
            client = create_app().test_client()
            response = client.get("/api/extensions")
            assert response.status_code == 200
            assert any(item["extension_id"] == "healthy.sample" for item in response.json["extensions"])
    finally:
        runtime.reset_extension_cache_for_tests()
