"""Device.manage read-only classification must follow command text, not the model action."""

from core.runtime_engine.contracts import get_retry_contract, is_read_only_call


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
