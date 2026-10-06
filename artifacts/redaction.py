# artifacts/redaction.py
"""Artifact redaction — strip secrets from artifact content and metadata."""

import re

SECRET_PATTERNS = [
    r'(password\s+\S+|[Pp]assword[=:]\s*\S+)',
    r'(secret\s+\S+|[Ss]ecret[=:]\s*\S+)',
    r'(community\s+\S+)',
    r'sk-[A-Za-z0-9]{20,}',
    r'(api[_-]?key[=:]\s*\S{8,})',
    r'(Bearer\s+\S{8,})',
    r'(Authorization\s+\S{8,})',
    r'(MINIMAX_API_KEY[=:]\s*\S+)',
    r'(OPENAI_API_KEY[=:]\s*\S+)',
    r'(DEEPSEEK_API_KEY[=:]\s*\S+)',
    r'(private[_-]?key[=:]\s*\S+)',
    r'(token[=:]\s*\S{8,})',
    # v3.12: added patterns previously missing from this module
    r'eyJ[A-Za-z0-9+/=]{20,}',                        # JWT tokens
    r'-----BEGIN\s.*PRIVATE KEY-----',                 # SSH private key headers
    r'AKIA[0-9A-Z]{16}',                               # AWS Access Key ID
    r'snmp-server\s+community\s+\S+',                  # SNMP community strings
]
MASK = "[REDACTED_SECRET]"
_MASKED_CREDENTIAL = re.compile(
    r"(?:password|secret|community|api[_-]?key|Bearer|Authorization(?:\s+Bearer)?|"
    r"MINIMAX_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|private[_-]?key|token|"
    r"snmp-server\s+community)(?:\s+|[=:]\s*)"
    # Serialized tool evidence may end the value with a JSON escape instead
    # of literal whitespace. Only delimiters are allowed after a whole mask;
    # arbitrary escaped text or adjacent credential bytes still fail closed.
    r"\[REDACTED(?:_SECRET)?\](?:[\"'`,.;:)}\]]|\\[nrt\"\\])*",
    re.IGNORECASE,
)


def _is_secret_match(match: re.Match) -> bool:
    """Known whole-value masks are evidence, not credentials or exemptions."""
    return _MASKED_CREDENTIAL.fullmatch(match.group()) is None


def _is_sensitive_metadata_key(key: object) -> bool:
    """Detect credential fields without treating every ``*key`` as secret."""
    normalized = re.sub(r"[^a-z0-9]+", "_", str(key or "").strip().lower()).strip("_")
    parts = set(normalized.split("_")) if normalized else set()
    if parts & {"password", "passwd", "passphrase", "secret", "token"}:
        return True
    return normalized == "key" or normalized.endswith((
        "api_key",
        "access_key",
        "private_key",
        "secret_key",
        "session_key",
        "signing_key",
        "encryption_key",
        "auth_key",
    ))


def redact_artifact_content(content: str) -> str:
    if not content:
        return content
    for pat in SECRET_PATTERNS:
        content = re.sub(pat, lambda match: MASK if _is_secret_match(match) else match.group(),
                         content, flags=re.IGNORECASE)
    return content


def contains_secret(content: str) -> bool:
    if not content:
        return False
    for pat in SECRET_PATTERNS:
        if any(_is_secret_match(match) for match in re.finditer(pat, content, re.IGNORECASE)):
            return True
    return False


def redact_metadata(metadata: dict) -> dict:
    if not metadata:
        return metadata
    result = {}
    for k, v in metadata.items():
        if _is_sensitive_metadata_key(k) or (isinstance(v, str) and contains_secret(v)):
            result[k] = MASK
        else:
            result[k] = v
    return result
