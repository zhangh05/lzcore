"""Extension backend entry modules are loaded by file path, not as package members.

A relative import there only fails when the code path runs, and a tool handler that
raises five times quarantines the whole extension (extensions/state.py). Guard the
entry modules statically so this cannot reach users again.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "extensions"


def _entry_modules():
    return sorted(path for path in ROOT.glob("*/backend.py"))


def test_extension_entry_modules_exist():
    assert _entry_modules(), "no extension backend.py found"


def test_extension_entry_modules_use_absolute_imports():
    offenders = []
    for path in _entry_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level:
                offenders.append(f"{path.relative_to(ROOT.parent)}:{node.lineno}")
    assert not offenders, f"relative imports in file-loaded extension modules: {offenders}"

