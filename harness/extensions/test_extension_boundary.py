"""Extension lifecycle and namespace regression tests using temporary plugins."""

import json
from pathlib import Path

import pytest
from flask import Flask, request

from backend.core.auth import _authorize_extension_request
from extensions.manifest import ExtensionManifest, ExtensionValidationError, extension_storage_key
from extensions.registry import ExtensionRegistry
from extensions import runtime, state


def write_manifest(root, folder, extension_id, **extra):
    directory = root / folder
    directory.mkdir(parents=True, exist_ok=True)
    data = {
        "extension_id": extension_id, "name": "Test extension", "version": "1.0.0",
        "capabilities": ["sample"], **extra,
    }
    (directory / "extension.json").write_text(json.dumps(data), encoding="utf-8")
    return directory


@pytest.fixture
def plugins(monkeypatch, tmp_path):
    root = tmp_path / "plugins"
    original_init = ExtensionRegistry.__init__

    def init(self, roots=None):
        original_init(self, roots if roots is not None else (root,))

    monkeypatch.setattr(ExtensionRegistry, "__init__", init)
    monkeypatch.setattr(state, "get_extension_state", lambda *args, **kwargs: {"enabled": True})
    monkeypatch.setattr(runtime, "_CACHE", None)
    return root


@pytest.mark.parametrize("first,second", [
    ("vendor.sample", "vendor_sample"),
    ("vendor..sample", "vendor_sample"),
    ("_vendor_sample", "vendor_sample"),
])
def test_discovery_rejects_both_namespace_collision_participants(plugins, first, second):
    write_manifest(plugins, "first", first)
    write_manifest(plugins, "second", second)
    write_manifest(plugins, "unrelated", "unrelated")
    registry = ExtensionRegistry()
    errors, valid = registry.validate_all()
    assert any("namespace collision" in error for error in errors)
    assert [manifest.extension_id for manifest in valid] == ["unrelated"]
    with pytest.raises(ExtensionValidationError, match="namespace collision"):
        registry.discover()
    with pytest.raises(ExtensionValidationError, match="namespace collision"):
        runtime.load_extensions(registry=registry)


def test_discovery_checks_collisions_across_roots(plugins, tmp_path):
    builtin = tmp_path / "builtin"
    write_manifest(builtin, "first", "vendor.sample")
    write_manifest(plugins, "second", "vendor_sample")
    with pytest.raises(ExtensionValidationError, match="namespace collision"):
        ExtensionRegistry((builtin, plugins)).discover()


def test_legacy_data_key_is_unchanged_and_secret_identity_is_lossless(monkeypatch):
    from extensions.sdk import ExtensionDataStore, ExtensionSecretStore
    from storage import secret_store
    captured = []
    monkeypatch.setattr(secret_store, "set_secret", lambda key, value: captured.append((key, value)) or "reference")
    assert extension_storage_key("network.operations") == "network_operations"
    assert ExtensionDataStore("network.operations", "test_ws").namespace == "network_operations"
    secrets = ExtensionSecretStore("network.operations", "test_ws")
    assert secrets.set("sample", "synthetic value") == "reference"
    from storage.secret_store import extension_secret_id
    assert captured == [(extension_secret_id("test_ws", "network.operations", "sample"), "synthetic value")]


@pytest.mark.parametrize("upgrade", [False, True])
def test_install_rejects_namespace_collision_before_replacing_files(plugins, tmp_path, upgrade):
    from harness.extensions.test_extension_packages import _keys
    from extensions.package import ExtensionPackageError, build_package, install_package

    private, public = _keys()
    installed = write_manifest(plugins, "vendor_sample", "vendor.sample")
    sentinel = installed / "sentinel.txt"
    sentinel.write_text("existing extension", encoding="utf-8")
    source = write_manifest(tmp_path / "source", "incoming", "vendor_sample")
    package = tmp_path / "incoming.apx"
    build_package(source, package, key=private)
    with pytest.raises(ExtensionPackageError, match="namespace collision"):
        install_package(package, key=public, plugins_root=plugins, upgrade=upgrade)
    assert sentinel.read_text(encoding="utf-8") == "existing extension"
    assert ExtensionRegistry.load(installed / "extension.json").extension_id == "vendor.sample"
    assert not (plugins / ".extension-backups").exists()


