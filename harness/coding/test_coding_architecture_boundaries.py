"""Prevent the repaired entry points and dependency boundaries from regrowing."""
from pathlib import Path
import ast

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('relative,limit', [
    ('core/runtime_engine/query_loop.py', 60000),
    ('agent/runtime/ssot_runtime.py', 40000),
    ('extensions/network_operations/service.py', 20000),
])
def test_entrypoint_has_a_bounded_responsibility_budget(relative, limit):
    assert (ROOT / relative).stat().st_size <= limit, 'split by responsibility; do not increase this budget'


@pytest.mark.parametrize('relative,facade', [
    ('agent/runtime', 'ssot_runtime'),
    ('extensions/network_operations', 'service'),
    ('core/runtime_engine', 'query_loop'),
])
def test_components_never_import_their_orchestrator(relative, facade):
    prefix = {'ssot_runtime': 'ssot_', 'service': 'network_', 'query_loop': 'loop_'}[facade]
    for path in (ROOT / relative).glob(prefix + '*.py'):
        if path.stem == facade:
            continue
        tree = ast.parse(path.read_text())
        assert not any(isinstance(node, ast.ImportFrom) and (node.module or '').split('.')[-1] == facade for node in ast.walk(tree)), path.name
