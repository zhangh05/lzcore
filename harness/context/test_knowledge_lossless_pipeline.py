"""Regression coverage for lossless knowledge ingestion and consumption."""

from __future__ import annotations

import io
import re
import zipfile
import sys
from types import SimpleNamespace

import pytest


def _reset_context_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_WORKSPACE_DIR", str(tmp_path / "workspaces"))
    import core.context.context_store as context_store
    import core.context.unified_retriever as unified_retriever

    context_store._stores.clear()
    unified_retriever._retrievers.clear()


@pytest.mark.parametrize("all_failed", [False, True])
def test_pdf_failures_stay_outside_knowledge_and_attachment_content(tmp_path, monkeypatch, all_failed):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.parsers.pdf import parse
    from agent.modules.knowledge.ingestion import import_file
    from agent.modules.knowledge.store import read_source
    from storage.file_store import import_user_upload
    from core.tools.general_tools.filestore_tools import handle_file_extract_document
    from core.tools.general_tools.runtime_tools import handle_knowledge_get_source, handle_knowledge_reindex
    from core.tools.schemas import ToolInvocation

    def fail():
        raise ValueError("synthetic page failure")

    closed = []
    def open_pdf(_):
        pages = [SimpleNamespace(extract_text=fail)] if all_failed else [
            SimpleNamespace(extract_text=lambda: "Readable first page with enough text for PDF detection."),
            SimpleNamespace(extract_text=fail),
        ]
        return SimpleNamespace(pages=pages, metadata={}, close=lambda: closed.append(True))
    monkeypatch.setitem(sys.modules, "pdfplumber", SimpleNamespace(open=open_pdf))
    raw = b"%PDF-stub"
    parsed = parse(raw)
    assert "synthetic" not in parsed.normalized_markdown
    assert "extract_failed" not in parsed.normalized_markdown
    assert parsed.metadata["failed_pages"] == ([1] if all_failed else [2])
    assert parsed.warnings and closed
    imported = import_file("pdf_knowledge_ws", raw, title="Synthetic PDF")
    assert imported["ok"] is not all_failed
    assert imported["failed_pages"] == ([1] if all_failed else [2])
    if not all_failed:
        assert imported["partial"] is True and imported["warnings"]
        source = read_source("pdf_knowledge_ws", imported["source_id"])
        assert source["partial"] is True and source["content_complete"] is False
        tool = handle_knowledge_get_source(ToolInvocation(tool_id="knowledge.manage", workspace_id="pdf_knowledge_ws",
            arguments={"source_id": imported["source_id"]}))
        assert tool["partial"] is True and tool["failed_pages"] == [2] and tool["warnings"]
        assert "extract_failed" not in tool["content"]
        reindexed = handle_knowledge_reindex(ToolInvocation(tool_id="knowledge.manage", workspace_id="pdf_knowledge_ws",
            arguments={"source_id": imported["source_id"]}))
        assert reindexed["ok"] is True and reindexed["partial"] is True
        assert reindexed["failed_pages"] == [2] and reindexed["warnings"] == tool["warnings"]
    else:
        assert imported["errors"] == ["pdf_extract_failed"]
    record = import_user_upload("pdf_knowledge_ws", io.BytesIO(raw), "synthetic.pdf", file_kind="pdf", binary=True)
    extracted = handle_file_extract_document(ToolInvocation(tool_id="workspace.file", workspace_id="pdf_knowledge_ws",
        arguments={"file_id": record.file_id}))
    assert extracted["ok"] is not all_failed
    assert extracted["failed_pages"] == ([1] if all_failed else [2])
    if not all_failed:
        assert extracted["partial"] is True and extracted["warnings"]
        assert "extract_failed" not in extracted["content"]


@pytest.mark.parametrize("failure", [FileNotFoundError, PermissionError, RuntimeError, "short_read"])
def test_knowledge_read_marks_unavailable_full_text_as_partial(tmp_path, monkeypatch, failure):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.store import import_document, read_source
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    import storage.file_store as file_store

    content = "Full normalized document line\n" * 100
    imported = import_document("knowledge_partial_ws", "Full source", content)
    assert imported["ok"] is True
    def unavailable(*_):
        if failure == "short_read":
            return content[:25]
        raise failure("synthetic full text read failure")
    monkeypatch.setattr(file_store, "read_file_content", unavailable)
    source = read_source("knowledge_partial_ws", imported["source_id"])
    assert source["partial"] is True and source["content_complete"] is False
    assert source["content_length"] == len(content) and source["warnings"]
    client = get_default_tool_runtime_client()
    result = client.invoke("knowledge.manage", {"action": "read", "source_id": imported["source_id"]},
        context=ToolRuntimeContext(workspace_id="knowledge_partial_ws", requested_by="turn_runner"))
    assert result.output["partial"] is True and result.output["content_complete"] is False
    assert result.output["content_length"] == len(content)
    assert result.output["returned_content_length"] == len(result.output["content"])
    assert result.output["warnings"] == source["warnings"]
    assert len(result.output["content"]) < result.output["content_length"]


