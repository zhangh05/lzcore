"""PDF validation failures must retain the common tool-result contract."""

from core.tools.general_tools.pdf_tools import handle_pdf_extract_text
from core.tools.schemas import ToolInvocation
from types import SimpleNamespace
import sys

import pytest


def test_non_pdf_returns_a_normal_tool_error(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    workspace = "ws_pdf_contract"
    target = tmp_path / workspace / "bad.pdf"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"not-a-pdf")

    result = handle_pdf_extract_text(ToolInvocation(
        tool_id="pdf.extract", workspace_id=workspace,
        arguments={"filepath": "bad.pdf"},
    ))
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert result["error"] == "not a PDF file"


def _pdf_page(text=None, *, fail=False):
    def extract_text():
        if fail:
            raise ValueError("synthetic extraction failure")
        return text
    return SimpleNamespace(extract_text=extract_text)


def test_pdf_tool_rejects_page_budget_before_extract(monkeypatch, tmp_path):
    from agent.modules.knowledge.parsers import limits
    monkeypatch.setattr(limits, "MAX_PDF_PAGES", 1)
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    target = tmp_path / "pdf_ws" / "test.pdf"
    target.parent.mkdir()
    target.write_bytes(b"%PDF-stub")
    page = SimpleNamespace(extract_text=lambda: pytest.fail("over-budget PDF extracted"))
    monkeypatch.setitem(sys.modules, "PyPDF2", SimpleNamespace(PdfReader=lambda _: SimpleNamespace(pages=[page, page])))
    result = handle_pdf_extract_text(ToolInvocation(tool_id="pdf.extract", workspace_id="pdf_ws",
        arguments={"filepath": "test.pdf"}))
    assert not result["ok"] and result["error"] == "pdf_page_limit_exceeded"


@pytest.mark.parametrize("page_range", ["9", "1-9", "1-2-3", "0", "2-1"])
def test_pdf_rejects_empty_out_of_bounds_and_malformed_ranges(monkeypatch, tmp_path, page_range):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    target = tmp_path / "pdf_ws" / "test.pdf"
    target.parent.mkdir()
    target.write_bytes(b"%PDF-stub")
    monkeypatch.setitem(sys.modules, "PyPDF2", SimpleNamespace(PdfReader=lambda _: SimpleNamespace(
        pages=[_pdf_page("first"), _pdf_page("second")],
    )))
    result = handle_pdf_extract_text(ToolInvocation(tool_id="pdf.extract", workspace_id="pdf_ws",
        arguments={"filepath": "test.pdf", "page_range": page_range}))
    assert result["ok"] is False and result["status"] == "failed"


@pytest.mark.parametrize("case", ["partial", "all_failed", "empty_text", "empty_pdf", "complete"])
def test_pdf_extraction_reports_page_failures_outside_body(monkeypatch, tmp_path, case):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    target = tmp_path / "pdf_ws" / "test.pdf"
    target.parent.mkdir()
    target.write_bytes(b"%PDF-stub")
    pages = {
        "partial": [_pdf_page("readable text"), _pdf_page(fail=True)],
        "all_failed": [_pdf_page(fail=True)],
        "empty_text": [_pdf_page("")],
        "empty_pdf": [],
        "complete": [_pdf_page("readable text")],
    }[case]
    monkeypatch.setitem(sys.modules, "PyPDF2", SimpleNamespace(PdfReader=lambda _: SimpleNamespace(pages=pages)))
    result = handle_pdf_extract_text(ToolInvocation(tool_id="pdf.extract", workspace_id="pdf_ws",
        arguments={"filepath": "test.pdf"}))
    assert result["ok"] is (case in {"partial", "complete"})
    if case != "empty_pdf":
        assert result["partial"] is (case == "partial")
        assert "extraction fail" not in result["text"]
        assert "synthetic" not in result["text"]
    if case == "partial":
        assert result["text"] == "readable text"
        assert result["attempted_pages"] == [1, 2]
        assert result["extracted_pages"] == [1] and result["failed_pages"] == [2]
        assert result["page_errors"][0]["error"] == "extract_failed"
        assert result["warnings"]
