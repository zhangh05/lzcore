import json

import pytest

from core.tools.redaction import contains_secret, redact_string, redact_tool_output


@pytest.mark.parametrize("command, secret", [
    ('username demo password 0 synthetic-password', 'synthetic-password'),
    ('enable secret 9 synthetic-hash', 'synthetic-hash'),
    ('snmp-agent community cipher "synthetic value"', 'synthetic value'),
    ('--password="synthetic value"', 'synthetic value'),
    ('--key synthetic-key', 'synthetic-key'),
    ('token: tiny-token', 'tiny-token'),
    ('https://' + 'demo:p%40ssword' + '@example.invalid/repo', 'p%40ssword'),
    ('failed ghp_syntheticCredential12345', 'ghp_syntheticCredential12345'),
    ('failed ' + 'glpat-' + 'syntheticCredential12345', 'glpat-' + 'syntheticCredential12345'),
])
def test_redactor_masks_command_credentials(command, secret):
    assert secret not in redact_string(command)
    assert contains_secret({command: "accepted"})


@pytest.mark.parametrize("text", [
    'the key point is simple',
    'token budget exceeded',
    'primary key id',
    'monkey business',
    'keyboard shortcut',
    'the token was valid',
    'sort by key asc',
    'd[key] = value',
    'for key in items:',
    'PRIMARY KEY (id)',
    'api key usage',
    'api_key usage',
    'api-key usage',
    'apikey usage',
    'key synthetic-key',
])
def test_tool_output_preserves_key_and_token_prose_and_code(text):
    original = {text: [text, {"detail": text}]}
    assert redact_string(text) == text
    assert redact_tool_output(text) == text
    assert redact_tool_output(original) == original
    assert not contains_secret(original)


@pytest.mark.parametrize("text, expected", [
    ('api_key=abc123', 'api_key=[REDACTED]'),
    ('"token": "abc"', '"token": [REDACTED]'),
    ('token: abc', 'token: [REDACTED]'),
    ('--token abc', '--token [REDACTED]'),
    ('--api-key abc', '--api-key [REDACTED]'),
    ('--key abc', '--key [REDACTED]'),
    ('key = abc', 'key = [REDACTED]'),
    ('api key : abc', 'api key : [REDACTED]'),
    ('"api_key" : "abc"', '"api_key" : [REDACTED]'),
    ("'api key' = 'abc'", "'api key' = [REDACTED]"),
    ('"key"\t:\t"abc"', '"key"\t:\t[REDACTED]'),
    ('--token=abc', '--token=[REDACTED]'),
    ('--token = abc', '--token = [REDACTED]'),
    ('--api-key "abc def"', '--api-key [REDACTED]'),
    ('password hunter2', 'password [REDACTED]'),
    ('passwd hunter2', 'passwd [REDACTED]'),
    ('secret hunter2', 'secret [REDACTED]'),
    ('snmp-server community public123', 'snmp-server community [REDACTED]'),
    ('username a password 7 xxx', 'username a password [REDACTED]'),
    ('enable secret 5 xxx', 'enable secret [REDACTED]'),
])
def test_tool_output_masks_explicit_keys_tokens_and_device_passwords(text, expected):
    assert redact_tool_output(text) == expected
    assert redact_tool_output({text: [text]}) == {expected: [expected]}
    assert contains_secret({text: "accepted"})


def test_command_output_keys_and_values_are_redacted_without_losing_collisions():
    original = {"output": {
        "password first-synthetic": "first accepted",
        "password second-synthetic": {"detail": "Bearer third-synthetic"},
        "password [REDACTED]": "third accepted",
        "password [REDACTED] [#2]": "fourth accepted",
        7: "numeric label preserved",
    }}
    safe = redact_tool_output(original)
    text = json.dumps(safe)
    for secret in ("first-synthetic", "second-synthetic", "third-synthetic"):
        assert secret not in text
    assert len(safe["output"]) == 5
    assert safe["output"][7] == "numeric label preserved"
    assert "first accepted" in safe["output"].values()
    assert "third accepted" in safe["output"].values()
    assert "fourth accepted" in safe["output"].values()
    assert "first-synthetic" in str(original)


def test_schema_failure_redacts_rejected_argument_from_every_result_projection():
    from core.tools.executor import ToolExecutor
    from core.tools.registry import ToolRegistry
    from core.tools.schemas import ToolInvocation, ToolSpec

    registry = ToolRegistry()
    calls = []
    registry.register_tool(ToolSpec(tool_id="test.validation", name="validation", description="validation",
        input_schema={"type": "object", "properties": {"action": {"type": "string", "enum": ["read"]}}}),
        lambda _inv: calls.append(True) or {"ok": True})
    result = ToolExecutor(registry).execute(ToolInvocation(tool_id="test.validation",
        arguments={"action": "password synthetic-validation-canary"}))
    assert result.status == "blocked" and result.redacted and calls == []
    assert result.output["error_code"] == "TOOL_ARGUMENT_VALIDATION_FAILED"
    assert "synthetic-validation-canary" not in json.dumps(result.as_dict())
    assert "action" in result.output["error"] and "read" in result.output["error"]
