"""Keep exact approval payloads in SecretStore, with safe JSON projections."""

from __future__ import annotations

import json
import re
import uuid

from core.tools.redaction import redact_tool_output
from storage import secret_store

FROZEN_OPERATION_FIELDS = (
    "schema", "tool_id", "action", "workspace_id", "session_id", "run_id",
    "request_id", "call_id", "skill", "target", "commands", "timeout", "execution_model",
)
CONTINUATION_PRIVATE_FIELDS = {
    "user_input", "messages", "tool_calls", "prior_results", "round_results",
    "workbench_context", "context_window_state", "operations",
}
_TERMINAL_OPERATIONS = {"rejected", "cancelled", "invalidated", "executed", "unknown"}
_QUERY_COMMAND = re.compile(r"^[ \t]*(?:show|display|ping|traceroute|tracert)(?:[ \t]|$)", re.IGNORECASE)
_DEVICE_CREDENTIAL = re.compile(
    r"(?<![\w-])("
    r"(?:message-digest-key[ \t]+\d+[ \t]+md5"
    r"|auth[ \t]+[a-z][\w-]*"
    r"|priv[ \t]+[a-z][\w-]*(?:[ \t]+\d+)?"
    r"|key-string|pre-shared-key|authentication-key|key|password|secret|community)"
    r"[ \t]+(?:(?:[05789]|cipher|simple)[ \t]+)?)"
    r'''(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;"'<>]+)''',
    re.IGNORECASE,
)


def redact_device_command(command: str) -> str:
    """Mask device credential arguments, preserving query/filter vocabulary.

    This is a display-only pass. General secret redaction follows in
    public_record; neither execution payloads nor their digests use this text.
    Treat each line independently, including multiline result echoes.
    """
    return "".join(
        line if _QUERY_COMMAND.match(line) else _DEVICE_CREDENTIAL.sub(
            lambda match: match.group(1) + "[REDACTED]", line,
        )
        for line in command.splitlines(keepends=True)
    )


def _device_command_projection(value):
    # Results can echo commands as nested values or mapping keys as well as
    # in the top-level commands list. Never change the original payload.
    if isinstance(value, str):
        return redact_device_command(value)
    if isinstance(value, list):
        return [_device_command_projection(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            safe_key = redact_device_command(key) if isinstance(key, str) else key
            base_key = safe_key
            suffix = 2
            while safe_key in result or (safe_key != key and safe_key in value):
                safe_key = f"{base_key} [#{suffix}]"
                suffix += 1
            result[safe_key] = _device_command_projection(item)
        return result
    return value


def public_record(record):
    if record is None:
        return None
    return redact_tool_output(_device_command_projection(
        {k: v for k, v in record.items() if not k.startswith("_payload_")}
    ))


def save_record(store, collection, record_id, record):
    """Write a new immutable secret first; retire old references after commit."""
    previous = store.get(collection, record_id) or {}
    protected = FROZEN_OPERATION_FIELDS if collection == "operations" else CONTINUATION_PRIVATE_FIELDS
    retain = (record.get("status") not in _TERMINAL_OPERATIONS if collection == "operations"
              else record.get("status") != "resumed")
    payload = {key: record[key] for key in protected if key in record}
    projection = public_record(record)
    projection["_payload_protected"] = True
    if collection == "continuations":
        for key in protected:
            projection.pop(key, None)
    reference = ""
    if retain and payload:
        envelope = {"collection": collection, "record_id": record_id,
                    "workspace_id": store.workspace_id, "payload": payload}
        reference = secret_store.set_secret(
            f"approval/{uuid.uuid4().hex}", json.dumps(envelope, ensure_ascii=False),
        )
        projection["_payload_ref"] = reference
    try:
        store.save(collection, record_id, projection)
    except Exception:
        if reference:
            secret_store.delete_secret(reference)
        raise
    old_reference = previous.get("_payload_ref")
    if old_reference:
        secret_store.delete_secret(old_reference)


def load_record(store, collection, record_id):
    """Internal only: restore exact execution/resume fields or fail closed."""
    record = store.get(collection, record_id)
    if not record:
        return record
    if not record.get("_payload_ref"):
        active = (record.get("status") not in _TERMINAL_OPERATIONS if collection == "operations"
                  else record.get("status") != "resumed")
        if record.get("_payload_protected") and active:
            raise ValueError("approval_payload_unavailable_or_invalid")
        return record  # legacy records are protected on their next write
    try:
        envelope = json.loads(secret_store.get_secret(record["_payload_ref"]))
        if (envelope["collection"], envelope["record_id"], envelope["workspace_id"]) != (
            collection, record_id, store.workspace_id,
        ):
            raise ValueError("payload binding mismatch")
        payload = envelope["payload"]
        expected_projection = public_record(payload)
        if collection == "operations" and any(
            record.get(key) != expected_projection[key] for key in FROZEN_OPERATION_FIELDS
        ):
            raise ValueError("frozen projection mismatch")
        return {**record, **payload}
    except (ValueError, KeyError, TypeError):
        raise ValueError("approval_payload_unavailable_or_invalid") from None
