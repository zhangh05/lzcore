# backend/core/auth.py
"""Global API authentication middleware.

Environment variables:
  LZCORE_AUTH_ENABLED  — "true" or "false" (default: false)
  LZCORE_API_TOKEN     — shared secret for Bearer / X-API-Key auth
  LZCORE_LOGIN_ENABLED — "true" or "false" (default: true when username/password are set)
  LZCORE_LOGIN_USERNAME — web login username
  LZCORE_LOGIN_PASSWORD — web login password

Public endpoints (no auth required even when enabled):
  - /api/health, /health
  - /api/auth/login, /api/auth/status
  - Static frontend resources (non-/api/* paths)

Auth methods:
  - Authorization: Bearer <token>
  - X-API-Key: <token>

Returns 401 on auth failure:
  {"ok": false, "error": "unauthorized", "message": "...", "status": 401}
"""

import os
import logging
import hmac
import ipaddress
import secrets
from urllib.parse import urlparse

import flask

logger = logging.getLogger("lzcore.auth")

def _is_auth_enabled() -> bool:
    """Read LZCORE_AUTH_ENABLED from env (re-evaluated each call for testability)."""
    return os.environ.get("LZCORE_AUTH_ENABLED", "false").strip().lower() in (
        "true", "1", "yes", "on",
    )


def _secret_value(name: str) -> str:
    direct = os.environ.get(name, "")
    if direct:
        return direct.strip()
    path = os.environ.get(f"{name}_FILE", "").strip()
    if not path:
        return ""
    try:
        from pathlib import Path
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        logger.error("Unable to read secret file for %s", name)
        return ""


def _get_api_token() -> str:
    """Read the API token from env or a mounted secret file."""
    return _secret_value("LZCORE_API_TOKEN")


def _get_login_username() -> str:
    return os.environ.get("LZCORE_LOGIN_USERNAME", "").strip()


def _get_login_password() -> str:
    return _secret_value("LZCORE_LOGIN_PASSWORD")


def _is_login_enabled() -> bool:
    raw = os.environ.get("LZCORE_LOGIN_ENABLED", "").strip().lower()
    if raw:
        return raw in ("true", "1", "yes", "on")
    return bool(_get_login_username() and _get_login_password())


def _is_identity_enabled() -> bool:
    try:
        from backend.core.identity import identity_enabled
        return identity_enabled()
    except Exception:
        return False


def validate_network_listener(host: str) -> None:
    """Reject an explicitly exposed backend unless authentication is effective."""
    normalized = str(host or "").strip().strip("[]").lower()
    is_loopback = normalized == "localhost" or normalized == "::1" or normalized.startswith("127.")
    if is_loopback:
        return
    effective_api_auth = _is_auth_enabled() and bool(_get_api_token())
    effective_login = _is_login_enabled() and bool(_get_login_username() and _get_login_password())
    if effective_api_auth or effective_login or _is_identity_enabled():
        return
    if os.environ.get("LZCORE_ALLOW_UNAUTHENTICATED_NETWORK", "").strip().lower() in {
        "1", "true", "yes", "on",
    }:
        logger.critical("DANGER: unauthenticated network listener explicitly allowed on %s", host)
        return
    raise RuntimeError(
        "Refusing non-loopback backend listener without effective authentication. "
        "Configure API token (LZCORE_AUTH_ENABLED=true and LZCORE_API_TOKEN), "
        "login (LZCORE_LOGIN_USERNAME and LZCORE_LOGIN_PASSWORD), "
        "or identity authentication (LZCORE_IDENTITY_ENABLED=true)."
    )


# ── Module-level defaults (used for logging) ──
_AUTH_ENABLED = _is_auth_enabled()
_API_TOKEN = _get_api_token()

# ── Public endpoints (no auth required) ──
_PUBLIC_PREFIXES = frozenset([
    "/api/health",
    "/api/ready",
    "/api/auth/login",
    "/api/auth/status",
    "/api/auth/oidc/start",
    "/api/auth/oidc/callback",
    "/health",
])

_PUBLIC_EXACT = frozenset([
    "/",
])


def is_public_path(path: str) -> bool:
    """Check if a request path is public (no auth required)."""
    if path == "/metrics":
        return False
    # Exact matches
    if path in _PUBLIC_EXACT:
        return True
    # Prefix matches
    for prefix in _PUBLIC_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    # Non-API paths (static frontend resources)
    if not path.startswith("/api/"):
        return True
    return False


def _unauthorized_response(message: str = "Missing or invalid API token") -> flask.Response:
    """Return a standardized 401 response."""
    return flask.jsonify({
        "ok": False,
        "error": "unauthorized",
        "message": message,
        "status": 401,
    }), 401


