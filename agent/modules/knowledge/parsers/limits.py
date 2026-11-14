"""Shared pre-expansion limits for document and attachment entry points."""
from __future__ import annotations

import io
import os
from pathlib import Path
import zipfile

MAX_FILE_BYTES = int(os.environ.get("KNOWLEDGE_MAX_FILE_BYTES", 200 * 1024 * 1024))
MAX_PDF_PAGES = int(os.environ.get("KNOWLEDGE_MAX_PDF_PAGES", 2000))
MAX_ZIP_BYTES = int(os.environ.get("KNOWLEDGE_MAX_ZIP_UNCOMPRESSED_BYTES", 200 * 1024 * 1024))
MAX_ZIP_RATIO = int(os.environ.get("KNOWLEDGE_MAX_ZIP_RATIO", 100))
MAX_ZIP_ENTRIES = int(os.environ.get("KNOWLEDGE_MAX_ZIP_ENTRIES", 1000))
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BATCH_BYTES = 32 * 1024 * 1024


def read_bounded(source, limit: int = MAX_FILE_BYTES) -> bytes:
    if isinstance(source, (str, Path)):
        with Path(source).open("rb") as stream:
            if os.fstat(stream.fileno()).st_size > limit:
                raise ValueError("file_too_large")
            raw = stream.read(limit + 1)
    else:
        if len(source) > limit:
            raise ValueError("file_too_large")
        raw = bytes(source)
    if len(raw) > limit:
        raise ValueError("file_too_large")
    return raw


def validate_archive(document: zipfile.ZipFile) -> None:
    infos = document.infolist()
    if len(infos) > MAX_ZIP_ENTRIES or len({i.filename for i in infos}) != len(infos):
        raise ValueError("archive_entry_limit_or_duplicate")
    total = 0
    for info in infos:
        total += info.file_size
        if (total > MAX_ZIP_BYTES or info.file_size < 0 or info.flag_bits & 1
                or info.file_size > max(1, info.compress_size) * MAX_ZIP_RATIO):
            raise ValueError("archive_too_large")


def validate_document(raw: bytes, fmt: str) -> None:
    if fmt in {"docx", "xlsx", "pptx"}:
        with zipfile.ZipFile(io.BytesIO(raw)) as document:
            validate_archive(document)


def read_image(document: zipfile.ZipFile, name: str) -> bytes:
    if document.getinfo(name).file_size > MAX_IMAGE_BYTES:
        raise ValueError("embedded_image_too_large")
    with document.open(name) as stream:
        raw = stream.read(MAX_IMAGE_BYTES + 1)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("embedded_image_too_large")
    return raw
