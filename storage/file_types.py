"""File classification shared by storage, uploads and governed tools."""

from pathlib import Path
import mimetypes

from storage.policy import TEXT_KINDS

_TEXT = {
    'txt': 'text', 'md': 'markdown', 'markdown': 'markdown', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'xml': 'xml', 'csv': 'csv', 'tsv': 'csv',
    'html': 'html', 'htm': 'html', 'log': 'log', 'cfg': 'config', 'conf': 'config',
    'ini': 'config', 'diff': 'diff', 'patch': 'diff',
    **{ext: 'script' for ext in ('py', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss',
        'sh', 'bash', 'ps1', 'sql', 'toml', 'rs', 'go', 'java', 'c', 'h', 'cpp')},
}
_BINARY = {
    **{ext: ext for ext in ('pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
        'png', 'jpg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'zip', 'tar',
        'gz', 'bz2', '7z', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4', 'webm', 'mov')},
    'jpeg': 'jpeg',
}
_MIME = {
    'markdown': 'text/markdown', 'yaml': 'text/yaml', 'config': 'text/plain',
    'script': 'text/plain', 'diff': 'text/plain', 'log': 'text/plain',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}


def classify_file(filename: str, *, file_kind: str | None = None,
                  binary: bool | None = None) -> dict:
    """Unknown formats remain opaque; a suffix never promises a parser."""
    ext = Path(filename or '').suffix.lower().lstrip('.')
    kind = (_TEXT.get(file_kind, file_kind) if file_kind else None) or _TEXT.get(ext) or _BINARY.get(ext) or 'binary'
    is_binary = binary if binary is not None else kind not in TEXT_KINDS
    mime = _MIME.get(kind) or mimetypes.guess_type(filename or '')[0]
    return {'file_kind': kind, 'binary': bool(is_binary),
            'mime_type': mime or ('application/octet-stream' if is_binary else 'text/plain')}


def file_capabilities(record: dict) -> dict:
    """Report implemented transports, without assuming provider abilities."""
    kind = record.get('file_kind', 'binary')
    mime = str(record.get('mime_type') or '')
    active = record.get('lifecycle', 'active') == 'active'
    return {'download': active, 'text_read': active and not record.get('binary', False),
            'document_extract': active and (kind in TEXT_KINDS or kind in {'pdf', 'docx', 'xlsx', 'pptx'}),
            'image_evidence': active and kind in {'png', 'jpg', 'jpeg', 'gif', 'webp'},
            'preview': 'image' if mime.startswith('image/') else 'pdf' if kind == 'pdf'
                       else 'text' if not record.get('binary', False) else 'download',
            'archive': active and kind in {'zip', 'tar', 'gz', 'bz2'},
            'media': 'audio' if mime.startswith('audio/') else 'video' if mime.startswith('video/') else ''}