def get_effective_client_address() -> str:
    """Resolve the client for local authority checks, trusting one local proxy.

    A loopback proxy must append its peer to X-Forwarded-For. Only the last
    entry is trusted; earlier entries may have been supplied by the client.
    A present but empty entry stays empty so it cannot grant local authority.
    Non-loopback peers cannot assert a client address through headers.
    """
    remote_addr = flask.request.remote_addr or ""
    if _is_loopback_host(remote_addr):
        forwarded = flask.request.headers.get("X-Forwarded-For")
        if forwarded is not None:
            return forwarded.rsplit(",", 1)[-1].strip()
    return remote_addr


def deny_remote_admin_write() -> flask.Response | None:
    """Defense in depth for privileged mutating routes.

    The global middleware is a pass-through when no auth is configured, so
    admin and extension lifecycle writes would otherwise serve any remote
    caller that can reach the listener. Return None when the caller presents
    a valid API token/session or arrives on loopback; otherwise a 403 that
    route handlers return immediately.
    """
    if _request_has_valid_api_token() or is_current_session_authenticated():
        return None
    if _is_loopback_host(get_effective_client_address()):
        return None
    return flask.jsonify({
        "ok": False,
        "error": "remote_admin_write_denied",
        "message": "Privileged writes require loopback or an authenticated caller.",
        "status": 403,
    }), 403


def _login_disabled_response() -> flask.Response:
    return flask.jsonify({
        "ok": False,
        "error": "login_disabled",
        "message": "Login is not enabled on this server.",
        "status": 404,
    }), 404


def _extract_token_from_request() -> str | None:
    """Extract bearer or API-key token from request headers.

    Does NOT log the token value.
    """
    # Authorization: Bearer <token>
    auth_header = flask.request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()

    # X-API-Key: <token>
    api_key = flask.request.headers.get("X-API-Key", "").strip()
    if api_key:
        return api_key

    return None


def _request_has_valid_api_token() -> bool:
    api_token = _get_api_token()
    token = _extract_token_from_request()
    return bool(api_token and token and hmac.compare_digest(str(token), str(api_token)))


def is_current_session_authenticated() -> bool:
    if _is_identity_enabled():
        username = str(flask.session.get("lzcore_user") or "")
        if not username:
            return False
        from backend.core.identity import get_user
        identity_user = get_user(username)
        if identity_user and identity_user.get("enabled", True) and (
            identity_user.get("user_id")
            and flask.session.get("lzcore_user_id") == identity_user["user_id"]
            and flask.session.get("lzcore_auth_version") == identity_user.get("auth_version", "legacy")
            and flask.session.get("lzcore_identity_type") == "managed"
        ):
            flask.g.verified_identity_user = identity_user
            flask.session["lzcore_role"] = identity_user.get("role", "viewer")
            flask.session["lzcore_org"] = identity_user.get("organization_id", "default")
            flask.session["lzcore_workspaces"] = list(identity_user.get("workspace_ids") or [])
            flask.session["lzcore_home_workspace"] = identity_user.get("home_workspace_id", "")
            return True
        configured_username = _get_login_username()
        if identity_user is None and configured_username and hmac.compare_digest(username.encode("utf-8"), configured_username.encode("utf-8")) and (
            flask.session.get("lzcore_identity_type") == "bootstrap"
            and flask.session.get("lzcore_auth_version") == _configured_auth_version()
        ):
            flask.session["lzcore_role"] = "admin"
            flask.session["lzcore_org"] = "default"
            flask.session["lzcore_workspaces"] = ["default"]
            flask.session["lzcore_home_workspace"] = "default"
            return True
        flask.session.clear()
        return False
    if not _is_login_enabled():
        return False
    username = _get_login_username()
    session_user = flask.session.get("lzcore_user")
    return bool(username and session_user and hmac.compare_digest(str(session_user).encode("utf-8"), username.encode("utf-8")))


def _configured_auth_version() -> str:
    """A credential generation that does not expose a password digest."""
    import hashlib
    key = str(flask.current_app.secret_key or "").encode()
    return hmac.new(key, (_get_login_username() + "\0" + _get_login_password()).encode(), hashlib.sha256).hexdigest()


