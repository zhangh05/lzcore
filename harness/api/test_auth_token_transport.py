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


def test_lan_personal_mode_status_matches_privileged_write_guard(monkeypatch):
    from backend.core.auth import register_auth_middleware, handle_auth_status, deny_remote_admin_write

    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED"):
        monkeypatch.setenv(key, "false")
    monkeypatch.setenv("LZCORE_API_TOKEN", "")
    monkeypatch.setenv("LZCORE_ALLOW_LAN", "true")
    monkeypatch.setenv("LZCORE_ALLOW_UNAUTHENTICATED_NETWORK", "true")
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    register_auth_middleware(app)
    app.add_url_rule("/api/auth/status", view_func=handle_auth_status)
    app.add_url_rule("/api/admin/test-write", view_func=lambda: deny_remote_admin_write() or {"ok": True}, methods=["POST"])
    client = app.test_client()
    for remote, admin, code in [("127.0.0.1", True, 200), ("192.168.1.20", False, 403)]:
        options = {"base_url": "http://192.168.1.8", "environ_overrides": {"REMOTE_ADDR": remote}}
        response = client.get("/api/auth/status", **options)
        assert response.status_code == 200
        assert response.json["platform_admin"] is admin
        assert client.post("/api/admin/test-write", **options).status_code == code


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
