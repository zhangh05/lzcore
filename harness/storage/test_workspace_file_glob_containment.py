"""workspace.file glob must not list paths outside the caller workspace."""

from core.tools.canonical_registry import _local_glob
from core.tools.schemas import ToolInvocation


def test_glob_rejects_parent_directory_pattern(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from storage.paths import ensure_workspace_storage_dirs, workspace_root

    ensure_workspace_storage_dirs("ws_a")
    other = tmp_path / "ws_b"
    other.mkdir()
    (other / "secret.txt").write_text("leak", encoding="utf-8")
    (workspace_root("ws_a") / "ok.txt").write_text("ok", encoding="utf-8")

    escaped = _local_glob(ToolInvocation(
        tool_id="workspace.file",
        workspace_id="ws_a",
        arguments={"action": "glob", "pattern": "../ws_b/*"},
    ))
    assert escaped.get("ok") is False
    assert "matches" not in escaped or escaped.get("matches") == []

    sibling = _local_glob(ToolInvocation(
        tool_id="workspace.file",
        workspace_id="ws_a",
        arguments={"action": "glob", "pattern": "../*"},
    ))
    assert sibling.get("ok") is False