def authenticated_request_context() -> dict | None:
    """Build request-local authority from verified credentials, never request data."""
    if hasattr(flask.g, "authenticated_context"):
        return flask.g.authenticated_context
    context = None
    if _request_has_valid_api_token():
        context = {
            "principal_type": "api_token", "user_id": "api-token",
            "username": "api-token", "role": "owner", "platform_admin": True,
            "organization_id": "default", "workspace_ids": ["default"],
            "home_workspace_id": "default",
        }
        context["credential_version"] = _token_version(_get_api_token())
    elif is_current_session_authenticated():
        username = str(flask.session.get("lzcore_user") or "")
        role = str(flask.session.get("lzcore_role") or "")
        current = None
        if _is_identity_enabled():
            current = getattr(flask.g, "verified_identity_user", None)
        from backend.core.identity import _bootstrap_storage_id, resolve_user_storage_id
        storage_id = (current or {}).get("user_id") or (
            _bootstrap_storage_id(username) if _is_identity_enabled() else resolve_user_storage_id(username)
        )
        context = {
            "principal_type": "session", "user_id": str(storage_id),
            "username": username, "role": role,
            "platform_admin": _is_identity_enabled() and (current is None or role == "owner"),
            "organization_id": str(flask.session.get("lzcore_org") or ""),
            "workspace_ids": list(flask.session.get("lzcore_workspaces") or []),
            "home_workspace_id": str(flask.session.get("lzcore_home_workspace") or ""),
            "identity_type": flask.session.get("lzcore_identity_type", "bootstrap"),
            "auth_version": flask.session.get("lzcore_auth_version") or _configured_auth_version(),
            "configured_version": _token_version(_get_login_username() + "\0" + _get_login_password()),
        }
    flask.g.authenticated_context = context
    return context


def _token_version(token: str) -> str:
    import hashlib
    return hashlib.sha256(str(token or "").encode()).hexdigest()


def capture_stream_authority() -> dict:
    context = authenticated_request_context()
    if context is not None:
        return dict(context)
    if not (_is_identity_enabled() or _is_login_enabled() or _is_auth_enabled()):
        return {"principal_type": "personal", "username": ""}
    return {"principal_type": "denied"}


def stream_authority_allowed(context: dict, workspace_id: str, *, write: bool = False) -> bool:
    """Revalidate a captured credential before each long-lived transport send."""
    try:
        from backend.core.identity import can_access_workspace, get_user, validate_username
        kind = context.get("principal_type")
        if kind == "personal":
            return not (_is_identity_enabled() or _is_login_enabled() or _is_auth_enabled())
        if kind == "api_token":
            token = _get_api_token()
            return bool(token and context.get("credential_version") == _token_version(token))
        if kind != "session":
            return False
        username = context["username"]
        if context.get("identity_type") == "managed":
            validate_username(username)
            current = get_user(username)
            if not current or not current.get("enabled", True) or not current.get("user_id"):
                return False
            if current["user_id"] != context.get("user_id") or current.get("auth_version", "legacy") != context.get("auth_version"):
                return False
            return current.get("role") == "owner" or can_access_workspace(
                current.get("role", "viewer"), current.get("workspace_ids", []), workspace_id, write=write,
            )
        return bool(
            _get_login_username() == username and _get_login_password()
            and context.get("configured_version") == _token_version(username + "\0" + _get_login_password())
            and (not _is_identity_enabled() or get_user(username) is None)
        )
    except Exception:
        return False


def storage_principal_for_authority(context: dict):
    from backend.core.identity import _bootstrap_storage_id
    from storage.principal import VerifiedStoragePrincipal
    if context.get("principal_type") == "personal":
        return ""
    storage_id = _bootstrap_storage_id("service/api-token") if context.get("principal_type") == "api_token" else context["user_id"]
    return VerifiedStoragePrincipal(context["username"], storage_id)


def handle_auth_status():
    context = authenticated_request_context()
    api_token_authenticated = bool(context and context["principal_type"] == "api_token")
    session_authenticated = bool(context and context["principal_type"] == "session")
    authenticated = session_authenticated or api_token_authenticated
    # Project the loopback personal-mode authority used by privileged writes.
    # Token/login/identity deployments must never inherit this UI capability.
    personal_mode = not (_is_auth_enabled() or _is_login_enabled() or _is_identity_enabled())
    platform_admin = bool(context and context["platform_admin"]) or (
        personal_mode and _is_loopback_host(get_effective_client_address())
    )
    return flask.jsonify({
        "ok": True,
        "login_enabled": _is_login_enabled() or _is_identity_enabled(),
        "api_token_required": _is_auth_enabled() and not authenticated,
        "browser_login_available": _is_login_enabled() or _is_identity_enabled(),
        "authenticated": authenticated,
        "username": "api-token" if api_token_authenticated else (
            flask.session.get("lzcore_user") if session_authenticated else ""
        ),
        "role": "owner" if api_token_authenticated else (
            flask.session.get("lzcore_role", "") if session_authenticated else ""
        ),
        "organization_id": "default" if api_token_authenticated else (
            flask.session.get("lzcore_org", "") if session_authenticated else ""
        ),
        "workspace_ids": ["default"] if api_token_authenticated else (
            list(flask.session.get("lzcore_workspaces") or []) if session_authenticated else []
        ),
        "home_workspace_id": "default" if api_token_authenticated else (
            flask.session.get("lzcore_home_workspace", "") if session_authenticated else ""
        ),
        "identity_enabled": _is_identity_enabled(),
        "oidc_enabled": os.environ.get("LZCORE_OIDC_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"},
        "platform_admin": platform_admin,
        "auth_type": "api_token" if api_token_authenticated else (
            "session" if session_authenticated else "none"
        ),
    })


