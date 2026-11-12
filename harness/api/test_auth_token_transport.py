import pytest

from flask import Flask

from backend.core.auth import _extract_token_from_request


def test_api_token_is_never_accepted_from_query_string():
    app = Flask(__name__)
    with app.test_request_context("/api/agent/sse?access_token=secret-token"):
        assert _extract_token_from_request() is None


def test_api_token_headers_remain_supported():
    app = Flask(__name__)
    with app.test_request_context(
        "/api/agent/sse",
        headers={"Authorization": "Bearer secret-token"},
    ):
        assert _extract_token_from_request() == "secret-token"


def test_api_token_auth_status_is_a_browser_usable_owner_session(monkeypatch):
    monkeypatch.setenv("LZCORE_API_TOKEN", "secret-token")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true")
    from backend.core.auth import handle_auth_status

    app = Flask(__name__)
    app.secret_key = "test-secret"
    with app.test_request_context(
        "/api/auth/status",
        headers={"Authorization": "Bearer secret-token"},
        environ_base={"REMOTE_ADDR": "192.168.1.20"},
    ):
        status = handle_auth_status().get_json()
    assert status["authenticated"] is True
    assert status["username"] == "api-token"
    assert status["role"] == "owner"
    assert status["platform_admin"] is True
    assert status["auth_type"] == "api_token"
    assert status["api_token_required"] is False
    with app.test_request_context(
        "/api/agent/sse",
        headers={"X-API-Key": "secret-token"},
    ):
        assert _extract_token_from_request() == "secret-token"


@pytest.mark.parametrize("remote,auth_enabled,login_enabled,identity_enabled,expected", [
    ("127.0.0.1", False, False, False, True),
    ("::1", False, False, False, True),
    ("::ffff:127.0.0.1", False, False, False, True),
    ("192.168.1.20", False, False, False, False),
    ("", False, False, False, False),
    ("127.0.0.1", True, False, False, False),
    ("127.0.0.1", False, True, False, False),
    ("127.0.0.1", False, False, True, False),
])
def test_anonymous_auth_status_projects_only_actual_personal_mode_authority(
    monkeypatch, remote, auth_enabled, login_enabled, identity_enabled, expected,
):
    import backend.core.auth as auth
    monkeypatch.setattr(auth, "_is_auth_enabled", lambda: auth_enabled)
    monkeypatch.setattr(auth, "_is_login_enabled", lambda: login_enabled)
    monkeypatch.setattr(auth, "_is_identity_enabled", lambda: identity_enabled)
    monkeypatch.setattr(auth, "_request_has_valid_api_token", lambda: False)
    monkeypatch.setattr(auth, "is_current_session_authenticated", lambda: False)
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    with app.test_request_context("/api/auth/status", environ_base={"REMOTE_ADDR": remote}):
        status = auth.handle_auth_status().get_json()
    assert status["platform_admin"] is expected
    assert status["authenticated"] is False
    assert status["username"] == ""
    assert status["role"] == ""
    assert status["api_token_required"] is auth_enabled
    assert status["browser_login_available"] is (login_enabled or identity_enabled)


@pytest.mark.parametrize("credential,login,identity,required", [
    (None, False, False, True),
    ("invalid", False, False, True),
    ("valid", False, False, False),
    ("cookie", True, False, False),
    ("cookie", False, True, False),
    (None, True, False, True),
    (None, False, True, True),
])
def test_auth_status_reports_token_gate_without_changing_existing_authentication(
    monkeypatch, credential, login, identity, required,
):
    import backend.core.auth as auth
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true")
    monkeypatch.setenv("LZCORE_API_TOKEN", "valid")
    monkeypatch.setenv("LZCORE_LOGIN_ENABLED", "true" if login else "false")
    monkeypatch.setenv("LZCORE_LOGIN_USERNAME", "browser-user")
    monkeypatch.setattr(auth, "_is_identity_enabled", lambda: identity)
    monkeypatch.setattr("backend.core.identity.get_user", lambda _: {"enabled": True, "role": "viewer"})
    app = Flask(__name__)
    app.secret_key = "test-secret"
    auth.register_auth_middleware(app)
    app.add_url_rule("/api/auth/status", view_func=auth.handle_auth_status)
    client = app.test_client()
    if credential == "cookie":
        with client.session_transaction() as cookie:
            cookie["lzcore_user"] = "browser-user"
    headers = {"Authorization": f"Bearer {credential}"} if credential in {"valid", "invalid"} else {}
    response = client.get("/api/auth/status", headers=headers)
    assert response.status_code == 200
    assert response.json["api_token_required"] is required
    assert response.json["browser_login_available"] is (login or identity)
    assert response.json["authenticated"] is (credential in {"valid", "cookie"})
    assert response.json["login_enabled"] is (login or identity)


