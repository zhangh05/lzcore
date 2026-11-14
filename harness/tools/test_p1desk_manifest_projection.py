"""Core ToolSpec defaults must reflect the same effective capability manifest."""
from core.tools.canonical_registry import CANONICAL_REGISTRY, to_tool_specs
from core.tools.manifest_registry import MANIFESTS
from core.tools.registry import ToolRegistry


def test_registered_core_specs_project_manifest_defaults(monkeypatch):
    import extensions.runtime
    monkeypatch.setattr(extensions.runtime, 'get_extension_tool_specs', lambda: [])
    registry = ToolRegistry()
    observed = set()
    for spec, handler in to_tool_specs():
        registry.register_tool(spec, handler)
        registered = registry.get_tool(spec.tool_id)
        manifest = MANIFESTS[spec.tool_id]
        for field in ('timeout_seconds', 'reads_artifact', 'writes_artifact'):
            assert getattr(registered, field) == getattr(manifest, field), (spec.tool_id, field)
        observed.add(spec.tool_id)
    assert observed == set(CANONICAL_REGISTRY)