def establish_identity_session(identity_user: dict) -> None:
    """Create the canonical browser session for a verified identity."""
    flask.session.clear()
    if not identity_user.get("user_id"):
        raise ValueError("immutable user_id required")
    flask.session["lzcore_identity_type"] = "managed"
    flask.session["lzcore_user_id"] = identity_user["user_id"]
    flask.session["lzcore_auth_version"] = identity_user.get("auth_version", "legacy")
    flask.session["lzcore_user"] = identity_user["username"]
    flask.session["lzcore_role"] = identity_user.get("role", "viewer")
    flask.session["lzcore_org"] = identity_user.get("organization_id", "default")
    flask.session["lzcore_workspaces"] = list(
        identity_user.get("workspace_ids") or [identity_user.get("organization_id", "default")]
    )
    flask.session["lzcore_home_workspace"] = identity_user.get("home_workspace_id", "")


def handle_auth_login():
    if not (_is_login_enabled() or _is_identity_enabled()):
        return _login_disabled_response()
    payload = flask.request.get_json(silent=True) or {}
    username = str(payload.get("username", ""))
    password = str(payload.get("password", ""))
    configured_username = _get_login_username()
    configured_password = _get_login_password()
    identity_user = None
    if _is_identity_enabled():
        from backend.core.identity import verify_user
        identity_user = verify_user(username, password)
        if identity_user:
            establish_identity_session(identity_user)
            return flask.jsonify({"ok": True, "username": identity_user["username"], "role": identity_user.get("role", "viewer")})
    if (
        configured_username
        and configured_password
        # compare_digest(str, str) raises TypeError for non-ASCII input.
        # UTF-8 bytes preserve constant-time comparison and make invalid
        # credentials return the normal 401 response instead of HTTP 500.
        and hmac.compare_digest(username.encode("utf-8"), configured_username.encode("utf-8"))
        and hmac.compare_digest(password.encode("utf-8"), configured_password.encode("utf-8"))
    ):
        flask.session.clear()
        flask.session["lzcore_user"] = configured_username
        flask.session["lzcore_identity_type"] = "bootstrap"
        flask.session["lzcore_auth_version"] = _configured_auth_version()
        if _is_identity_enabled():
            flask.session["lzcore_role"] = "admin"
            flask.session["lzcore_org"] = "default"
            flask.session["lzcore_workspaces"] = ["default"]
            flask.session["lzcore_home_workspace"] = "default"
        return flask.jsonify({"ok": True, "username": configured_username})
    logger.warning("login_denied: username=%s", username[:64])
    return _unauthorized_response("Invalid username or password")


def handle_auth_logout():
    flask.session.clear()
    return flask.jsonify({"ok": True})


def _configured_dev_origins() -> set[str]:
    raw = os.environ.get("LZCORE_ALLOWED_ORIGINS", "")
    origins = {item.strip().rstrip("/") for item in raw.split(",") if item.strip()}
    ports = _configured_workbench_ports()
    for port in ports:
        origins.update({
            f"http://localhost:{port}",
            f"http://127.0.0.1:{port}",
            f"http://[::1]:{port}",
        })
    return origins


def _configured_workbench_ports() -> set[int]:
    raw = os.environ.get("LZCORE_WORKBENCH_PORTS", "5273,5274")
    ports: set[int] = set()
    for item in raw.split(","):
        try:
            port = int(item.strip())
        except ValueError:
            continue
        if 1 <= port <= 65535:
            ports.add(port)
    return ports or {5273, 5274}


def _browser_local_token_required() -> bool:
    if _is_auth_enabled() or _is_login_enabled() or _is_identity_enabled():
        return False
    if flask.request.method in {"GET", "HEAD", "OPTIONS"}:
        return False
    if flask.request.path == "/api/local-token":
        return False
    return bool(flask.request.headers.get("Origin"))


