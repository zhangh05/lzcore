"""Regression for real-service configuration being removed by test teardown."""

def test_provider_fixture_restores_test_data_without_touching_checkout(monkeypatch, tmp_path):
    from harness import conftest

    checkout = tmp_path / "checkout"
    protected = checkout / "config" / "providers" / "sentinel.json"
    protected.parent.mkdir(parents=True)
    protected.write_text("untouched live configuration")
    original_inode = protected.stat().st_ino
    monkeypatch.setattr(conftest, "__file__", str(checkout / "harness" / "conftest.py"))
    isolated = tmp_path / "test-config"
    provider = isolated / "providers" / "test.json"
    provider.parent.mkdir(parents=True)
    provider.write_text("original test configuration")
    monkeypatch.setenv("LZCORE_CONFIG_DIR", str(isolated))

    fixture = conftest.restore_test_provider_config.__wrapped__()
    next(fixture)
    provider.write_text("changed by a test")
    fixture.close()

    assert provider.read_text() == "original test configuration"
    assert protected.read_text() == "untouched live configuration"
    assert protected.stat().st_ino == original_inode
