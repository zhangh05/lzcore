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