def test_child_chunking_never_breaks_a_fenced_block():
    from agent.modules.knowledge.chunking import chunk_document
    from agent.modules.knowledge.schemas import NormalizedDocument

    code = "```\n" + ("display interface brief\n" * 160) + "```"
    doc = NormalizedDocument(
        source_id="ksrc_lossless", title="Runbook",
        normalized_markdown="# Runbook\n\nBefore.\n\n" + code + "\n\nAfter.",
    )
    parents, children = chunk_document(doc)

    assert "\n".join(parent.content for parent in parents).count(code) == 1
    assert all(child.content.count("```") in {0, 2} for child in children)
    assert sum(code in child.content for child in children) == 1


def test_html_and_docx_preserve_block_order_without_duplicate_text():
    from docx import Document
    from agent.modules.knowledge.parsers import docx, html

    parsed_html = html.parse(b"<blockquote><p>ONE_WARNING</p></blockquote>")
    assert parsed_html.normalized_markdown.count("ONE_WARNING") == 1

    document = Document()
    document.add_paragraph("BEFORE_TABLE")
    document.add_table(rows=1, cols=1).cell(0, 0).text = "TABLE_CELL"
    document.add_paragraph("AFTER_TABLE")
    output = io.BytesIO()
    document.save(output)
    parsed_docx = docx.parse(output.getvalue()).normalized_markdown
    assert parsed_docx.index("BEFORE_TABLE") < parsed_docx.index("TABLE_CELL") < parsed_docx.index("AFTER_TABLE")


def test_xlsx_without_dimension_is_imported_without_row_loss():
    from openpyxl import Workbook
    from agent.modules.knowledge.parsers import xlsx

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["header"])
    sheet.append(["value"])
    raw = io.BytesIO()
    workbook.save(raw)
    repaired = io.BytesIO()
    with zipfile.ZipFile(raw) as source, zipfile.ZipFile(repaired, "w") as target:
        for filename in source.namelist():
            body = source.read(filename)
            if filename == "xl/worksheets/sheet1.xml":
                body = re.sub(rb"<dimension\b[^>]*/>", b"", body)
            target.writestr(filename, body)

    parsed = xlsx.parse(repaired.getvalue())
    assert "value" in parsed.normalized_markdown
    assert parsed.warnings == []


def test_tool_reads_full_source_and_carries_retrieval_provenance(tmp_path, monkeypatch):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.store import import_document
    from core.tools.general_tools.runtime_tools import (
        handle_knowledge_get_source,
        handle_knowledge_search,
    )
    from core.tools.schemas import ToolInvocation

    marker = "UNIQUE_LOSSLESS_MARKER"
    content = "# Global OSPF Guide\n\n" + marker + "\n\n" + ("route detail\n" * 500)
    imported = import_document(
        "knowledge_lossless_ws", "OSPF 配置指南", content,
        metadata={"scope": "global"},
    )
    assert imported["ok"] is True

    source_result = handle_knowledge_get_source(ToolInvocation(
        tool_id="knowledge.manage", workspace_id="knowledge_lossless_ws",
        arguments={"action": "read", "source_id": imported["source_id"], "level": "source"},
    ))
    assert source_result["content"] == content
    assert source_result["safe_excerpt"] == content
    assert source_result["scope"] == "global"
    assert source_result["chunk_count"] > 0
    assert source_result["partial"] is False and source_result["content_complete"] is True
    assert source_result["warnings"] == [] and source_result["content_length"] == len(content)

    search_result = handle_knowledge_search(ToolInvocation(
        tool_id="knowledge.manage", workspace_id="knowledge_lossless_ws",
        arguments={"action": "search", "query": marker, "scope": "global"},
    ))
    hit = search_result["results"][0]
    assert hit["source_id"] == imported["source_id"]
    assert hit["parent_chunk_id"]
    assert hit["scope"] == "global"
    assert marker in hit["safe_excerpt"]

    from agent.runtime.ssot_runtime import _build_retrieved_context_block
    context = _build_retrieved_context_block(
        workspace_id="knowledge_lossless_ws", session_id="session-1", task_id="task-1",
        user_input=marker, include_workspace_memory=False,
    )
    assert f"source_id={imported['source_id']}" in context
    assert "scope=global" in context
    assert "chunk_id=" in context and "parent_chunk_id=" in context


