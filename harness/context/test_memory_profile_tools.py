"""Profile preferences must survive a set/get tool round trip."""

import uuid

from core.tools.general_tools.memory_tools import handle_memory_get_profile, handle_memory_set_profile
from core.tools.schemas import ToolInvocation


def test_profile_set_persists_structured_preferences(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    workspace_id = f"ws_profile_{uuid.uuid4().hex[:8]}"
    set_result = handle_memory_set_profile(ToolInvocation(
        tool_id="memory.manage", workspace_id=workspace_id,
        arguments={"action": "profile_set", "field": "language", "value": "zh-CN"},
    ))
    assert set_result["ok"] is True

    from storage.memory_governance import confirm_memory
    assert set_result['memory_status'] == 'pending'
    assert confirm_memory(workspace_id, set_result['memory_id'])['ok']
    get_result = handle_memory_get_profile(ToolInvocation(
        tool_id="memory.manage", workspace_id=workspace_id,
        arguments={"action": "profile_get"},
    ))
    assert get_result["ok"] is True
    assert get_result["explicit_preferences"] == {"language": "zh-CN"}
