"""Observation failures and pauses cannot terminate producer-owned tasks."""

import asyncio

import pytest

from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop, StreamingToolResult
from core.runtime_engine.tracking import extract_tracking_payload


@pytest.mark.parametrize("outcome", ["missing", "crash", "terminal", "revision"])
def test_poll_observations_preserve_lifecycle_and_allow_new_observation(monkeypatch, outcome):
    class Runtime:
        @staticmethod
        def has_tool(name):
            return name == "agent.manage"

    loop = QueryLoop(
        SSOTRuntimeConfig(tracking_poll_interval_cap_seconds=0),
        {"agent.manage": {"description": "", "args_schema": {"type": "object", "properties": {}}}},
        Runtime(),
    )
    ctx = StatelessContext(workspace_id="default", session_id="s1", request_id="r1", user_input="delegate")
    polls = []

    def observation(status="running", revision="0"):
        return {"kind": "long_task", "task_id": "sub-1", "status": status,
                "revision": revision, "suggested_next_action": "poll_get",
                "poll_arguments": {"action": "get", "subtask_id": "sub-1"}}

    async def poll(call, **_kwargs):
        polls.append(call.arguments)
        if outcome == "crash":
            raise RuntimeError("observation unavailable")
        if outcome == "missing":
            return StreamingToolResult(tool_name="agent.manage", call_id=call.id, ok=True, output={"ok": True})
        terminal = outcome == "terminal" or len(polls) == 2
        status = "failed" if outcome == "terminal" else "completed" if terminal else "running"
        return StreamingToolResult(tool_name="agent.manage", call_id=call.id,
                                   ok=outcome != "terminal", output={"tracking": observation(status, str(len(polls)))})

    monkeypatch.setattr(loop._executor, "_execute_one", poll)
    initial = StreamingToolResult(tool_name="agent.manage", call_id="spawn", ok=True,
                                  output={"tracking": observation()})
    exposed = asyncio.run(loop._settle_tracking(ctx, [initial]))
    final = extract_tracking_payload(exposed[-1].output)
    if outcome in {"missing", "crash"}:
        assert len(polls) == 1
        assert final["status"] == "running"
        assert final["done"] is False and final["terminal"] is False
        assert final["auto_polling"] == "stopped"
        assert not loop._should_poll_tracking(ctx.user_input, final)
        # A subsequent producer observation resumes tracking the same task.
        assert loop._should_poll_tracking(ctx.user_input, extract_tracking_payload(initial.output))
    elif outcome == "terminal":
        assert len(polls) == 1
        assert final["status"] == "failed"
        assert final["done"] is True and final["terminal"] is True
    else:
        # A changed revision is progress even when status stays running.
        assert len(polls) == 2
        assert final["status"] == "completed" and final["done"] is True
        assert final["observation_token"] == "2"
    assert all(args == {"action": "get", "subtask_id": "sub-1"} for args in polls)


@pytest.mark.parametrize("terminal", [False, True])
def test_quiet_intervals_wait_and_real_progress_resets_inactivity_grace(monkeypatch, terminal):
    clock = [0.0]
    monkeypatch.setattr("core.runtime_engine.loop_tracking.time.monotonic", lambda: clock[0])
    runtime = type("Runtime", (), {"has_tool": lambda self, name: True})()
    loop = QueryLoop(SSOTRuntimeConfig(tracking_poll_interval_cap_seconds=0,
                                      tracking_no_progress_grace_seconds=10), {}, runtime)
    ctx = StatelessContext("ws", "s", "r", "wait for delegated work")
    polls = []

    def observation(progress=0, done=False):
        return {"kind": "long_task", "task_id": "sub-1", "status": "completed" if done else "running",
                "done": done, "progress": {"source_files": progress}, "poll_action": "get",
                "poll_arguments": {"action": "get", "subtask_id": "sub-1"}}

    async def poll(call, **kwargs):
        clock[0] += 4
        polls.append(call)
        # Two identical observations must not prompt another coordinator turn.
        # Actual progress at t=12 resets the deadline; terminal facts at t=20
        # return immediately, otherwise sustained inactivity pauses at t=24.
        return StreamingToolResult(tool_name="agent.manage", call_id=call.id, ok=True,
            output={"tracking": observation(int(len(polls) >= 3), terminal and len(polls) == 5)})

    monkeypatch.setattr(loop._executor, "_execute_one", poll)
    initial = StreamingToolResult(tool_name="agent.manage", call_id="spawn", ok=True,
                                  output={"tracking": observation()})
    exposed = asyncio.run(loop._settle_tracking(ctx, [initial]))
    assert len(polls) == (5 if terminal else 6)
    final = extract_tracking_payload(exposed[-1].output)
    assert final["progress"] == {"source_files": 1}
    assert final["done"] is terminal
    assert final["status"] == ("completed" if terminal else "running")
    if terminal:
        assert final.get("auto_polling") != "stopped"
        assert not any(event.get("source") == "auto_polling_stopped" for event in ctx.extras["tracking_events"])
    else:
        assert final["auto_polling"] == "stopped" and final["stop_reason"] == "tracking_no_progress"


