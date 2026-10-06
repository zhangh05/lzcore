"""Redacted evidence remains persistable; masks never hide adjacent secrets."""

import json
from pathlib import Path

import pytest

from artifacts.redaction import contains_secret, redact_artifact_content
from artifacts.store import read_artifact_content, save_artifact


@pytest.mark.parametrize("mask", ["[REDACTED]", "[REDACTED_SECRET]"])
def test_redacted_qa_evidence_is_persisted_complete(tmp_path, monkeypatch, mask):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    content = json.dumps({"verdict": "pass", "findings": [f"Bearer {mask}"]})
    assert not contains_secret(content)
    assert redact_artifact_content(content) == content
    record = save_artifact("mask-proof", content=content, title="QA evidence", sensitivity="internal")
    assert record is not None
    assert read_artifact_content("mask-proof", record.artifact_id) == content


@pytest.mark.parametrize("content", [
    "Bearer synthetic-secret-123456789",
    "Bearer [REDACTED]synthetic-secret-123456789",
    "Bearer synthetic-secret-123456789 [REDACTED]",
    "Bearer [REDACTED]\napi_key=synthetic-secret-123456789",
])
def test_masks_do_not_bypass_secret_guard(tmp_path, monkeypatch, content):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    assert contains_secret(content)
    assert save_artifact("mask-proof", content=content, title="Unsafe", sensitivity="internal") is None
    redacted = redact_artifact_content(content)
    assert "synthetic-secret-123456789" not in redacted
    assert not contains_secret(redacted)
    assert redact_artifact_content(redacted) == redacted


@pytest.mark.parametrize("prefix", ["password=", "secret: ", "api_key=", "Authorization Bearer ", "snmp-server community "])
def test_all_credential_patterns_preserve_known_masks(prefix):
    content = prefix + "[REDACTED_SECRET]"
    assert not contains_secret(content)
    assert redact_artifact_content(content) == content


def test_explicit_secret_classification_still_redacts_before_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    content = "Bearer synthetic-secret-123456789"
    record = save_artifact("mask-proof", content=content, title="Secret", sensitivity="secret")
    assert record is not None
    assert read_artifact_content("mask-proof", record.artifact_id, allow_sensitive=True) is None
    stored = Path(record.path).read_text()
    assert "synthetic-secret-123456789" not in stored
    assert not contains_secret(stored)


@pytest.mark.parametrize("separator", ["\n", "\r", "\t", '"', "\\"])
def test_serialized_mask_boundaries_preserve_evidence(tmp_path, monkeypatch, separator):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    content = json.dumps({"stdout": "token: [REDACTED_SECRET]" + separator})
    assert not contains_secret(content)
    assert redact_artifact_content(content) == content
    record = save_artifact("mask-proof", content=content, sensitivity="internal")
    assert record is not None
    assert read_artifact_content("mask-proof", record.artifact_id) == content


@pytest.mark.parametrize("suffix", [r"\nsynthetic-secret-123456789", r"\qsynthetic-secret-123456789"])
def test_mask_escape_does_not_exempt_following_credential(tmp_path, monkeypatch, suffix):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    content = "token: [REDACTED_SECRET]" + suffix
    assert contains_secret(content)
    assert save_artifact("mask-proof", content=content, sensitivity="internal") is None
    assert "synthetic-secret-123456789" not in redact_artifact_content(content)
