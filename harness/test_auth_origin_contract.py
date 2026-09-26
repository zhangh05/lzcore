"""Browser-origin write protection contracts."""

from backend.core.auth import is_allowed_browser_origin


def test_tailscale_workbench_port_can_write_to_local_backend():
    assert is_allowed_browser_origin(
        "http://100.124.182.34:5274",
        "127.0.0.1:8011",
    ) is True


def test_unknown_public_workbench_origin_is_denied():
    assert is_allowed_browser_origin(
        "http://evil.example.com:5274",
        "127.0.0.1:8011",
    ) is False


def test_same_host_non_workbench_port_is_denied():
    assert is_allowed_browser_origin(
        "http://127.0.0.1:9999",
        "127.0.0.1:8011",
    ) is False


def test_same_origin_including_port_is_allowed():
    assert is_allowed_browser_origin(
        "http://127.0.0.1:8011",
        "127.0.0.1:8011",
    ) is True


def test_browser_write_without_local_token_is_rejected(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("LZCORE_AUTH_ENABLED", raising=False)
    monkeypatch.delenv("LZCORE_LOGIN_USERNAME", raising=False)
    monkeypatch.delenv("LZCORE_LOGIN_PASSWORD", raising=False)
    monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
    from backend.main import create_app
    client = create_app().test_client()
    headers = {"Origin": "http://127.0.0.1:5273", "Host": "127.0.0.1:8011"}
    denied = client.post("/api/workspaces", json={"name": "x"}, headers=headers)
    assert denied.status_code == 403
    assert denied.get_json()["error"] == "local_token_required"
    issued = client.get("/api/local-token", headers=headers)
    assert issued.status_code == 200
    token = issued.get_json()["token"]
    allowed = client.post("/api/workspaces", json={"name": "x"}, headers={**headers, "X-LZCore-Local-Token": token})
    assert allowed.status_code != 403 or allowed.get_json().get("error") != "local_token_required"


def test_private_lan_host_is_denied_unless_lan_is_explicitly_enabled(monkeypatch):
    from backend.core.auth import _unauthenticated_host_allowed

    monkeypatch.delenv("LZCORE_ALLOW_LAN", raising=False)
    monkeypatch.delenv("LZCORE_ALLOWED_HOSTS", raising=False)
    assert _unauthenticated_host_allowed("127.0.0.1") is True
    assert _unauthenticated_host_allowed("localhost") is True
    assert _unauthenticated_host_allowed("192.168.1.8") is False
    monkeypatch.setenv("LZCORE_ALLOW_LAN", "true")
    assert _unauthenticated_host_allowed("192.168.1.8") is True


def test_dns_rebinding_origin_matching_untrusted_host_is_denied():
    assert is_allowed_browser_origin(
        "http://evil.example.com:8011",
        "evil.example.com:8011",
    ) is False


def test_mdns_local_domain_denied_by_default():
    assert is_allowed_browser_origin(
        "http://attacker.local:5273",
        "127.0.0.1:8011",
    ) is False

