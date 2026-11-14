"""P1AUTH: real app entry points, isolated storage and no background services."""

import io
import threading

import pytest
from flask import request


@pytest.fixture
def app(monkeypatch, tmp_path):
    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED", "LZCORE_IDENTITY_ENABLED", "LZCORE_ALLOW_LAN"):
        monkeypatch.setenv(key, "false")
    for key in ("LZCORE_ALLOWED_HOSTS", "LZCORE_ALLOWED_ORIGINS"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("RATE_LIMIT_DISABLED", "true")
    monkeypatch.setattr(threading.Thread, "start", lambda self: None)
    from backend.main import create_app
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY="synthetic-session-secret")

    @app.post("/api/p1auth-probe")
    def probe():
        return {"ok": True, "payload": request.get_json() if request.is_json else dict(request.form)}

    return app


@pytest.mark.parametrize("origin", ["http://192.168.1.66:5273", "http://10.0.0.8:5274", "http://100.64.0.8:5273"])
def test_private_origin_cannot_read_local_token(app, origin):
    response = app.test_client().get("/api/local-token", base_url="http://127.0.0.1:8011", headers={"Origin": origin})
    assert response.status_code == 403
    assert "token" not in response.json
    assert "Access-Control-Allow-Origin" not in response.headers


def test_explicit_private_origin_can_read_local_token(app, monkeypatch):
    origin = "http://192.168.1.66:5273"
    monkeypatch.setenv("LZCORE_ALLOWED_ORIGINS", origin)
    response = app.test_client().get("/api/local-token", base_url="http://127.0.0.1:8011", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.json["token"]
    assert response.headers["Access-Control-Allow-Origin"] == origin
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
def test_loopback_cross_port_preflight_and_authenticated_write(app, host):
    client = app.test_client()
    base = f"http://{host}:8011"
    headers = {"Origin": f"http://{host}:5273"}
    preflight = client.options("/api/p1auth-probe", base_url=base, headers={
        **headers, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-lzcore-local-token,x-api-key",
    })
    assert preflight.status_code == 200
    allowed = {item.strip().lower() for item in preflight.headers["Access-Control-Allow-Headers"].split(",")}
    assert {"content-type", "x-lzcore-local-token", "x-api-key"} <= allowed
    issued = client.get("/api/local-token", base_url=base, headers=headers)
    assert issued.status_code == 200
    assert issued.headers["Cache-Control"] == "no-store"
    response = client.post("/api/p1auth-probe", base_url=base, json={"value": "ok"}, headers={
        **headers, "X-LZCore-Local-Token": issued.json["token"],
    })
    assert response.status_code == 200
    assert response.json["payload"] == {"value": "ok"}
    assert response.headers["Access-Control-Allow-Headers"] == preflight.headers["Access-Control-Allow-Headers"]


@pytest.mark.parametrize("forwarded", [None, "198.51.100.9", "127.0.0.1, 198.51.100.9", ""])
def test_remote_client_cannot_spoof_loopback_host_or_forwarding(app, forwarded):
    headers = {"X-Forwarded-For": forwarded} if forwarded is not None else {}
    remote = "198.51.100.9" if forwarded is None else "127.0.0.1"
    client = app.test_client()
    for path, method in [("/api/local-token", "GET"), ("/api/p1auth-probe", "POST")]:
        response = client.open(path, method=method, base_url="http://localhost:8011", headers=headers,
                               environ_base={"REMOTE_ADDR": remote})
        assert response.status_code == 403
        assert response.json["error"] == "local_client_required"


@pytest.mark.parametrize("path", ["/api/knowledge/upload", "/api/workspaces/mine/artifacts/upload", "/api/extensions/repository/publish", "/api/p1auth-probe"])
def test_body_limit_rejects_before_multipart_or_json_parsing(app, monkeypatch, path):
    app.config["MAX_CONTENT_LENGTH"] = 512
    def forbidden_parse(self):
        pytest.fail("oversized request reached multipart parsing")
    monkeypatch.setattr(app.request_class, "_load_form_data", forbidden_parse)
    response = app.test_client().post(path, data=b"x" * 513, content_type="multipart/form-data; boundary=test")
    assert response.status_code == 413
    assert response.json["error"] == "request_too_large"


@pytest.mark.parametrize("content_type", ["application/json", "multipart/form-data; boundary=test"])
def test_unknown_length_stream_is_limited_while_reading(app, content_type):
    app.config["MAX_CONTENT_LENGTH"] = 512
    stream = io.BytesIO(b"x" * 4096)
    response = app.test_client().post("/api/p1auth-probe", environ_overrides={
        "wsgi.input": stream, "wsgi.input_terminated": True,
        "CONTENT_LENGTH": "", "CONTENT_TYPE": content_type,
    })
    assert response.status_code == 413
    assert stream.tell() <= 513


@pytest.mark.parametrize("suffix", [b"", b" " * 2048], ids=["exact-limit", "over-limit"])
def test_unknown_length_json_is_not_silently_truncated(app, suffix):
    app.config["MAX_CONTENT_LENGTH"] = 512
    payload = b'{"field":"value"}'
    payload += b" " * (512 - len(payload))
    response = app.test_client().post("/api/p1auth-probe", environ_overrides={
        "wsgi.input": io.BytesIO(payload + suffix), "wsgi.input_terminated": True,
        "CONTENT_LENGTH": "", "CONTENT_TYPE": "application/json",
    })
    assert response.status_code == (413 if suffix else 200)


def test_normal_small_multipart_request_is_preserved(app):
    response = app.test_client().post("/api/p1auth-probe", data={"field": "value"}, content_type="multipart/form-data")
    assert response.status_code == 200
    assert response.json["payload"] == {"field": "value"}
