from __future__ import annotations

from core.tools.schemas import ToolInvocation

from core.tools.general_tools.shared import _caller_workspace, _error_inv, _result, _workspace_path
"""Split general tool handlers."""

def handle_pdf_extract_text(inv: ToolInvocation) -> dict:
    """Extract text from a workspace PDF file.

    Uses PyPDF2 if available. Validates PDF format, file size, and page range.
    """
    args = inv.arguments
    ws = _caller_workspace(inv)
    filepath = str(args.get("filepath", "")).strip()
    page_range = str(args.get("page_range", "")).strip()

    if not filepath:
        return _error_inv(inv, "filepath is required")

    # Validate workspace path
    try:
        target = _workspace_path(ws, filepath)
    except ValueError as e:
        return _error_inv(inv, str(e))

    # Check file extension
    if target.suffix.lower() != ".pdf":
        return _error_inv(inv, "file must be a .pdf file")

    if not target.is_file():
        return _error_inv(inv, f"file not found: {filepath}")

    file_size = target.stat().st_size

    # ── File size limit (10MB) ──
    MAX_PDF_SIZE = 10 * 1024 * 1024
    if file_size > MAX_PDF_SIZE:
        return _result(inv, False, {
            "ok": False,
            "error": f"PDF file too large ({file_size} bytes, max {MAX_PDF_SIZE})",
        })

    # ── Validate PDF format: must start with %PDF ──
    try:
        with open(target, "rb") as f:
            header = f.read(4)
        if not header.startswith(b"%PDF"):
            return _result(inv, False, {
                "ok": False,
                "error": "not a PDF file",
                "file_size": file_size,
            })
    except Exception:
        return _error_inv(inv, "not a PDF file")

    # ── Parse and validate page range ──
    start_page = None
    end_page = None
    if page_range:
        try:
            parts = page_range.split("-")
            if len(parts) == 1:
                start_page = int(parts[0].strip()) - 1  # 0-indexed
                end_page = start_page
            elif len(parts) == 2:
                start_page = int(parts[0].strip()) - 1
                end_page = int(parts[1].strip()) - 1
            else:
                raise ValueError("invalid range")
        except (ValueError, IndexError):
            return _error_inv(inv, f"invalid page_range format: {page_range}. Use e.g. '1-3' or '5'")
        # Validate range
        if start_page is not None and (start_page < 0 or end_page < start_page):
            return _error_inv(inv, f"invalid page_range: start must be >= 1 and <= end")
        if end_page is not None and start_page is not None and (end_page - start_page >= 100):
            return _error_inv(inv, f"page_range too large: max 100 pages. Got {end_page - start_page + 1}")

    # ── Try to import PyPDF2 ──
    try:
        import PyPDF2  # noqa: F811
        _method = "pypdf2"
    except ImportError:
        try:
            import pypdf
            PyPDF2 = pypdf
            _method = "pypdf2"
        except ImportError:
            # No PyPDF2 available — return dependency missing, no text fallback
            return _result(inv, False, {
                "ok": False,
                "error": "pdf dependency missing (PyPDF2 not installed)",
                "file_size": file_size,
            })

    try:
        from io import BytesIO
        from agent.modules.knowledge.parsers.limits import read_bounded, MAX_PDF_PAGES
        reader = PyPDF2.PdfReader(BytesIO(read_bounded(target, MAX_PDF_SIZE)))
        page_count = len(reader.pages)
        if page_count > MAX_PDF_PAGES:
            return _result(inv, False, {"error": "pdf_page_limit_exceeded", "page_count": page_count})
        if not page_count or (end_page is not None and end_page >= page_count):
            return _result(inv, False, {
                "error": "empty_pdf" if not page_count else "page_range_out_of_bounds",
                "page_count": page_count,
            })

        # Determine page range
        if start_page is not None:
            pages_to_read = range(max(0, start_page), min(page_count, end_page + 1))
        else:
            pages_to_read = range(page_count)

        text_parts = []
        attempted_pages = [i + 1 for i in pages_to_read]
        extracted_pages = []
        failed_pages = []
        page_errors = []
        for i in pages_to_read:
            try:
                page_text = reader.pages[i].extract_text()
                extracted_pages.append(i + 1)
                if page_text:
                    text_parts.append(page_text)
            except Exception as exc:
                failed_pages.append(i + 1)
                page_errors.append({"page": i + 1, "error": "extract_failed", "exception": type(exc).__name__})

        full_text = "\n\n".join(text_parts)

        ok = bool(full_text.strip())
        return _result(inv, ok, {
            "text": full_text,
            "page_count": page_count,
            "pages_read": len(extracted_pages),
            "attempted_pages": attempted_pages,
            "extracted_pages": extracted_pages,
            "failed_pages": failed_pages,
            "page_errors": page_errors,
            "partial": ok and bool(failed_pages),
            "warnings": [f"pdf_page_extract_failed:{page}" for page in failed_pages],
            **({"error": "pdf_extract_failed" if not extracted_pages else "document_has_no_extractable_text"} if not ok else {}),
            "file_size": file_size,
            "char_count": len(full_text),
            "method": _method,
        })
    except Exception as e:
        return _error_inv(inv, str(e)[:200])

__all__ = ['handle_pdf_extract_text']