@pytest.mark.parametrize("remote,forwarded,local", [
    ("127.0.0.1", None, True),
    ("192.168.1.20", None, False),
    ("127.0.0.1", "192.168.1.20", False),
    ("127.0.0.1", "127.0.0.1, 192.168.1.20", False),
    ("127.0.0.1", "127.0.0.1", True),
    ("192.168.1.20", "127.0.0.1", False),
    ("::1", " 127.0.0.1, 192.168.1.20 ", False),
    ("::ffff:127.0.0.1", "192.168.1.20", False),
    ("127.0.0.1", "::1", True),
    ("127.0.0.1", "invalid-address", False),
    ("127.0.0.1", "127.0.0.1, ", False),
    ("127.0.0.1", "", False),
])
@pytest.mark.parametrize("valid_token", [False, True])
def test_lan_personal_mode_status_matches_privileged_write_guard(
    monkeypatch, remote, forwarded, local, valid_token,
):
    from backend.core.auth import register_auth_middleware, handle_auth_status, deny_remote_admin_write

    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true" if valid_token else "false")
    monkeypatch.setenv("LZCORE_API_TOKEN", "test-service-token" if valid_token else "")
    monkeypatch.setenv("LZCORE_ALLOW_LAN", "true")
    monkeypatch.setenv("LZCORE_ALLOW_UNAUTHENTICATED_NETWORK", "true")
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    register_auth_middleware(app)
    app.add_url_rule("/api/auth/status", view_func=handle_auth_status)
    app.add_url_rule("/api/admin/test-write", view_func=lambda: deny_remote_admin_write() or {"ok": True}, methods=["POST"])
    client = app.test_client()
    headers = {"X-Forwarded-For": forwarded} if forwarded is not None else {}
    if valid_token:
        headers["Authorization"] = "Bearer test-service-token"
    options = {
        "base_url": "http://192.168.1.8", "environ_overrides": {"REMOTE_ADDR": remote},
        "headers": headers,
    }
    response = client.get("/api/auth/status", **options)
    assert response.status_code == 200
    assert response.json["platform_admin"] is (local or valid_token)
    assert response.json["authenticated"] is valid_token
    write = client.post("/api/admin/test-write", **options)
    assert write.status_code == (200 if local or valid_token else 403)
    if not local and not valid_token:
        assert write.json["error"] == "remote_admin_write_denied"


def test_valid_token_keeps_admin_projection_with_ordinary_identity_cookie(monkeypatch):
    import flask
    import backend.core.auth as auth

    monkeypatch.setenv("LZCORE_API_TOKEN", "synthetic-service-token")
    monkeypatch.setattr(auth, "_is_identity_enabled", lambda: True)
    monkeypatch.setattr("backend.core.identity.get_user", lambda username: {"username": username, "role": "viewer"})
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    with app.test_request_context(
        "/api/auth/status", headers={"Authorization": "Bearer synthetic-service-token"},
        environ_base={"REMOTE_ADDR": "192.168.1.20"},
    ):
        flask.session["lzcore_user"] = "ordinary-user"
        status = auth.handle_auth_status().json
    assert status["platform_admin"] is True
    assert status["auth_type"] == "api_token"
    assert status["role"] == "owner"
