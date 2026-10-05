"""Reject a marker-only Diff, stale audit, and repeated uncertain mutations."""

import urllib.error

import pytest

from scripts.benchmark_noc_acceptance import (
    restore_configuration, run_noc_acceptance, verify_line_diff,
)


DIFF = [
    {"kind": "removed", "text": "old"},
    {"kind": "added", "text": "new"},
    {"kind": "unchanged", "text": "kept"},
    {"kind": "added", "text": "extra"},
]


def test_diff_reconstructs_both_actual_versions():
    verify_line_diff(DIFF, "old\nkept\n", "new\nkept\nextra")
    for bad in (
        DIFF[1:],  # A real addition marker alone missed the actual deletion.
        DIFF[:-1],
        [{"kind": "changed", "text": "old"}],
        [{"kind": "added", "text": 1}],
        [],
    ):
        with pytest.raises(AssertionError):
            verify_line_diff(bad, "old\nkept\n", "new\nkept\nextra")


@pytest.mark.parametrize("applied", [False, True])
def test_lost_rollback_response_is_read_back_and_never_replayed(applied):
    state = {"content": "ours"}
    calls = []

    def api(path, data=None):
        calls.append((path, data))
        if path.endswith("/rollback"):
            if applied:
                state["content"] = "original"
            raise TimeoutError("lost response")
        return dict(state)

    before = {"content": "original", "versionId": "v1"}
    if applied:
        assert restore_configuration(api, "/api/config/d", before, "ours")
    else:
        with pytest.raises(TimeoutError):
            restore_configuration(api, "/api/config/d", before, "ours")
    assert sum(path.endswith("/rollback") for path, _ in calls) == 1
    assert calls[0] == ("/api/config/d", None)
    assert calls[-1] == ("/api/config/d", None)


@pytest.mark.parametrize("content", ["original", "someone else's change"])
def test_cleanup_does_not_mutate_unchanged_or_unrelated_configuration(content):
    calls = []

    def api(path, data=None):
        calls.append((path, data))
        return {"content": content}

    before = {"content": "original", "versionId": "v1"}
    if content == "original":
        assert restore_configuration(api, "/api/config/d", before, "ours") is False
    else:
        with pytest.raises(AssertionError, match="refusing automatic rollback"):
            restore_configuration(api, "/api/config/d", before, "ours")
    assert calls == [("/api/config/d", None)]


def test_explicit_rollback_http_failure_is_not_hidden_by_readback():
    def api(path, data=None):
        if path.endswith("/rollback"):
            raise urllib.error.HTTPError(path, 403, "denied", {}, None)
        return {"content": "ours"}
    with pytest.raises(urllib.error.HTTPError):
        restore_configuration(api, "/api/config/d", {"content": "old", "versionId": "v1"}, "ours")


@pytest.mark.parametrize("bad_diff,stale_audit,lost_put", [
    (False, False, False), (True, False, False), (False, True, False),
    (False, False, True),
])
def test_configuration_oracle_rejects_false_diff_and_stale_audit_and_cleans_unknown_put(
    bad_diff, stale_audit, lost_put
):
    # An HTTP adapter fixture tests the trusted oracle, not a generated app.
    config = {"content": "old\nkept", "versionId": "v1"}
    audit = [{"deviceId": "d", "action": "config.rollback"}]
    mutations, results = [], {}

    def array(path, key):
        if path == "/api/devices":
            return [{"id": "d"}]
        if path == "/api/audit":
            return [dict(item) for item in audit]
        raise ValueError("not part of this oracle fixture")

    def api(path, data=None, method=None, **kwargs):
        if method == "PUT":
            mutations.append("put")
            config.update(content=data["content"], versionId="v2")
            if lost_put:
                raise TimeoutError("unknown write")
            return dict(config)
        if path.endswith("/rollback"):
            mutations.append("rollback")
            config.update(content="old\nkept", versionId="v3")
            if not stale_audit:
                audit.append({"deviceId": "d", "action": "config.rollback"})
            return dict(config)
        if "/diff?" in path:
            lines = [
                {"kind": "removed", "text": "old"},
                {"kind": "added", "text": "acceptance-replaced-17"},
                {"kind": "unchanged", "text": "kept"},
                {"kind": "added", "text": "acceptance-added-17"},
            ]
            return {"lines": lines[1:] if bad_diff else lines}
        if path == "/api/config/d":
            return dict(config)
        raise ValueError("not part of this oracle fixture")

    def check(name, action):
        if name != "independent_configuration_diff_rollback_audit":
            return
        try:
            action()
            results[name] = "PASS"
        except (AssertionError, TimeoutError):
            results[name] = "FAIL"

    run_noc_acceptance(api, array, check, 17)
    expected = "FAIL" if bad_diff or stale_audit or lost_put else "PASS"
    assert results["independent_configuration_diff_rollback_audit"] == expected
    assert config["content"] == "old\nkept"
    assert mutations == ["put", "rollback"]
