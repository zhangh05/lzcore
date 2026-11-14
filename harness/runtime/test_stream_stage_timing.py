from __future__ import annotations

import asyncio

import pytest


class _CaptureEmitter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def emit(self, name: str, payload: dict) -> None:
        self.calls.append((name, payload))


def test_engine_cancellation_stops_heartbeat_in_a_live_event_loop(monkeypatch):
    from core.runtime_engine.engine import SSOTRuntimeEngine
    from core.runtime_engine.query_loop import QueryLoop, QueryLoopResult
    from core.runtime_engine.models import SSOTRuntimeConfig
    from core.runtime_engine.tool_runtime import ToolRuntime

    async def scenario():
        entered = asyncio.Event()
        heartbeats = []
        engine = SSOTRuntimeEngine(config=SSOTRuntimeConfig(), tool_runtime=ToolRuntime(SSOTRuntimeConfig()), emitter=_CaptureEmitter())

        async def waiting_loop(*args):
            heartbeats.append(engine._heartbeat_task)
            entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(QueryLoop, "run", waiting_loop)
        task = asyncio.create_task(engine.run("cancel", workspace_id="test"))
        await entered.wait()
        # A shared engine must not overwrite the first run's heartbeat slot.
        with pytest.raises(RuntimeError, match="engine_already_running"):
            await engine.run("concurrent", workspace_id="test")
        assert engine._heartbeat_task is heartbeats[0]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert engine._heartbeat_task is None
        assert all(heartbeat.done() for heartbeat in heartbeats)
        assert engine._run_active is False
        # Sequential reuse after cancellation remains supported.
        async def completed_loop(*args):
            return QueryLoopResult(final_response="done")

        monkeypatch.setattr(QueryLoop, "run", completed_loop)
        assert (await engine.run("retry", workspace_id="test")).final_response == "done"
        assert engine._heartbeat_task is None

    asyncio.run(scenario())


def test_engine_stage_payload_has_turn_and_stage_elapsed(monkeypatch):
    from core.runtime_engine import engine as engine_module
    from core.runtime_engine.engine import SSOTRuntimeEngine

    emitter = _CaptureEmitter()
    runtime = object.__new__(SSOTRuntimeEngine)
    runtime._emitter = emitter
    monkeypatch.setattr(engine_module.time, "monotonic", lambda: 12.75)

    runtime._emit_stage("planner_started", 10.0, stage_elapsed_ms=320)

    assert emitter.calls == [
        ("planner_started", {
            "stage": "planner_started",
            "elapsed_ms": 2750,
            "turn_elapsed_ms": 2750,
            "stage_elapsed_ms": 320,
        }),
    ]


def test_query_loop_stage_payload_measures_current_stage(monkeypatch):
    from core.runtime_engine import query_loop as query_loop_module
    from core.runtime_engine.query_loop import QueryLoop

    emitter = _CaptureEmitter()
    loop = object.__new__(QueryLoop)
    loop._emitter = emitter
    monkeypatch.setattr(query_loop_module.time, "monotonic", lambda: 12.75)

    loop._emit_stage(
        "model_completed",
        10.0,
        stage_started_at=11.5,
        iteration=2,
    )

    assert emitter.calls == [
        ("model_completed", {
            "stage": "model_completed",
            "elapsed_ms": 2750,
            "turn_elapsed_ms": 2750,
            "stage_elapsed_ms": 1250,
            "iteration": 2,
        }),
    ]
