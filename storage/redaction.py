"""Storage-layer redaction helpers.

These helpers keep persisted records safe without requiring storage adapters to
import workspace or agent modules.
"""

from __future__ import annotations

import posixpath
import re

_KEYWORD_PATTERNS = [
    r"(?<![-\w])(password)\b\s*(?:=|:|\s)\s*\S+",
    r"(?<![-\w])(secret)\b\s*(?:=|:|\s)\s*\S+",
    r"(?<![-\w])(community)\b\s*(?:=|:|\s)\s*\S+",
    r"(?<![-\w])(key)\b\s*(?:=|:|\s)\s*\S+",
    r"(pre-shared-key)\s+\S+",
    r"(tacacs.*key)\s+\S+",
    r"(radius.*key)\s+\S+",
    r"(api[_-]?key[=:]\s*)\S+",
    r"(authorization\s*:\s*(?:bearer\s+)?)\S+",
    r"(token[=:]\s*)\S+",
    r"(OPENAI_API_KEY[=:]\s*)\S+",
    r"(DEEPSEEK_API_KEY[=:]\s*)\S+",
    r"(MINIMAX_API_KEY[=:]\s*)\S+",
    r"(ipsec)\s+\S+\s+\S+",
]

_FULL_MASK_PATTERNS = [
    r"(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{8,}",
    r"private[_-]?key",
]

MASK = "[REDACTED_SECRET]"
PATH_MASK = "[REDACTED_PATH]"

_SENSITIVE_FIELD_NAMES = frozenset({
    "password", "passwd", "passphrase", "secret", "api_secret", "client_secret",
    "key", "api_key", "apikey", "token", "access_token", "refresh_token",
    "id_token", "auth_token", "community", "authorization", "auth_header",
    "credential", "private_key",
})
_SENSITIVE_FIELD_SUFFIXES = tuple(f"_{name}" for name in _SENSITIVE_FIELD_NAMES)
_SAFE_REFERENCE_SUFFIXES = ("_ref", "_reference", "_id")

_ABSOLUTE_PATH_PATTERNS = [
    # Local Unix/macOS paths. Stop at JSON/string delimiters and common
    # traceback separators so file names are not allowed to leak the user home.
    re.compile(r"/(?:Users|home|root|tmp|etc|var|opt|usr)/[^\s\"'`<>),;]+"),
    # Windows drive paths, including JSON-escaped backslashes.
    re.compile(r"[A-Za-z]:(?:\\\\|\\)[^\s\"'`<>),;]+"),
]


def is_container_temporary_path(path: str) -> bool:
    """A public container tmpfs reference, never a host-path exception."""
    return path.startswith("/tmp/") and posixpath.normpath(path).startswith("/tmp/")


def redact_text(text: str, *, container_paths: bool = False) -> str:
    if not text:
        return text
    for pattern in _ABSOLUTE_PATH_PATTERNS:
        text = pattern.sub(
            lambda match: match.group(0)
            if container_paths and is_container_temporary_path(match.group(0))
            else PATH_MASK, text,
        )
    for pattern in _KEYWORD_PATTERNS:
        text = re.sub(pattern, lambda m: m.group(1) + " " + MASK, text, flags=re.IGNORECASE)
    for pattern in _FULL_MASK_PATTERNS:
        text = re.sub(pattern, MASK, text, flags=re.IGNORECASE)
    return text


def redact_value(value, *, container_paths: bool = False):
    """Recursively redact secrets and local absolute paths before persistence."""
    if isinstance(value, dict):
        return redact_dict(value, container_paths=container_paths)
    if isinstance(value, list):
        return [redact_value(item, container_paths=container_paths) for item in value]
    if isinstance(value, tuple):
        return [redact_value(item, container_paths=container_paths) for item in value]
    if isinstance(value, str):
        return redact_text(value, container_paths=container_paths)
    return value


def is_sensitive_field(key: str) -> bool:
    """Classify credential-bearing fields without masking ordinary metadata."""
    normalized = str(key or "").strip().lower().replace("-", "_")
    if not normalized or normalized in {"memory_key", "authority", "authority_rank"}:
        return False
    if normalized.endswith(_SAFE_REFERENCE_SUFFIXES):
        return False
    return normalized in _SENSITIVE_FIELD_NAMES or normalized.endswith(_SENSITIVE_FIELD_SUFFIXES)


def redact_dict(data: dict, *, container_paths: bool = False) -> dict:
    if not data:
        return data
    result = {}
    for key, value in data.items():
        normalized_key = str(key).lower().replace("-", "_")
        if is_sensitive_field(normalized_key):
            result[key] = MASK
        else:
            result[key] = redact_value(value, container_paths=container_paths)
    return result


_SECRET_PREFIXES = (
    "sk-", "password", "secret", "token", "api_key", "api-key", "apikey",
    "authorization", "community", "pre-shared-key", "key", "ipsec",
    "private_key", "private-key", "openai_api_key", "deepseek_api_key", "minimax_api_key",
)

_HOLD_TAILS = [
    re.compile(r"(?i)(?:^|[\s\"'`])authorization\s*:\s*(?:bearer\s*)?\S*$"),
    re.compile(r"(?i)sk-[A-Za-z0-9_-]*$"),
    re.compile(r"(?i)\bipsec(?:\s+\S*)?(?:\s+\S*)?$"),
    re.compile(
        r"(?i)(?:^|[\s\"'`])(?:password|secret|key|token|api[_-]?key|openai_api_key|deepseek_api_key|minimax_api_key|authorization|community|pre-shared-key)\b[\s:=]*\S*$"
    ),
]


class TokenSecretBuffer:
    """Hold a secret split across tokens until it can be redacted whole."""

    def __init__(self):
        self._held = ""

    def push(self, text: str) -> str:
        combined = self._held + (text or "")
        release, self._held = _split_secret_hold(combined)
        return redact_text(release)

    def flush(self) -> str:
        released = redact_text(self._held)
        self._held = ""
        return released


def _split_secret_hold(text: str) -> tuple[str, str]:
    hold_at = len(text)
    for pattern in _HOLD_TAILS:
        match = pattern.search(text)
        if match:
            hold_at = min(hold_at, match.start())
    # Do not release a suffix that may become a sensitive prefix next token.
    lowered = text.lower()
    for length in range(1, min(len(text), max(map(len, _SECRET_PREFIXES))) + 1):
        if any(prefix.startswith(lowered[-length:]) for prefix in _SECRET_PREFIXES):
            hold_at = min(hold_at, len(text) - length)
    if hold_at >= len(text):
        return text, ""
    return text[:hold_at], text[hold_at:]


def contains_secret(text: str) -> bool:
    if not text:
        return False
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in _KEYWORD_PATTERNS + _FULL_MASK_PATTERNS)