def test_cancellation_does_not_wait_for_inactivity_grace(monkeypatch):
    stopped = [False]
    runtime = type("Runtime", (), {"has_tool": lambda self, name: True})()
    loop = QueryLoop(SSOTRuntimeConfig(tracking_poll_interval_cap_seconds=0), {}, runtime)
    ctx = StatelessContext("ws", "s", "r", "wait", extras={"cancel_check": lambda: stopped[0]})
    tracking = {"kind": "long_task", "task_id": "sub-1", "status": "running",
                "poll_arguments": {"action": "get", "subtask_id": "sub-1"}}
    polls = []

    async def poll(call, **kwargs):
        polls.append(call)
        stopped[0] = True
        return StreamingToolResult(tool_name="agent.manage", call_id=call.id, ok=True,
                                   output={"tracking": tracking})

    monkeypatch.setattr(loop._executor, "_execute_one", poll)
    initial = StreamingToolResult(tool_name="agent.manage", call_id="spawn", ok=True,
                                  output={"tracking": tracking})
    exposed = asyncio.run(loop._settle_tracking(ctx, [initial]))
    assert len(polls) == 1 and len(exposed) == 1
    assert not extract_tracking_payload(exposed[0].output)["done"]


def test_batched_wait_yields_completed_peer_and_compacts_model_snapshots(monkeypatch):
    from agent.llm.schemas import LLMToolCall
    from core.tools.general_tools.agent_tools import _subtask_tracking
    runtime = type("Runtime", (), {"has_tool": lambda self, name: True})()
    loop = QueryLoop(SSOTRuntimeConfig(), {}, runtime)
    ctx = StatelessContext("ws", "parent", "run", "two delegated tasks")
    initial = [StreamingToolResult(tool_name="agent.manage", call_id=f"spawn-{identity}", ok=True,
        output={"tracking": _subtask_tracking(identity,"running",revision=1)}) for identity in ("sub-a","sub-b")]
    calls = []
    full = "full verified result " * 600
    async def wait(call, **kwargs):
        calls.append(call)
        return StreamingToolResult(tool_name="agent.manage", call_id=call.id, ok=True,
            output={"observations":[{"task_id":identity, "result": {"ok":True,"subtask_id":identity,
                "task_status": "succeeded" if identity=="sub-a" else "running", "preview":full if identity=="sub-a" else "",
                "subagent_result_complete":identity=="sub-a", "observation_revision":2,
                "tracking":_subtask_tracking(identity,"succeeded" if identity=="sub-a" else "running",revision=2)}}
                for identity in ("sub-a","sub-b")]})
    monkeypatch.setattr(loop._executor,"_execute_one",wait)
    exposed = asyncio.run(loop._settle_tracking(ctx,initial))
    assert len(calls)==1
    assert calls[0].arguments["action"]=="wait"
    assert calls[0].arguments["subtask_ids"]==["sub-a","sub-b"]
    assert calls[0].arguments["after_revision"]=={"sub-a":1,"sub-b":1}
    assert exposed[0].output["preview"]==full
    assert exposed[1].output["tracking"]["status"]=="running"
    assert exposed[1].output["tracking"].get("auto_polling") != "stopped"
    # Full terminal result and changed observations remain visible, duplicate
    # earlier full snapshots do not consume the next model request.
    duplicate = StreamingToolResult(tool_name="agent.manage",call_id="old-poll",ok=True,
        output={"tracking":_subtask_tracking("sub-a","running",revision=1),"large_duplicate":"duplicate "*2000})
    messages=loop._append_tool_round([], [LLMToolCall(id="spawn-sub-a",name="agent.manage",arguments={"action":"spawn","instruction":"a"})],
        [initial[0],duplicate,*exposed])
    text=str(messages[-1].content)
    assert full in text and "large_duplicate" not in text
    assert "old-poll" in text and "observation_history" in text
    assert duplicate.output["large_duplicate"]=="duplicate "*2000