def test_artifact_tool_import_returns_readable_identity_and_preserves_unknown_write(tmp_path, monkeypatch):
    _reset_context_runtime(tmp_path, monkeypatch)
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext

    client = get_default_tool_runtime_client()
    ctx = ToolRuntimeContext(workspace_id="artifact_import_ws", requested_by="turn_runner")
    content = "# Import evidence\n\n" + "complete document line\n" * 130
    artifact = client.invoke("workspace.artifact", {
        "action": "save", "title": "Import evidence", "content": content,
    }, context=ctx)
    assert artifact.status == "succeeded"
    args = {"action": "import", "artifact_id": artifact.output["artifact_id"]}
    imported = client.invoke("knowledge.manage", args, context=ctx)
    assert imported.status == "succeeded" and imported.output["source_id"]
    read = client.invoke("knowledge.manage", {
        "action": "read", "source_id": imported.output["source_id"],
    }, context=ctx)
    assert read.status == "succeeded" and read.output["content"] == content

    from backend.main import app
    response = app.test_client().post("/api/knowledge/sources/from-artifact", json={
        "workspace_id": ctx.workspace_id, "artifact_id": args["artifact_id"],
    })
    assert response.status_code == 200
    source = response.get_json()["source"]
    assert source["source_id"] and source["workspace_id"] == ctx.workspace_id
    assert client.invoke("knowledge.manage", {
        "action": "read", "source_id": source["source_id"],
    }, context=ctx).output["content"] == content

    from storage.file_mutations import FileSettlementError
    import storage.file_store as file_store
    attempts = []

    def unknown(**kwargs):
        attempts.append(kwargs)
        raise FileSettlementError("settlement unavailable", intent="sys/file-mutations/test.json")

    monkeypatch.setattr(file_store, "write_knowledge_document", unknown)
    failed = client.invoke("knowledge.manage", args, context=ctx)
    assert failed.status == "failed" and failed.output["error_code"] == "EXECUTION_UNKNOWN"
    assert failed.output["executed"] is True and failed.output["automatic_retry_allowed"] is False
    assert len(attempts) == 1


def test_reindex_keeps_existing_chunks_when_full_text_is_missing(tmp_path, monkeypatch):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.ingestion import reindex_source
    from agent.modules.knowledge.index import child_counts_by_source
    from agent.modules.knowledge.store import import_document
    import storage.file_store as file_store

    imported = import_document(
        "knowledge_lossless_ws", "长文档", "段落\n" * 400,
    )
    source_id = imported["source_id"]
    before = child_counts_by_source("knowledge_lossless_ws").get(source_id, 0)
    assert before > 0
    monkeypatch.setattr(
        file_store, "read_file_content",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError(source_id)),
    )
    result = reindex_source("knowledge_lossless_ws", source_id)
    assert result["ok"] is False
    assert result["errors"] == ["normalized_content_unavailable"]
    assert child_counts_by_source("knowledge_lossless_ws").get(source_id, 0) == before


def test_title_fallback_preserves_scope_and_accepts_spaced_query(tmp_path, monkeypatch):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.store import import_document
    from backend.api.knowledge_routes import _module_title_search

    imported = import_document(
        "knowledge_title_ws", "OSPF 配置指南", "unrelated body",
        metadata={"scope": "global"},
    )
    hits = _module_title_search(
        "knowledge_title_ws", "OSPF 配置指南", scope="global",
    )
    assert hits and hits[0]["source_id"] == imported["source_id"]
    assert hits[0]["scope"] == "global"
    assert _module_title_search("knowledge_title_ws", "OSPF 配置指南", scope="workspace") == []


def test_scope_filter_recovers_legacy_chunk_scope_from_its_source(tmp_path, monkeypatch):
    _reset_context_runtime(tmp_path, monkeypatch)
    from agent.modules.knowledge.store import import_document
    from core.context.context_store import get_context_store
    from core.context.unified_retriever import get_retriever

    imported = import_document(
        "knowledge_legacy_scope_ws", "Global Guide", "LEGACY_SCOPE_MARKER",
        metadata={"scope": "global"},
    )
    store = get_context_store("knowledge_legacy_scope_ws")
    for chunk in store.list_items(
        item_type="knowledge_chunk", source_id=imported["source_id"], limit=999,
    ):
        chunk["scope"] = "workspace"
        chunk["metadata"] = {
            key: value for key, value in (chunk.get("metadata") or {}).items()
            if key != "scope"
        }
        store.update_knowledge_chunks([chunk])

    hits = get_retriever("knowledge_legacy_scope_ws").search_knowledge(
        "LEGACY_SCOPE_MARKER", scope="global",
    )
    assert hits and hits[0]["scope"] == "global"

    from agent.modules.knowledge.service import reindex_source
    assert reindex_source("knowledge_legacy_scope_ws", imported["source_id"])["ok"] is True
    assert get_retriever("knowledge_legacy_scope_ws").search_knowledge(
        "LEGACY_SCOPE_MARKER", scope="global",
    )
