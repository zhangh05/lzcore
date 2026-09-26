"""Loopback browser token for personal mode.

A malicious page can address 127.0.0.1 directly. Host checks do not see that
as a foreign host, so browser-origin writes must also present a token that
only an allowed local page can read.
"""

from __future__ import annotations

import hmac
import secrets

from storage.records import runtime_record_file


def local_browser_token() -> str:
    path = runtime_record_file("local_browser_token", create_parent=True)
    if path.is_file():
        current = path.read_text(encoding="utf-8").strip()
        if len(current) >= 32:
            return current
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token


def local_browser_token_matches(presented: str) -> bool:
    expected = local_browser_token()
    candidate = str(presented or "")
    if not candidate or len(candidate) != len(expected):
        return False
    return hmac.compare_digest(candidate, expected)
