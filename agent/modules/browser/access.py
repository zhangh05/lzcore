"""Server-owned, exact-origin grants for workspace development previews.

    LZCORE_BROWSER_LOCAL_PREVIEWS={"<principal-storage-key>/<workspace>":
        ["http://127.0.0.1:18731"]}

Unbound trusted-local callers use the key ``local/<workspace>``. No tool
argument or web page can grant access. Grants never cover another port, LAN
hosts, credentials in URLs, or file/data URLs.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
import os
from urllib.parse import urlsplit

from storage.ids import validate_workspace_id
from storage.principal import current_storage_principal, principal_storage_key


@dataclass(frozen=True)
class BrowserScope:
    owner: str
    workspace: str
    session: str

    @property
    def grant_key(self) -> str:
        return f"{self.owner}/{self.workspace}"


_SCOPE: ContextVar[BrowserScope] = ContextVar(
    "browser_scope", default=BrowserScope("local", "default", "internal"),
)


def current_browser_scope() -> BrowserScope:
    return _SCOPE.get()


@contextmanager
def browser_scope(workspace_id: str, session_id: str = ""):
    workspace = validate_workspace_id(workspace_id)
    principal = current_storage_principal()
    owner = principal_storage_key(principal) if principal else "local"
    token = _SCOPE.set(BrowserScope(owner, workspace, session_id or "workspace"))
    try:
        yield
    finally:
        _SCOPE.reset(token)


def _preview_origin(url: str, *, grant: bool = False) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (ValueError, TypeError):
        return None
    if (parsed.scheme not in {"http", "https"}
            or parsed.hostname not in {"127.0.0.1", "::1"}
            or port is None or port < 1024
            or parsed.username is not None or parsed.password is not None):
        return None
    if grant and (parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        return None
    return parsed.scheme, parsed.hostname, port


def local_preview_allowed(url: str, scope: BrowserScope | None = None) -> bool:
    origin = _preview_origin(url)
    if origin is None:
        return False
    active_scope = scope or current_browser_scope()
    principal = current_storage_principal()
    expected_owner = principal_storage_key(principal) if principal else "local"
    if active_scope.owner == expected_owner:
        from core.tools.project_execution import environment_for
        environment = environment_for(active_scope.workspace)
        if environment is not None and environment.started and not environment.closed:
            if origin == ("http", "127.0.0.1", environment.port):
                return True
    try:
        grants = json.loads(os.environ.get("LZCORE_BROWSER_LOCAL_PREVIEWS", "{}"))
    except (ValueError, TypeError):
        return False
    if not isinstance(grants, dict):
        return False
    values = grants.get((scope or current_browser_scope()).grant_key, [])
    if not isinstance(values, list):
        return False
    return any(isinstance(value, str) and _preview_origin(value, grant=True) == origin for value in values)
