"""Bare relative paths resolve to files/data, matching exec.run's starting directory."""
import pytest

from core.tools.general_tools.shared import normalize_source_path
from core.tools.canonical_registry import CANONICAL_REGISTRY
from core.tools.schemas import ToolInvocation
from storage.paths import ensure_workspace_storage_dirs, workspace_root


@pytest.fixture
def ws(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    ensure_workspace_storage_dirs("default")
    root = workspace_root("default")
    (root / "files" / "data" / "docs").mkdir(parents=True)
    (root / "files" / "data" / "docs" / "a.txt").write_text("预算已批复\n", encoding="utf-8")
    return root


@pytest.mark.parametrize("given, expected", [
    ("docs/a.txt", "files/data/docs/a.txt"),
    ("./docs", "files/data/docs"),
    ("notes/new.md", "files/data/notes/new.md"),
    (".", "files/data"),
    ("files/data/docs/a.txt", "files/data/docs/a.txt"),
    ("inbox/up.pdf", "inbox/up.pdf"),
    ("index", "index"),  # exists at the workspace root: left alone, normal checks apply
    ("sys/x", "sys/x"),
    ("files\\data\\x", "files\\data\\x"),
    ("/etc/passwd", "/etc/passwd"),
    ("../other/x", "../other/x"),
])
def test_normalize_source_path(ws, given, expected):
    assert normalize_source_path("default", given) == expected


def _call(tool_id, **arguments):
    entry = CANONICAL_REGISTRY[tool_id]
    return entry.handler(ToolInvocation(tool_id=tool_id, arguments=arguments, workspace_id="default"))


def test_workspace_file_bare_paths_work_end_to_end(ws):
    created = _call("workspace.file", action="create", filepath="notes/todo.md", content="- 买牛奶\n")
    assert created["ok"] is True, created
    assert (ws / "files" / "data" / "notes" / "todo.md").is_file()
    read = _call("workspace.file", action="read", filepath="docs/a.txt")
    assert read["ok"] is True and "预算" in str(read)
    found = _call("workspace.file", action="search", query="预算", subdir="docs")
    assert found["ok"] is True and "a.txt" in str(found)


def test_traversal_is_still_rejected(ws):
    result = _call("workspace.file", action="read", filepath="../../etc/passwd")
    assert result["ok"] is False
