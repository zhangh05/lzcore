"""The workspace patch tool must not silently apply stale hunks."""

from core.tools.general_tools.file_tools import handle_file_patch
from core.tools.schemas import ToolInvocation


def _inv(workspace_id: str, patch_text: str) -> ToolInvocation:
    return ToolInvocation(
        tool_id="workspace.file",
        workspace_id=workspace_id,
        arguments={"action": "patch", "filepath": "files/data/config.txt", "patch_text": patch_text},
    )


def test_patch_rejects_stale_context_without_modifying_file(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    target = tmp_path / "workspaces" / "test_ws" / "files" / "data" / "config.txt"
    target.parent.mkdir(parents=True)
    target.write_text("current=value\n", encoding="utf-8")

    result = handle_file_patch(_inv("test_ws", "@@ -1 +1 @@\n-old=value\n+new=value\n"))

    assert result["ok"] is False
    assert "context does not match" in result["error"]
    assert target.read_text(encoding="utf-8") == "current=value\n"


def test_patch_applies_when_context_matches(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    target = tmp_path / "workspaces" / "test_ws" / "files" / "data" / "config.txt"
    target.parent.mkdir(parents=True)
    target.write_text("old=value\n", encoding="utf-8")

    result = handle_file_patch(_inv("test_ws", "@@ -1 +1 @@\n-old=value\n+new=value\n"))

    assert result["ok"] is True
    assert target.read_text(encoding="utf-8") == "new=value\n"


def test_patch_preserves_line_endings_and_validates_entire_diff_before_write(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    target = tmp_path / "test_ws/files/data/config.txt"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"one\r\ntwo")
    missing_marker = "@@ -2 +2 @@\n-two\n+three\n"
    rejected = handle_file_patch(_inv("test_ws", missing_marker))
    assert rejected["ok"] is False and "No newline at end of file" in rejected["error"]
    assert target.read_bytes() == b"one\r\ntwo"
    # Standard empty-range insertion at the start, including @@ in source text.
    patch = "@@ -0,0 +1 @@\n+@@ literal\n"
    inv = _inv("test_ws", patch)
    inv.arguments["dry_run"] = True
    assert handle_file_patch(inv)["dry_run"] is True
    assert target.read_bytes() == b"one\r\ntwo"
    inv.arguments["dry_run"] = False
    assert handle_file_patch(inv)["ok"] is True
    assert target.read_bytes() == b"@@ literal\r\none\r\ntwo"
    valid = "@@ -3 +3 @@\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n"
    assert handle_file_patch(_inv("test_ws", valid))["ok"] is True
    assert target.read_bytes().endswith(b"three")
    before = target.read_bytes()
    invalid = "@@ -1 +1 @@\n-@@ literal\n+changed\n@@ -2 +2,2 @@\n-one\n+only-one\n"
    assert handle_file_patch(_inv("test_ws", invalid))["ok"] is False
    assert target.read_bytes() == before
