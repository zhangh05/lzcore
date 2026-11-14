"""Static checks for Python modules loaded by file rather than as packages."""

from __future__ import annotations

import ast

from extensions.manifest import ExtensionValidationError


def validate_entrypoint_source(source: str | bytes, filename: str) -> None:
    try:
        tree = ast.parse(source, filename=filename)
    except (SyntaxError, ValueError) as exc:
        raise ExtensionValidationError(f"invalid entrypoint syntax: {filename}") from exc
    if any(isinstance(node, ast.ImportFrom) and node.level for node in ast.walk(tree)):
        raise ExtensionValidationError(f"relative imports in file-loaded entrypoint: {filename}")
