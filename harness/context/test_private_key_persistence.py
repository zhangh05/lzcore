"""Synthetic private keys must never reach journal/archive/long-term storage."""

import json

import pytest

from agent.runtime.memory_write.event_log import append_experience
from storage.context_epoch_store import read_epoch, save_epoch
from storage.memory_event_store import read_events
from storage.memory_governance import MemoryRecord, MemoryStore, MemoryWriteGate
from storage.redaction import MASK, contains_secret, redact_value


@pytest.fixture(params=["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY",
                       "DSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"])
def private_key(request):
    label = request.param
    # Deliberately invalid payload, never a real or generated credential.
    return f"-----BEGIN {label}-----\nSYNTHETIC_NOT_BASE64\nSECOND_SYNTHETIC_LINE\n-----END {label}-----"


@pytest.mark.parametrize("complete", [True, False])
def test_private_key_redaction_and_detection(private_key, complete):
    text = private_key if complete else private_key.split("-----END")[0] + "-----EN"
    assert contains_secret(text)
    assert redact_value({"nested": [text]}) == {"nested": [MASK]}
    assert redact_value("before\n" + text + ("\nafter" if complete else "")) == (
        "before\n" + MASK + ("\nafter" if complete else ""))


def test_private_keys_removed_before_journal_and_archive_publication(private_key):
    args = dict(workspace_id="pem-ws", session_id="pem-session")
    partial = private_key.split("-----END")[0]
    append_experience(**args, task_id="task", user_input=private_key,
        assistant_response=partial,
        tool_calls=[{"tool_id": "test", "ok": True, "summary": private_key}], task_ok=True)
    events = read_events(**args)
    assert events[0]["user_input"] == MASK
    assert events[0]["assistant_response"] == MASK
    assert events[0]["tool_calls"][0]["summary"] == MASK
    record = save_epoch(**args, request_id="request", messages=[
        {"role": "user", "content": private_key},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call-1", "function": {"name": "test", "arguments":
                json.dumps({"nested": {"detail": private_key}})}}]},
    ], state={"nested": [partial]})
    saved = read_epoch(**args, checkpoint_id=record["checkpoint_id"])
    persisted = json.dumps([saved, events])
    assert "SYNTHETIC_NOT_BASE64" not in persisted
    assert "SECOND_SYNTHETIC_LINE" not in persisted
    assert saved["payload"]["state"]["nested"] == [MASK]


@pytest.mark.parametrize("field", ["content", "summary", "metadata", "citations"])
def test_private_key_rejected_in_memory_body_and_metadata(private_key, field):
    record = MemoryRecord(workspace_id="pem-memory", source="user",
        memory_type="semantic_fact", content="A durable synthetic fact.")
    setattr(record, field, {"nested": [private_key]} if field == "metadata" else
            [{"excerpt": private_key}] if field == "citations" else private_key)
    result = MemoryWriteGate().write(record)
    assert result["ok"] is False and result["rejected"] is True
    assert result["status"] == "rejected"
    assert MemoryStore().get("pem-memory", record.memory_id) is None


def test_public_key_and_ordinary_text_are_preserved():
    text = "-----BEGIN PUBLIC KEY-----\nSYNTHETIC_PUBLIC\n-----END PUBLIC KEY-----\nnormal answer"
    assert not contains_secret(text)
    assert redact_value(text) == text
