"""P1TOOLS resource budgets and complete session export regressions."""
import io
import sys
import zipfile
from types import SimpleNamespace

import pytest


def test_session_markdown_export_keeps_message_tail(monkeypatch):
    from core.tools.general_tools.session_tools import handle_session_export
    from core.tools.schemas import ToolInvocation
    from storage import session_store
    content = "a" * 1000 + "关键结论"
    monkeypatch.setattr(session_store, "get_session", lambda *a: {
        "title": "Export", "messages": [{"role": "user", "content": content}]})
    result = handle_session_export(ToolInvocation(tool_id="system.manage", workspace_id="test_ws",
        arguments={"session_id": "session_test", "format": "markdown"}))
    assert result["ok"] and content in result["export"]


def _archive(name, content):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as document:
        document.writestr(name, content)
    return stream.getvalue()


@pytest.mark.parametrize("fmt,name", [("docx", "word/media/image1.png"),
    ("xlsx", "xl/sharedStrings.xml"), ("pptx", "ppt/media/image1.png")])
@pytest.mark.parametrize("as_path", [False, True])
def test_all_office_formats_reject_bombs_before_parser(tmp_path, monkeypatch, fmt, name, as_path):
    from agent.modules.knowledge.parsers import base
    raw = _archive(name, b"x" * 65536)
    source = raw
    if as_path:
        source = tmp_path / ("document." + fmt)
        source.write_bytes(raw)
    with pytest.raises(ValueError, match="archive_too_large"):
        base.parse_document(source, fmt=fmt)


@pytest.mark.parametrize("action", ["single", "batch", "text"])
def test_attachment_bomb_never_reaches_upload_or_parser(tmp_path, monkeypatch, action):
    from core.tools.general_tools import filestore_tools as files
    from storage import file_store
    from core.tools.schemas import ToolInvocation
    path = tmp_path / "bomb.docx"
    path.write_bytes(_archive("word/media/image1.png", b"x" * 65536))
    monkeypatch.setattr(file_store, "get_file_record", lambda *a: {"file_kind": "docx", "size_bytes": 1})
    monkeypatch.setattr(file_store, "resolve_file_path", lambda *a: path)
    monkeypatch.setattr(file_store, "import_user_upload", lambda *a, **k: pytest.fail("bomb uploaded"))
    handler = {"single": files.handle_file_extract_document_image,
               "batch": files.handle_file_extract_document_images,
               "text": files.handle_file_extract_document}[action]
    result = handler(ToolInvocation(tool_id="workspace.file", workspace_id="test_ws", arguments={"file_id": "file_test"}))
    assert not result["ok"]


def test_actual_attachment_bytes_override_stale_record_size(tmp_path, monkeypatch):
    from core.tools.general_tools import filestore_tools as files
    from storage import file_store
    from core.tools.schemas import ToolInvocation
    path = tmp_path / "large.txt"
    path.write_bytes(b"x" * 65)
    monkeypatch.setattr(files, "_MAX_EXTRACT_BYTES", 64)
    monkeypatch.setattr(file_store, "get_file_record", lambda *a: {"file_kind": "text", "size_bytes": 1})
    monkeypatch.setattr(file_store, "resolve_file_path", lambda *a: path)
    assert not files.handle_file_extract_document(ToolInvocation(tool_id="workspace.file", workspace_id="test_ws",
        arguments={"file_id": "file_test"}))["ok"]


def test_pdf_bytes_reject_page_budget_before_extraction(monkeypatch):
    from agent.modules.knowledge.parsers import base, limits
    monkeypatch.setattr(limits, "MAX_PDF_PAGES", 1)
    closed = []
    page = SimpleNamespace(extract_text=lambda: pytest.fail("over-budget PDF extracted"))
    monkeypatch.setitem(sys.modules, "pdfplumber", SimpleNamespace(open=lambda _: SimpleNamespace(
        pages=[page, page], close=lambda: closed.append(True))))
    with pytest.raises(ValueError, match="pdf_page_limit"):
        base.parse_document(b"%PDF-test", fmt="pdf")
    assert closed


def test_xlsx_dimensions_fail_before_iteration_and_close(monkeypatch):
    from agent.modules.knowledge.parsers.xlsx import parse
    closed = []
    sheet = SimpleNamespace(max_row=1000000, max_column=10,
        iter_rows=lambda **kw: pytest.fail("oversized worksheet iterated"))
    monkeypatch.setitem(sys.modules, "openpyxl", SimpleNamespace(load_workbook=lambda *a, **kw: SimpleNamespace(
        worksheets=[sheet], close=lambda: closed.append(True))))
    with pytest.raises(ValueError, match="dimensions"):
        parse(b"stub")
    assert closed


def test_image_batch_checks_aggregate_before_reading(tmp_path, monkeypatch):
    from core.tools.general_tools import filestore_tools as files
    from storage import file_store
    from core.tools.schemas import ToolInvocation
    monkeypatch.setattr(files, "MAX_IMAGE_BATCH_BYTES", 4)
    path = tmp_path / "batch.docx"
    with zipfile.ZipFile(path, "w") as document:
        document.writestr("word/media/image1.png", b"123")
        document.writestr("word/media/image2.png", b"456")
    monkeypatch.setattr(file_store, "get_file_record", lambda *a: {"file_kind": "docx"})
    monkeypatch.setattr(file_store, "resolve_file_path", lambda *a: path)
    monkeypatch.setattr(files, "read_image", lambda *a: pytest.fail("over-budget batch read"))
    result = files.handle_file_extract_document_images(ToolInvocation(tool_id="workspace.file", workspace_id="test_ws",
        arguments={"file_id": "file_test"}))
    assert not result["ok"]
