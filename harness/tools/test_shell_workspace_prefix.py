from __future__ import annotations

from pathlib import Path

from core.tools.general_tools.command_tools import _rebase_workspace_prefixes


def _ws(tmp_path: Path) -> tuple[Path, str]:
    (tmp_path / "files" / "data" / "docs").mkdir(parents=True)
    (tmp_path / "files" / "tmp").mkdir(parents=True)
    (tmp_path / "inbox").mkdir()
    (tmp_path / "files" / "data" / "sales.csv").write_text("a\n", encoding="utf-8")
    (tmp_path / "inbox" / "up.txt").write_text("x", encoding="utf-8")
    return tmp_path, str(tmp_path / "files" / "data")


def test_rewrites_files_data_prefix(tmp_path):
    root, cwd = _ws(tmp_path)
    cmd, n = _rebase_workspace_prefixes("cat files/data/sales.csv | wc -l", root, cwd)
    assert cmd == "cat ./sales.csv | wc -l"
    assert n == 1


def test_rewrites_quoted_new_file_and_bare_dir(tmp_path):
    root, cwd = _ws(tmp_path)
    cmd, n = _rebase_workspace_prefixes('ls files/data && echo hi > "files/data/docs/new.txt"', root, cwd)
    assert cmd == 'ls . && echo hi > "./docs/new.txt"'
    assert n == 2


def test_rewrites_other_files_and_inbox(tmp_path):
    root, cwd = _ws(tmp_path)
    cmd, n = _rebase_workspace_prefixes("cp inbox/up.txt files/tmp/", root, cwd)
    assert cmd == "cp ../../inbox/up.txt ../tmp/"
    assert n == 2


def test_leaves_relative_urls_and_missing_paths(tmp_path):
    root, cwd = _ws(tmp_path)
    for command in (
        "cat sales.csv",
        "curl https://example.com/files/data/x",
        "cat ./files/data/sales.csv",
        "cat /abs/files/data/sales.csv",
        "echo files/nowhere/deep/x",
    ):
        assert _rebase_workspace_prefixes(command, root, cwd) == (command, 0)


def test_keeps_real_subfolder_named_files(tmp_path):
    root, cwd = _ws(tmp_path)
    (Path(cwd) / "files").mkdir()
    assert _rebase_workspace_prefixes("ls files/data", root, cwd) == ("ls files/data", 0)


def test_exec_rebases_prefixed_paths_end_to_end(monkeypatch, tmp_path):
    from core.tools.schemas import ToolInvocation
    from core.tools.general_tools import command_tools

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    captured = {}

    def fake_run(command, cwd=None, shell="/bin/bash", env=None, timeout=None, cancel_check=None):
        captured.update(command=command, cwd=cwd)
        return {"ok": True, "exit_code": 0, "stdout": "", "stderr": ""}

    monkeypatch.setattr(command_tools, "_run_shell", fake_run)
    base = dict(tool_id="exec.run", workspace_id="default")
    result = command_tools.handle_command_exec(ToolInvocation(
        **base, arguments={"action": "shell", "command": "head files/data/x.csv"},
    ))
    assert captured["command"] == "head ./x.csv"
    assert "path_note" in result

    # An explicit working_dir is workspace-root relative: leave the command alone.
    result = command_tools.handle_command_exec(ToolInvocation(
        **base, arguments={"action": "shell", "command": "head files/data/x.csv", "working_dir": "."},
    ))
    assert captured["command"] == "head files/data/x.csv"
    assert "path_note" not in result
