# harness/test_doc_cleanup_current_architecture.py
"""Documentation checks for current runtime architecture."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS = [
    ROOT / "README.md",
    ROOT / "DESIGN.md",
    ROOT / "docs" / "ARCHITECTURE.md",
    ROOT / "docs" / "API.md",
    ROOT / "docs" / "FRONTEND.md",
    ROOT / "docs" / "backend" / "API_CONTRACT.md",
    ROOT / "docs" / "storage" / "STORAGE_BOUNDARIES.md",
]

REQUIRED_TERMS = [
    "AgentResult",
    "workspace_id",
    "Zustand",
    "WebSocket",
]

STALE_TERMS = [
    "Python 3.13",
    "max 8 steps",
    "history window (k=8)",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_current_docs_exist_and_are_not_empty():
    for path in DOCS:
        assert path.exists(), str(path)
        assert _read(path).strip(), str(path)


def test_docs_reference_current_architecture():
    combined = "\n".join(_read(path) for path in DOCS)
    for term in REQUIRED_TERMS:
        assert term in combined, f"Required term '{term}' not found in docs"


def test_docs_have_no_stale_content():
    combined = "\n".join(_read(path) for path in DOCS)
    for term in STALE_TERMS:
        assert term not in combined, f"Stale term '{term}' found in docs"


def test_docs_match_current_stack():
    combined = "\n".join(_read(path) for path in DOCS)
    assert "Python 3.12+" in combined
    assert "/api/tools/catalog" in combined
    assert "/api/tools/invoke" not in combined
    # Verify named tools, not a coincidental/stale count elsewhere in prose.
    from core.tools.tool_namespace import TOOL_NAMESPACE
    for tool_id in TOOL_NAMESPACE:
        assert tool_id in combined, f"Undocumented canonical tool: {tool_id}"
