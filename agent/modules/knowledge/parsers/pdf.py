# agent/modules/knowledge/knowledge/parsers/pdf.py
"""PDF parser — pdfplumber based, text-only.

Strategy:
  - Open with pdfplumber; iterate pages.
  - If extracted text is mostly empty / very short per page,
    treat as a scanned (image-based) PDF and return
    error=unsupported_ocr (per spec: no fabrication).
  - Otherwise normalize to markdown with page markers.
"""

from __future__ import annotations

from typing import Optional

from agent.modules.knowledge.schemas import NormalizedDocument


SCANNED_PAGE_TEXT_RATIO = 0.05  # less than 5% of pages have text -> scanned
SCANNED_MIN_TEXT_CHARS = 20     # per page, less than 20 chars = scanned


def parse(
    raw: bytes,
    *,
    title: str = "",
    author: str = "",
    source_type: str = "project_doc",
    scope: str = "workspace",
    language: str = "zh",
    metadata: Optional[dict] = None,
) -> NormalizedDocument:
    try:
        import pdfplumber  # type: ignore
    except ImportError as e:
        return NormalizedDocument(
            title=title, author=author, source_type=source_type,
            scope=scope, language=language, format="pdf",
            normalized_markdown="",
            metadata=metadata or {},
            warnings=[f"pdf_parser_unavailable: {e!r}"],
        )
    import io
    try:
        pdf = pdfplumber.open(io.BytesIO(raw))
    except Exception as e:
        return NormalizedDocument(
            title=title, author=author, source_type=source_type,
            scope=scope, language=language, format="pdf",
            normalized_markdown="",
            metadata=metadata or {},
            warnings=[f"pdf_open_failed: {e!r}"],
        )
    n_pages = len(pdf.pages)
    if not title:
        try:
            meta = pdf.metadata or {}
            cand = meta.get("Title") or meta.get("title") or ""
            if cand:
                title = str(cand).strip()
        except Exception:
            pass
    if not author:
        try:
            meta = pdf.metadata or {}
            cand = meta.get("Author") or meta.get("author") or ""
            if cand:
                author = str(cand).strip()
        except Exception:
            pass
    pages_text = []
    pages_with_text = 0
    failed_pages = []
    page_errors = []
    try:
        for i, page in enumerate(pdf.pages, start=1):
            try:
                txt = page.extract_text() or ""
            except Exception as exc:
                failed_pages.append(i)
                page_errors.append({"page": i, "error": "extract_failed", "exception": type(exc).__name__})
                continue
            if len(txt.strip()) >= SCANNED_MIN_TEXT_CHARS:
                pages_with_text += 1
            pages_text.append((i, txt))
    finally:
        pdf.close()
    warnings = [f"pdf_page_extract_failed:{page}" for page in failed_pages]
    metadata = dict(metadata or {})
    metadata.update({
        "attempted_pages": list(range(1, n_pages + 1)),
        "extracted_pages": [page for page, _ in pages_text],
        "failed_pages": failed_pages,
        "page_errors": page_errors,
        "partial": bool(failed_pages),
    })
    if n_pages == 0:
        return NormalizedDocument(
            title=title, author=author, source_type=source_type,
            scope=scope, language=language, format="pdf",
            normalized_markdown="",
            metadata=metadata or {},
            warnings=["empty_pdf"],
        )
    if not pages_text:
        return NormalizedDocument(
            title=title, author=author, source_type=source_type,
            scope=scope, language=language, format="pdf",
            normalized_markdown="", metadata=metadata,
            warnings=[*warnings, "pdf_extract_failed"],
        )
    ratio = pages_with_text / len(pages_text)
    metadata.setdefault("format_hint", "pdf")
    metadata.setdefault("page_count", n_pages)
    if ratio < SCANNED_PAGE_TEXT_RATIO:
        # Scanned PDF: do NOT fabricate. Return ok=False-shaped
        # failure (the ingestion layer reads warnings).
        return NormalizedDocument(
            title=title, author=author, source_type=source_type,
            scope=scope, language=language, format="pdf",
            normalized_markdown="",
            metadata=metadata,
            warnings=[*warnings, "unsupported_ocr"],
        )
    out_lines = []
    for i, txt in pages_text:
        out_lines.append(f"<!-- page {i} -->")
        out_lines.append("")
        for line in (txt or "").splitlines():
            line = line.rstrip()
            if not line:
                out_lines.append("")
                continue
            out_lines.append(line)
        out_lines.append("")
    md = "\n".join(out_lines).strip()
    if author and "author" not in metadata:
        metadata["author"] = author
    return NormalizedDocument(
        title=title,
        author=author,
        source_type=source_type,
        scope=scope,
        language=language,
        format="pdf",
        normalized_markdown=md,
        metadata=metadata,
        warnings=warnings,
    )