def _presented_local_token_matches() -> bool:
    from backend.core.local_token import local_browser_token_matches
    presented = flask.request.headers.get("X-LZCore-Local-Token", "")
    return local_browser_token_matches(presented)


def _hostname_from_host_header(host_header: str) -> str:
    """Return the hostname from a Host header, including bracketed IPv6."""
    host = (host_header or "").split("@")[-1].strip()
    if host.startswith("[") and "]" in host:
        return host[1:host.index("]")].lower()
    if host.count(":") == 1:
        hostname, _, port = host.rpartition(":")
        if port.isdigit():
            return hostname.lower()
    return host.lower()


def _is_loopback_host(hostname: str) -> bool:
    value = (hostname or "").strip().lower()
    if value in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(ip.is_loopback)


def _unauthenticated_host_allowed(hostname: str) -> bool:
    """Personal authority requires loopback or an individually configured host."""
    value = (hostname or "").strip().lower()
    if _is_loopback_host(value):
        return True
    allowed_hosts = {
        item.strip().lower()
        for item in os.environ.get("LZCORE_ALLOWED_HOSTS", "").split(",")
        if item.strip()
    }
    if value in allowed_hosts:
        return True
    return False


def _is_local_or_private_host(hostname: str) -> bool:
    value = (hostname or "").strip().lower()
    if value in {"localhost", "127.0.0.1", "::1"}:
        return True
    allowed_hosts = {
        h.strip().lower()
        for h in os.environ.get("LZCORE_ALLOWED_HOSTS", "").split(",")
        if h.strip()
    }
    if value in allowed_hosts:
        return True
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        allow_lan = os.environ.get("LZCORE_ALLOW_LAN", "false").strip().lower() in ("true", "1", "yes", "on")
        allow_mdns = os.environ.get("LZCORE_ALLOW_MDNS", "false").strip().lower() in ("true", "1", "yes", "on")
        if allow_lan or allow_mdns:
            return value.endswith(".local")
        return False
    shared_cgnat = ipaddress.ip_network("100.64.0.0/10")
    return bool(ip.is_loopback or ip.is_private or ip.is_link_local or ip in shared_cgnat)


def is_allowed_browser_origin(origin: str | None, request_host: str) -> bool:
    """Return True when a browser write comes from this API host or the local workbench."""
    if not origin:
        return True
    try:
        origin_url = urlparse(origin)
        if origin_url.scheme not in {"http", "https"} or not origin_url.hostname or origin_url.username is not None or origin_url.password is not None:
            return False
        origin_root = f"{origin_url.scheme}://{origin_url.netloc}".rstrip("/")
        host = request_host.split("@")[-1]
        origin_hostname = (origin_url.hostname or "").lower()
        if host.startswith("[") and "]" in host:
            request_hostname = host[1:host.index("]")].lower()
            request_port_s = host.split("]:")[-1] if "]:" in host else ""
            request_port = int(request_port_s) if request_port_s.isdigit() else (443 if origin_url.scheme == "https" else 80)
        elif ":" in host:
            request_hostname, _, request_port_s = host.rpartition(":")
            request_hostname = request_hostname.lower()
            request_port = int(request_port_s) if request_port_s.isdigit() else 80
        else:
            request_hostname = host.lower()
            request_port = 80
        origin_port = origin_url.port or (443 if origin_url.scheme == "https" else 80)

        # DNS rebinding protection: even if origin == host, the host must be a valid local or private host
        # when authentication is disabled.
        if origin_hostname == request_hostname and origin_port == request_port:
            if not _is_auth_enabled() and not _is_login_enabled() and not _is_identity_enabled():
                return _unauthenticated_host_allowed(request_hostname)
            return True

        allowed_ports = _configured_workbench_ports()
        try:
            from backend.core.settings import UNIFIED_PORT
            allowed_ports = set(allowed_ports)
            allowed_ports.add(int(UNIFIED_PORT))
        except Exception:
            allowed_ports = set(allowed_ports)
        if (
            origin_url.scheme in {"http", "https"}
            and origin_port in allowed_ports
            and _unauthenticated_host_allowed(origin_hostname)
            and _unauthenticated_host_allowed(request_hostname)
        ):
            return True
        return origin_root in _configured_dev_origins()
    except Exception:
        return False


def _same_origin_api_request() -> bool:
    """Reject browser cross-site writes when token auth is disabled."""
    if flask.request.method in {"GET", "HEAD", "OPTIONS"}:
        return True
    origin = flask.request.headers.get("Origin") or flask.request.headers.get("Referer")
    return is_allowed_browser_origin(origin, flask.request.host)


def _csrf_response() -> flask.Response:
    return flask.jsonify({
        "ok": False,
        "error": "csrf_origin_denied",
        "message": "Cross-origin API writes are denied.",
        "status": 403,
    }), 403


