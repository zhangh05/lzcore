"""Device.manage read-only classification must follow command text, not the model action."""

from core.runtime_engine.contracts import get_retry_contract, is_read_only_call
import pytest


def test_write_commands_are_not_read_only_even_when_action_is_read():
    from extensions.runtime import get_extension_tool_specs

    get_extension_tool_specs()
    arguments = {
        "action": "read",
        "connection_id": "conn_1",
        "commands": ["system-view", "shutdown"],
    }
    assert is_read_only_call("network.operations.device.manage", arguments) is False
    contract = get_retry_contract("network.operations.device.manage", arguments)
    assert contract is not None
    assert contract.idempotent is False
    assert contract.max_retries == 0


def test_observation_commands_stay_read_only():
    from extensions.runtime import get_extension_tool_specs

    get_extension_tool_specs()
    arguments = {
        "action": "read",
        "connection_id": "conn_1",
        "commands": ["display version", "show interface brief"],
    }
    assert is_read_only_call("network.operations.device.manage", arguments) is True


@pytest.mark.parametrize("command, read_only", [
    ("display version | include Ver", True),
    ("show run | include key", True),
    ('display logbuffer | include "ERROR|WARN"', True),
    ("display logbuffer | include ERROR|WARN", True),
    ("show run | include ip|interface", True),
    ("show run | include ip|interface | count", True),
    ("show run|include ip|interface", True),
    ('show run | include "a|b"', True),
    ("show run | include 'a | tee b'", True),
    ('show run | include "a||b"', True),
    ('show run | include prefix"a | b"suffix', True),
    (r'show run | include "a\"|b" | count', True),
    ("display x | exclude foo | begin bar | count | no-more", True),
    ('show x | grep "a|b" | match foo', True),
    ("show x | i foo | e bar | b baz | s quux", True),
    ("ping 1.1.1.1 | touch x", False),
    ("display x | save", False),
    ("show x | tee flash:a", False),
    ("show x | redirect", False),
    ("show x | redirect f", False),
    ("show x | append f", False),
    ("show x | copy f", False),
    ("show x | write f", False),
    ("show x | include Ver | touch x", False),
    ("show x | include a | tee y", False),
    ("show x | include a|b | tee y", False),
    ("show x|tee y", False),
    ("show include a|tee y", False),
    (r'show x | include \"a | tee y \"', False),
    ("show x |tee y", False),
    ("show x| tee y", False),
    ("show x | include a| tee y", False),
    ("show x | include a |tee y", False),
    ("show x | include|tee y", False),
    ("show x | count a|tee y", False),
    ("show x | no-more|tee y", False),
    ("show x | include a||b", False),
    ("show x | include Ver & touch x", False),
    ("show x | include Ver || touch x", False),
    ("show x | include Ver > f", False),
    ("show x | include Ver; touch x", False),
    ("show x | include $(touch x)", False),
    ("show x | no-more touch x", False),
    ("show x |", False),
    ("show x || include Ver", False),
    ('show x | include "unterminated', False),
])
def test_every_pipeline_stage_must_be_a_pure_display_filter(command, read_only):
    from extensions.network_operations.device_tools import is_read_only_command, normalize_read_only_commands

    assert is_read_only_command(command) is read_only
    arguments = {"action": "read", "commands": [command]}
    assert is_read_only_call("network.operations.device.manage", arguments) is read_only
    contract = get_retry_contract("network.operations.device.manage", arguments)
    assert contract.idempotent is read_only
    if read_only:
        assert normalize_read_only_commands([command]) == [command]
    else:
        assert contract.max_retries == 0
        with pytest.raises(ValueError):
            normalize_read_only_commands([command])


@pytest.mark.parametrize("filter_name", [
    "include", "exclude", "begin", "section", "grep", "match", "i", "e", "b", "s",
])
def test_regex_alternation_is_an_argument_of_a_regex_filter(filter_name):
    from extensions.network_operations.command_semantics import classify_raw_command
    from extensions.network_operations.device_tools import normalize_read_only_commands

    command = f"show run | {filter_name} a|b|c\t|\tcount"
    assert classify_raw_command(command).action == "read"
    assert normalize_read_only_commands([command]) == [command]


@pytest.mark.parametrize("vendor, prefix", [
    ("h3c", "display logbuffer"), ("huawei", "display logbuffer"), ("cisco", "show logging"),
])
def test_saved_inspection_scripts_preserve_quoted_and_unquoted_regex(monkeypatch, tmp_path, vendor, prefix):
    from extensions.network_operations.network_scripts import get_inspection_script, save_inspection_script

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    commands = [f"{prefix} | include ERROR|WARN", f'{prefix} | include "ERROR|WARN"']
    payload = {"script_id": "saved-regex", "name": "正则巡检", "vendors": [vendor], "commands": commands}
    assert save_inspection_script("regex-test", payload)["commands"] == commands
    saved = get_inspection_script("regex-test", "saved-regex")
    assert saved["commands"] == commands
    assert save_inspection_script("regex-test", saved)["commands"] == commands