def test_install_checks_default_roots_when_destination_is_custom(plugins, tmp_path):
    from harness.extensions.test_extension_packages import _keys
    from extensions.package import ExtensionPackageError, build_package, install_package

    write_manifest(plugins, "builtin", "vendor.sample")
    private, public = _keys()
    source = write_manifest(tmp_path / "source", "incoming", "vendor_sample")
    package = tmp_path / "incoming.apx"
    build_package(source, package, key=private)
    with pytest.raises(ExtensionPackageError, match="namespace collision"):
        install_package(package, key=public, plugins_root=tmp_path / "custom")
    assert not (tmp_path / "custom" / "vendor_sample").exists()


def extension_app(monkeypatch, plugins, *, with_auth=True):
    endpoint = "/api/extensions/vendor.sample/manage"
    directory = write_manifest(plugins, "vendor_sample", "vendor.sample", routes=[endpoint],
                               metadata={"minimum_role": "admin", "minimum_write_role": "admin"})
    manifest = ExtensionRegistry.load(directory / "extension.json")
    calls = []

    def register(app):
        @app.route(endpoint, methods=["GET", "POST"])
        def manage():
            calls.append("called")
            return {"ok": True}

    loaded = runtime.LoadedExtension(manifest=manifest, root=directory, register_routes=register)
    monkeypatch.setattr(runtime, "load_extensions", lambda: (loaded,))
    app = Flask(__name__)
    app.config["TESTING"] = True
    if with_auth:
        @app.before_request
        def authorize():
            return _authorize_extension_request(request.path, request.headers.get("Test-Role", "viewer"),
                                                platform_admin=request.headers.get("Test-Role") == "owner")
    runtime.register_extension_routes(app)
    return app.test_client(), endpoint, calls


def test_uninstall_blocks_previously_registered_admin_endpoint(monkeypatch, plugins):
    from extensions.package import uninstall_extension

    client, endpoint, calls = extension_app(monkeypatch, plugins)
    assert client.get(endpoint).status_code == 403
    assert client.get(endpoint, headers={"Test-Role": "admin"}).status_code == 200
    monkeypatch.setattr(runtime, "_CACHE", ("cached plugin",))
    removed = uninstall_extension("vendor.sample", plugins_root=plugins)
    assert Path(removed["recoverable_path"]).is_dir()
    assert runtime._CACHE is None
    assert client.get(endpoint).status_code == 404
    assert client.post(endpoint).status_code == 404
    assert client.get(endpoint, headers={"Test-Role": "admin"}).status_code == 404
    assert calls == ["called"]


@pytest.mark.parametrize("with_auth", [True, False])
def test_discovery_failure_denies_existing_route(monkeypatch, plugins, with_auth):
    client, endpoint, calls = extension_app(monkeypatch, plugins, with_auth=with_auth)

    def fail(self):
        raise OSError("discovery unavailable")

    monkeypatch.setattr(ExtensionRegistry, "discover", fail)
    assert client.get(endpoint, headers={"Test-Role": "admin"}).status_code == 404
    assert calls == []


def test_registered_route_is_blocked_after_uninstall_without_identity_auth(monkeypatch, plugins):
    from extensions.package import uninstall_extension

    client, endpoint, calls = extension_app(monkeypatch, plugins, with_auth=False)
    assert client.get(endpoint).status_code == 200
    uninstall_extension("vendor.sample", plugins_root=plugins)
    assert client.get(endpoint).status_code == 404
    assert calls == ["called"]


def test_installed_routes_keep_role_and_disable_checks(monkeypatch, plugins):
    client, endpoint, calls = extension_app(monkeypatch, plugins)
    assert client.get(endpoint).status_code == 403
    assert client.post(endpoint, headers={"Test-Role": "admin"}).status_code == 200
    monkeypatch.setattr(state, "get_extension_state", lambda *args, **kwargs: {"enabled": False})
    assert client.get(endpoint, headers={"Test-Role": "admin"}).status_code == 409
    assert calls == ["called"]


def test_repository_control_plane_does_not_require_a_manifest(plugins):
    app = Flask(__name__)
    with app.test_request_context("/api/extensions/repository"):
        assert _authorize_extension_request(request.path, "owner", platform_admin=True) is None
        assert _authorize_extension_request(request.path, "viewer", platform_admin=False)[1] == 403
    with app.test_request_context("/api/extensions/repository_plugin/manage"):
        assert _authorize_extension_request(request.path, "owner", platform_admin=True)[1] == 404