def register_auth_middleware(app: flask.Flask) -> None:
    """Register before_request auth middleware on a Flask app.

    Call after all routes are defined but before first request.
    """
    if _is_login_enabled() or _is_identity_enabled():
        app.secret_key = _secret_value("LZCORE_SESSION_SECRET") or _get_api_token() or secrets.token_urlsafe(32)
        app.config.update(
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE=os.environ.get("LZCORE_SESSION_SAMESITE", "Lax"),
            SESSION_COOKIE_SECURE=os.environ.get("LZCORE_SESSION_SECURE", "false").strip().lower() in ("true", "1", "yes", "on"),
        )
        logger.info("Web login authentication enabled")

    if not _AUTH_ENABLED:
        logger.info("API token authentication disabled; CSRF origin checks remain enabled")
    elif not _API_TOKEN:
        logger.warning(
            "LZCORE_AUTH_ENABLED=true but LZCORE_API_TOKEN is empty! "
            "All protected endpoints will reject requests."
        )
    else:
        logger.info(
            "API authentication enabled — %d public prefixes, %d public exact paths",
            len(_PUBLIC_PREFIXES), len(_PUBLIC_EXACT),
        )

    @app.before_request
    def _auth_before_request():
        # OPTIONS preflight — always allow
        if flask.request.method == "OPTIONS":
            return None

        path = flask.request.path

        # DNS Rebinding protection: When authentication is disabled,
        # request Host must be loopback or individually allowlisted.
        if not _is_auth_enabled() and not _is_login_enabled() and not _is_identity_enabled():
            if not _unauthenticated_host_allowed(_hostname_from_host_header(flask.request.host)):
                logger.warning("host_rejected_untrusted: host=%s path=%s", flask.request.host, path)
                return flask.jsonify({
                    "ok": False,
                    "error": "host_header_invalid",
                    "message": "Host header must be loopback or explicitly allowlisted when authentication is disabled.",
                    "status": 403,
                }), 403
            if (path == "/api/local-token" or flask.request.method not in {"GET", "HEAD", "OPTIONS"}) and not _unauthenticated_host_allowed(get_effective_client_address()):
                return flask.jsonify({"ok": False, "error": "local_client_required"}), 403
            if _browser_local_token_required() and not _presented_local_token_matches():
                logger.warning("local_token_denied: path=%s", path)
                return flask.jsonify({
                    "ok": False,
                    "error": "local_token_required",
                    "message": "Browser requests in personal mode must present the local token.",
                }), 403

        if path.startswith("/api/") and not _same_origin_api_request():
            logger.warning("csrf_denied: path=%s origin=%s", path, flask.request.headers.get("Origin", ""))
            return _csrf_response()

        # Re-evaluate env vars each request (for test monkeypatching)
        if _is_login_enabled() or _is_identity_enabled():
            if is_public_path(path):
                return None
            context = authenticated_request_context()
            session_authenticated = bool(context and context["principal_type"] == "session")
            api_token_authenticated = bool(context and context["principal_type"] == "api_token")
            if session_authenticated or api_token_authenticated:
                workspace_error = _bind_request_workspace()
                if workspace_error:
                    return workspace_error
                from storage.principal import set_storage_principal
                flask.g._storage_principal_token = set_storage_principal(storage_principal_for_authority(context))
                denied = _authorize_identity_request()
                return denied
            logger.warning("auth_denied: path=%s reason=no_login_session", path)
            return _unauthorized_response("Login required")

        if not _is_auth_enabled():
            if path.startswith("/api/"):
                return _bind_request_workspace()
            return None

        # Public endpoints — no auth
        if is_public_path(path):
            return None

        # Protected endpoints — require token
        token = _extract_token_from_request()
        api_token = _get_api_token()

        if not api_token:
            logger.error("auth_denied: LZCORE_API_TOKEN is empty but auth is enabled")
            return _unauthorized_response("Server authentication misconfigured — no API token set")

        if not token:
            logger.warning("auth_denied: path=%s reason=no_token", path)
            return _unauthorized_response("Missing API token — provide Authorization: Bearer <token> or X-API-Key: <token>")

        # Constant-time comparison: prevents timing-based token leakage.
        if not hmac.compare_digest(str(token), str(api_token)):
            logger.warning("auth_denied: path=%s reason=invalid_token", path)
            return _unauthorized_response("Invalid API token")

        # Token valid — proceed
        workspace_error = _bind_request_workspace()
        if workspace_error:
            return workspace_error
        from storage.principal import set_storage_principal
        flask.g._storage_principal_token = set_storage_principal(storage_principal_for_authority(authenticated_request_context()))
        return None

    # Register teardown to clean up any auth state if needed
    @app.teardown_request
    def _auth_teardown(exc=None):
        token = getattr(flask.g, "_storage_principal_token", None)
        if token is not None:
            from storage.principal import reset_storage_principal
            reset_storage_principal(token)


