"""Extension backend entry modules are loaded by file path, not as package members.

A relative import there only fails when the code path runs, and a tool handler that
raises five times quarantines the whole extension (extensions/state.py). Guard the
entry modules statically so this cannot reach users again.
"""

import ast
from pathlib import Path
import json

import pytest

from extensions.entrypoint import validate_entrypoint_source
from extensions.manifest import ExtensionValidationError
from extensions.registry import ExtensionRegistry

ROOT = Path(__file__).resolve().parents[2] / "extensions"


def _entry_modules(registry=None):
    registry = registry or ExtensionRegistry()
    modules = {path for root in registry.roots for path in root.glob("*/backend.py")}
    for manifest in registry.discover():
        if not manifest.entrypoint:
            continue
        for root in registry.roots:
            for path in root.glob("*/extension.json"):
                if registry.load(path).extension_id == manifest.extension_id:
                    modules.add(path.parent / manifest.entrypoint.split(":", 1)[0])
    return sorted(modules)


def test_extension_entry_modules_exist():
    assert _entry_modules(), "no extension backend.py found"


def test_extension_entry_modules_use_absolute_imports():
    offenders = []
    for path in _entry_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level:
                offenders.append(f"{path}:{node.lineno}")
    assert not offenders, f"relative imports in file-loaded extension modules: {offenders}"


@pytest.mark.parametrize("entrypoint", ["hooks/main.py:register", "backend.py:register"])
def test_manifest_entrypoint_enumeration_covers_plugins_and_nested_modules(tmp_path, entrypoint):
    plugin = tmp_path / "plugins" / "sample"
    source = plugin / entrypoint.split(":")[0]
    source.parent.mkdir(parents=True)
    source.write_text("def register():\n    from .helpers import run\n    return {}\n")
    (plugin / "extension.json").write_text(json.dumps({
        "extension_id": "vendor.sample", "name": "sample", "version": "1.0.0",
        "capabilities": ["sample"], "entrypoint": entrypoint,
    }))
    modules = _entry_modules(ExtensionRegistry([tmp_path / "plugins"]))
    assert source in modules
    with pytest.raises(ExtensionValidationError, match="relative imports"):
        validate_entrypoint_source(source.read_bytes(), str(source))

