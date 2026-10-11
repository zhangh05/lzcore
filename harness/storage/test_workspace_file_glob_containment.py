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


def test_source_search_pages_real_paths_and_reports_skipped_coverage(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    root = tmp_path / "search_ws/files/data/project"
    root.mkdir(parents=True)
    (root / "设备.txt").write_text("needle one\nno match\nneedle two\n", encoding="utf-8")
    (root / "binary.txt").write_bytes(b"needle\x00")
    other = tmp_path / "other.txt"
    other.write_text("needle private", encoding="utf-8")
    (root / "link.txt").symlink_to(other)
    ctx = ToolRuntimeContext(workspace_id="search_ws", requested_by="turn_runner")
    args = {"action": "search", "subdir": "files/data/project", "query": "needle", "pattern": "**/*.txt", "limit": 1}
    client = get_default_tool_runtime_client()
    first = client.invoke("workspace.file", args, context=ctx)
    assert first.status == "succeeded"
    assert first.output["matches"][0]["line"] == 1
    assert first.output["matches"][0]["filepath"] == "files/data/project/设备.txt"
    assert first.output["has_more"] is True and first.output["coverage"]["skipped_files"] == 2
    second = client.invoke("workspace.file", {**args, "offset": first.output["next_offset"]}, context=ctx)
    assert second.output["matches"][0]["line"] == 3 and second.output["has_more"] is False
    escaped = client.invoke("workspace.file", {**args, "subdir": "../other"}, context=ctx)
    assert escaped.status == "failed"