def _bind_request_workspace():
    """Resolve the request data boundary after authentication, before routing."""
    try:
        flask.g.request_workspace_id = _request_workspace_id()
    except ValueError:
        return flask.jsonify({
            "ok": False,
            "error": "workspace_id_conflict",
            "message": "workspace_id must be identical in every request source",
        }), 400
    return None


def _authorize_identity_request():
    """Enforce workspace and control-plane RBAC after authentication."""
    if not _is_identity_enabled() or _request_has_valid_api_token():
        return None
    path = flask.request.path
    role = str(flask.session.get("lzcore_role") or "viewer")
    context = authenticated_request_context() or {}
    platform_admin = bool(context.get("platform_admin"))
    global_admin = (
        path.startswith("/api/admin/") and not path.startswith("/api/admin/operation-ledger")
        or path.startswith("/api/jobs/worker/")
        or path.startswith("/api/agent/llm/") and path not in {"/api/agent/llm/test", "/api/agent/llm/models"} and flask.request.method not in {"GET", "HEAD"}
    )
    if global_admin and not platform_admin:
        return flask.jsonify({"ok": False, "error": "platform_admin_required"}), 403
    if path.startswith("/api/identity/") and not _role_at_least(role, "admin"):
        return flask.jsonify({"ok": False, "error": "forbidden"}), 403
    if path == "/api/workspaces" and flask.request.method == "POST" and not _role_at_least(role, "admin"):
        return flask.jsonify({"ok": False, "error": "forbidden"}), 403
    if path == "/api/workspaces/batch-delete":
        data = flask.request.get_json(silent=True) or {}
        ids = data.get("workspace_ids") if isinstance(data, dict) else None
        if not isinstance(ids, list) or not ids:
            return flask.jsonify({"ok": False, "error": "invalid_workspace_ids"}), 400
        denied = authorize_workspace_control(ids)
        if denied:
            return denied
    if path.startswith("/api/admin/") and not _role_at_least(role, "admin"):
        return flask.jsonify({"ok": False, "error": "admin_required"}), 403
    if path.startswith("/api/jobs/worker/") and not _role_at_least(role, "admin"):
        return flask.jsonify({"ok": False, "error": "admin_required"}), 403
    if path == "/api/workflows" and flask.request.method == "POST" and not _role_at_least(role, "developer"):
        return flask.jsonify({"ok": False, "error": "workflow_developer_required"}), 403
    if path.startswith("/api/workflows/") and flask.request.method in {"PUT", "DELETE"} and not _role_at_least(role, "developer"):
        return flask.jsonify({"ok": False, "error": "workflow_developer_required"}), 403
    if (path.startswith("/api/workflows/") and path.endswith("/runs") or path.startswith("/api/workflow-runs/")) and flask.request.method == "POST" and not _role_at_least(role, "operator"):
        return flask.jsonify({"ok": False, "error": "workflow_operator_required"}), 403
    # Connectivity probing is a read-only health operation. Ordinary users may
    # test an already saved provider; the handler discards draft overrides.
    if path.startswith("/api/agent/llm/") and path != "/api/agent/llm/test" and flask.request.method not in {"GET", "HEAD"} and not _role_at_least(role, "admin"):
        return flask.jsonify({"ok": False, "error": "forbidden"}), 403
    if path.startswith("/api/extensions/"):
        extension_denied = _authorize_extension_request(path, role, platform_admin=platform_admin)
        if extension_denied:
            return extension_denied
    workspace_id = request_workspace_id()
    if not workspace_id:
        return None
    if (flask.request.method == "DELETE" and path == f"/api/workspaces/{workspace_id}") or path == f"/api/workspaces/{workspace_id}/rename":
        denied = authorize_workspace_control([workspace_id])
        if denied:
            return denied
        return None
    if platform_admin:
        return None
    try:
        from backend.core.identity import can_access_workspace
        allowed = can_access_workspace(role, list(flask.session.get("lzcore_workspaces") or []), workspace_id, write=flask.request.method not in {"GET", "HEAD"})
    except Exception:
        allowed = False
    if not allowed:
        return flask.jsonify({"ok": False, "error": "workspace_forbidden"}), 403
    return None


