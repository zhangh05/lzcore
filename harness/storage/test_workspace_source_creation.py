"""Exact source paths are governed writes, distinct from attachments."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from core.tools.client import ToolRuntimeClient
from core.tools.context import ToolRuntimeContext
from core.tools.registry import ToolRegistry
from core.tools.canonical_registry import to_tool_specs
from storage.paths import workspace_root


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    registry = ToolRegistry()
    for spec, handler in to_tool_specs():
        if spec.tool_id == "workspace.file":
            registry.register_tool(spec, handler)
    return ToolRuntimeClient(registry)


def create(client, path, text="hello", caller="turn_runner"):
    return client.invoke("workspace.file", {"action": "create", "filepath": path, "content": text},
                         context=ToolRuntimeContext(workspace_id="source_test", requested_by=caller)).status == "succeeded"


@pytest.mark.parametrize("caller", ["turn_runner", "subagent"])
def test_governed_create_preserves_tree_and_never_overwrites(client, caller):
    path = "files/data/project/src/设备.js"
    assert create(client, path, "中文\n", caller)
    target = workspace_root("source_test") / path
    assert target.read_text(encoding="utf-8") == "中文\n"
    assert target.read_bytes().startswith("中文".encode("utf-8"))
    read = client.invoke("workspace.file", {"action": "read", "filepath": path},
                         context=ToolRuntimeContext(workspace_id="source_test", requested_by=caller))
    assert read.status == "succeeded" and read.output["preview"] == "中文\n"
    assert not create(client, path, "replacement", caller)
    assert target.read_text(encoding="utf-8") == "中文\n"
    assert not list(target.parent.glob(".source-*"))


@pytest.mark.parametrize("path", ["../other/x", "files/data/../../sys/x", "/tmp/x", "sys/x", "files\\data\\x"])
def test_governed_create_rejects_out_of_scope_paths(client, path):
    assert not create(client, path)


def test_create_rejects_symlink_and_dangling_symlink(client):
    root = workspace_root("source_test") / "files/data"
    root.mkdir(parents=True)
    (root / "link").symlink_to(root / "missing")
    assert not create(client, "files/data/link")
    assert not (root / "missing").exists()


def test_concurrent_create_has_one_winner_and_complete_payload(client):
    path = "files/data/race.txt"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda n: create(client, path, str(n) * 10000), range(4)))
    assert sum(results) == 1
    text = (workspace_root("source_test") / path).read_text(encoding="utf-8")
    assert len(text) == 10000 and len(set(text)) == 1


def test_schema_and_caller_fail_before_creating_file(client):
    ctx = ToolRuntimeContext(workspace_id="source_test", requested_by="turn_runner")
    assert client.invoke("workspace.file", {"action": "create", "filepath": "files/data/no.txt"}, context=ctx).status != "succeeded"
    assert not create(client, "files/data/no.txt", caller="unknown")
    assert not (workspace_root("source_test") / "files/data/no.txt").exists()


def test_empty_source_content_is_valid_but_missing_content_is_not(client):
    from core.runtime_engine.models import ExecutionNode
    from core.runtime_engine.semantic_validator import SemanticValidator
    good = ExecutionNode(id="create", tool="workspace.file", args={
        "action": "create", "filepath": "files/data/pkg/__init__.py", "content": ""})
    missing = ExecutionNode(id="missing", tool="workspace.file", args={
        "action": "create", "filepath": "files/data/missing.py"})
    assert SemanticValidator().validate([good]).valid
    assert not SemanticValidator().validate([missing]).valid
    assert create(client, "files/data/pkg/__init__.py", "")


@pytest.mark.parametrize('bad', ['a\x00b', '\ud800'])
def test_invalid_source_text_never_publishes_or_replaces(client, bad):
    path = 'files/data/app/src/safe.ts'
    assert not create(client, path, bad)
    assert not (workspace_root('source_test') / path).exists()
    assert create(client, path, 'const value = 1;\n')
    result = client.invoke('workspace.file', {'action': 'edit', 'filepath': path,
        'old_string': '1', 'new_string': bad}, context=ToolRuntimeContext(workspace_id='source_test', requested_by='turn_runner'))
    assert result.status == 'failed'
    assert (workspace_root('source_test') / path).read_text() == 'const value = 1;\n'


def test_edit_requires_unique_context_and_can_delete_text(client, monkeypatch):
    # Exercise Windows text-stream translation on every host. Exact source
    # bytes must survive both create and the shared atomic edit writer.
    import storage.atomic_io as atomic_io
    import storage.workspace_files as workspace_files

    fdopen = atomic_io.os.fdopen
    named_temporary_file = workspace_files.tempfile.NamedTemporaryFile

    def windows_fdopen(fd, mode="r", **kwargs):
        if "b" not in mode:
            kwargs.setdefault("newline", "\r\n")
        return fdopen(fd, mode, **kwargs)

    def windows_temporary_file(**kwargs):
        kwargs.setdefault("newline", "\r\n")
        return named_temporary_file(**kwargs)

    monkeypatch.setattr(atomic_io.os, "fdopen", windows_fdopen)
    monkeypatch.setattr(workspace_files.tempfile, "NamedTemporaryFile", windows_temporary_file)
    from core.runtime_engine.models import ExecutionNode
    from core.runtime_engine.semantic_validator import SemanticValidator
    path = "files/data/edit.txt"
    assert create(client, path, "same\r\nsame\r\nunique\r\n")
    ctx = ToolRuntimeContext(workspace_id="source_test", requested_by="turn_runner")
    missing = client.invoke("workspace.file", {"action": "edit", "filepath": path, "new_string": "bad"}, context=ctx)
    ambiguous = client.invoke("workspace.file", {"action": "edit", "filepath": path, "old_string": "same", "new_string": "bad"}, context=ctx)
    target = workspace_root("source_test") / path
    assert missing.status == "blocked" and ambiguous.status == "failed"
    assert target.read_bytes() == b"same\r\nsame\r\nunique\r\n"
    read = client.invoke("workspace.file", {"action": "read", "filepath": path}, context=ctx)
    assert read.output["preview"] == "same\r\nsame\r\nunique\r\n"
    assert read.output["line_ending"] == "CRLF" and read.output["ends_with_newline"] is True
    assert "Read " in read.summary
    tail = client.invoke("workspace.file", {"action": "read", "filepath": path, "offset": 2}, context=ctx)
    assert tail.output["preview"] == "unique\r\n"
    assert tail.output["truncated"] is True and tail.output["has_more"] is False
    wrong_newlines = client.invoke("workspace.file", {"action": "edit", "filepath": path,
                                  "old_string": "unique\n", "new_string": ""}, context=ctx)
    assert wrong_newlines.status == "failed" and "CRLF" in wrong_newlines.summary
    assert target.read_bytes() == b"same\r\nsame\r\nunique\r\n"
    escaped = client.invoke("workspace.file", {"action": "edit", "filepath": path,
                            "old_string": r"unique\r\n", "new_string": ""}, context=ctx)
    assert escaped.status == "failed" and "double-escaped" in escaped.summary
    assert target.read_bytes() == b"same\r\nsame\r\nunique\r\n"
    args = {"action": "edit", "filepath": path,
            "old_string": read.output["preview"].splitlines(keepends=True)[-1], "new_string": ""}
    assert SemanticValidator().validate([ExecutionNode(id="delete-text", tool="workspace.file", args=args)]).valid
    assert client.invoke("workspace.file", args, context=ctx).status == "succeeded"
    assert target.read_bytes() == b"same\r\nsame\r\n"
    target.write_bytes(b"invalid-utf8-\xff")
    assert client.invoke("workspace.file", {"action": "read", "filepath": path}, context=ctx).status == "failed"
