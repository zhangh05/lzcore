"""P1AUTH: Unicode sessions, service authority and secret projections."""

import pytest
from flask import Flask


@pytest.mark.parametrize("identity_enabled", [False, True])
def test_chinese_configured_login_remains_authenticated(monkeypatch, identity_enabled):
    from backend.core import auth, identity
    monkeypatch.setenv("LZCORE_LOGIN_ENABLED", "true")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    monkeypatch.setenv("LZCORE_LOGIN_USERNAME", "审查员")
    monkeypatch.setenv("LZCORE_LOGIN_PASSWORD", "synthetic-password")
    monkeypatch.setenv("LZCORE_SESSION_SECRET", "synthetic-secret")
    monkeypatch.setattr(auth, "_is_identity_enabled", lambda: identity_enabled)
    monkeypatch.setattr(identity, "get_user", lambda _: None)
    monkeypatch.setattr(identity, "verify_user", lambda *_: None)
    app = Flask(__name__)
    auth.register_auth_middleware(app)
    app.add_url_rule("/api/auth/login", view_func=auth.handle_auth_login, methods=["POST"])
    app.add_url_rule("/api/auth/status", view_func=auth.handle_auth_status)
    app.add_url_rule("/api/probe", view_func=lambda: {"ok": True})
    client = app.test_client()
    assert client.post("/api/auth/login", json={"username": "审查员", "password": "synthetic-password"}).status_code == 200
    assert client.get("/api/probe").status_code == 200
    assert client.get("/api/auth/status").json["authenticated"] is True
    with client.session_transaction() as cookie:
        cookie["lzcore_user"] = "另一位用户"
    assert client.get("/api/probe").status_code == 401


@pytest.fixture
def identity_app(monkeypatch):
    from backend.core import auth, identity
    from backend.api import identity_routes as routes
    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true")
    monkeypatch.setenv("LZCORE_API_TOKEN", "synthetic-service-token")
    monkeypatch.setenv("LZCORE_LOGIN_ENABLED", "false")
    monkeypatch.setenv("LZCORE_SESSION_SECRET", "synthetic-secret")
    monkeypatch.setattr(routes, "ensure_organization", lambda *_: None)
    monkeypatch.setattr("storage.workspace_store.list_workspace_ids", lambda: ["default"])
    user = {"username": "viewer", "user_id": "usr_" + "1" * 32, "role": "viewer", "enabled": True,
            "organization_id": "default", "workspace_ids": ["default"]}
    monkeypatch.setattr(identity, "get_user", lambda name: user if name == "viewer" else None)
    monkeypatch.setattr(routes, "list_users", lambda: [user])
    monkeypatch.setattr(routes, "list_organizations", lambda: [{"organization_id": "default"}])
    monkeypatch.setattr(routes, "list_memberships", lambda _: [{"username": "viewer"}])
    app = Flask(__name__)
    auth.register_auth_middleware(app)
    routes.register_identity_routes(app)
    app.add_url_rule("/api/auth/status", view_func=auth.handle_auth_status)
    return app


@pytest.mark.parametrize("header", ["Authorization", "X-API-Key"])
@pytest.mark.parametrize("cookie", [False, True])
def test_service_token_status_and_identity_routes_share_authority(identity_app, monkeypatch, header, cookie):
    from backend.api import identity_routes
    created = []
    monkeypatch.setattr(identity_routes, "create_organization", lambda *args: created.append(args) or {"organization_id": args[0]})
    client = identity_app.test_client()
    if cookie:
        with client.session_transaction() as session:
            session["lzcore_user"] = "viewer"
            session["lzcore_role"] = "viewer"
    headers = {header: "Bearer synthetic-service-token" if header == "Authorization" else "synthetic-service-token"}
    status = client.get("/api/auth/status", headers=headers).json
    assert (status["role"], status["platform_admin"], status["auth_type"]) == ("owner", True, "api_token")
    for path in ("users", "organizations", "organizations/default/memberships"):
        assert client.get(f"/api/identity/{path}", headers=headers).status_code == 200
    response = client.post("/api/identity/organizations", json={"organization_id": "new", "name": "New"}, headers=headers)
    assert response.status_code == 201
    assert created == [("new", "New")]
    with client.session_transaction() as session:
        assert session.get("lzcore_user", "") == ("viewer" if cookie else "")
        assert session.get("lzcore_role", "") == ("viewer" if cookie else "")
    assert client.get("/api/identity/users").status_code in {401, 403}


@pytest.mark.parametrize("token", [None, "wrong"])
def test_identity_rejects_forged_request_authority(identity_app, token):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = identity_app.test_client().get("/api/identity/users?role=owner&platform_admin=true", headers={
        **headers, "X-Principal-Type": "api_token", "X-Role": "owner",
    })
    assert response.status_code == 401


@pytest.mark.parametrize("key", ["a", "abcdefg", "abcdefgh", "abcdefghi", "abcdefghijkl", "abcdefghijklmnop"])
def test_all_secret_preview_projections_share_short_key_mask(key):
    from agent.llm.settings import mask_key, sanitize_llm_settings
    from agent.llm.provider_store import _sanitize
    from backend.api.llm_api import _sanitize_provider
    expected = f"**** ({len(key)} chars)" if len(key) <= 12 else "abcd****mnop"
    assert mask_key(key) == expected
    for sanitize in (sanitize_llm_settings, _sanitize, _sanitize_provider):
        projected = sanitize({"api_key": key})
        assert projected["key_preview"] == expected
        assert projected.get("api_key") is None


def test_viewer_provider_get_cannot_reconstruct_eight_character_secret(identity_app, monkeypatch):
    from backend.api import llm_api
    monkeypatch.setattr(llm_api, "provider_exists", lambda _: True)
    monkeypatch.setattr(llm_api, "load_provider_config", lambda _: {"api_key": "abcdefgh"})
    monkeypatch.setattr(llm_api, "get_active_provider", lambda: "synthetic")
    identity_app.add_url_rule("/api/agent/llm/providers/<provider_id>", view_func=llm_api.handle_provider_get)
    client = identity_app.test_client()
    with client.session_transaction() as cookie:
        cookie.update(lzcore_user="viewer", lzcore_user_id="usr_" + "1" * 32,
                      lzcore_auth_version="legacy", lzcore_identity_type="managed")
    response = client.get("/api/agent/llm/providers/synthetic")
    assert response.status_code == 200
    assert response.json["config"]["api_key"] is None
    assert response.json["config"]["key_preview"] == "**** (8 chars)"