def authorize_workspace_control(workspace_ids):
    """Preflight the complete shared control-plane operation before mutation."""
    from storage.ids import validate_workspace_id
    try:
        ids = [validate_workspace_id(item) for item in workspace_ids]
    except (TypeError, ValueError):
        return flask.jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
    if not _is_identity_enabled():
        return None
    context = authenticated_request_context()
    if not context:
        return flask.jsonify({"ok": False, "error": "forbidden"}), 403
    if context.get("platform_admin"):
        return None
    from backend.core.identity import list_organizations
    from storage.paths import workspace_catalog_root
    import json
    try:
        organizations = list_organizations()
        for workspace_id in ids:
            owners = [item["organization_id"] for item in organizations if workspace_id in item.get("workspace_ids", [])]
            state = json.loads((workspace_catalog_root(workspace_id) / "sys" / "state.json").read_text(encoding="utf-8"))
            same_org = owners == [context["organization_id"]] and state.get("organization_id") == context["organization_id"]
            owner = bool(state.get("owner_user_id") and state["owner_user_id"] == context["user_id"])
            if not same_org or not (owner or _role_at_least(context["role"], "admin")):
                return flask.jsonify({"ok": False, "error": "workspace_control_forbidden"}), 403
    except Exception:
        return flask.jsonify({"ok": False, "error": "workspace_control_forbidden"}), 403
    return None


def _request_workspace_id() -> str:
    """Resolve the request workspace once and reject ambiguous boundaries.

    Authorization and route handlers may consume different transport shapes
    (path, query, JSON, or multipart form).  A request must therefore name at
    most one workspace value across all of them; source precedence would turn
    an otherwise harmless duplicate field into an authorization bypass.
    """
    import re
    values: list[str] = []
    match = re.match(r"^/api/workspaces/([^/]+)", flask.request.path)
    if match and match.group(1) not in {"batch-delete"}:
        values.append(str(match.group(1)).strip())
    query_value = str(flask.request.args.get("workspace_id", "") or "").strip()
    if query_value:
        values.append(query_value)
    if flask.request.is_json:
        data = flask.request.get_json(silent=True) or {}
        # Let the route validate non-object JSON rather than failing before it.
        json_value = str(data.get("workspace_id") or "").strip() if isinstance(data, dict) else ""
        if json_value:
            values.append(json_value)
    else:
        form_value = str(flask.request.form.get("workspace_id") or "").strip()
        if form_value:
            values.append(form_value)
    distinct = set(values)
    if len(distinct) > 1:
        raise ValueError("workspace_id_conflict")
    return values[0] if values else ""


def request_workspace_id() -> str:
    """Return the workspace boundary resolved by the request middleware."""
    if flask.has_request_context() and hasattr(flask.g, "request_workspace_id"):
        return str(flask.g.request_workspace_id or "")
    return _request_workspace_id()


def _role_at_least(role: str, minimum: str) -> bool:
    from backend.core.identity import has_role
    return has_role(role, minimum)


def _authorize_extension_request(path: str, role: str, *, platform_admin: bool):
    import re
    if path == "/api/extensions/repository" or path.startswith("/api/extensions/repository/"):
        if not platform_admin:
            return flask.jsonify({"ok": False, "error": "extension_admin_required"}), 403
        return None
    lifecycle = re.match(r"^/api/extensions/([^/]+)/(enable|disable|migrate|install|upgrade|uninstall)", path)
    if lifecycle and (not _role_at_least(role, "admin") or not platform_admin and lifecycle.group(2) != "migrate"):
        return flask.jsonify({"ok": False, "error": "extension_admin_required"}), 403
    match = re.match(r"^/api/extensions/([^/]+)", path)
    if not match:
        return None
    extension_id = match.group(1)
    try:
        from extensions.registry import ExtensionRegistry
        manifest = next((item for item in ExtensionRegistry().discover() if item.extension_id == extension_id), None)
    except Exception:
        manifest = None
    if manifest is None:
        return flask.jsonify({"ok": False, "error": "extension_not_found"}), 404
    if not lifecycle:
        from extensions.state import get_extension_state
        if not get_extension_state(extension_id, default_enabled=manifest.enabled)["enabled"]:
            return flask.jsonify({"ok": False, "error": "extension_disabled"}), 409
    minimum = str(manifest.metadata.get("minimum_role") or "viewer")
    if not _role_at_least(role, minimum):
        return flask.jsonify({"ok": False, "error": "extension_role_forbidden"}), 403
    if flask.request.method not in {"GET", "HEAD"}:
        write_role = str(manifest.metadata.get("minimum_write_role") or "developer")
        if not _role_at_least(role, write_role):
            return flask.jsonify({"ok": False, "error": "extension_write_forbidden"}), 403
    return None
