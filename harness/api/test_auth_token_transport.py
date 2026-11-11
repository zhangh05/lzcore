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


@pytest.mark.parametrize("auth_enabled,login_enabled,identity_enabled,expected", [
    (False, False, False, True),
    (True, False, False, False),
    (False, True, False, False),
    (False, False, True, False),
])
def test_anonymous_auth_status_projects_only_actual_personal_mode_authority(
    monkeypatch, auth_enabled, login_enabled, identity_enabled, expected,
):
    import backend.core.auth as auth
    monkeypatch.setattr(auth, "_is_auth_enabled", lambda: auth_enabled)
    monkeypatch.setattr(auth, "_is_login_enabled", lambda: login_enabled)
    monkeypatch.setattr(auth, "_is_identity_enabled", lambda: identity_enabled)
    monkeypatch.setattr(auth, "_request_has_valid_api_token", lambda: False)
    monkeypatch.setattr(auth, "is_current_session_authenticated", lambda: False)
    app = Flask(__name__)
    app.secret_key = "synthetic-session-secret"
    with app.test_request_context("/api/auth/status"):
        status = auth.handle_auth_status().get_json()
    assert status["platform_admin"] is expected
    assert status["authenticated"] is False
    assert status["username"] == ""
    assert status["role"] == ""
