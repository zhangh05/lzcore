"""Framework-level architectural tests for resilient location resolution and tool streaming."""

from __future__ import annotations

import time
from pathlib import Path
import pytest

from core.resolution.location_models import LocationCandidate, LocationResolution
from core.resolution.location_service import LocationResolver
from core.resolution.location_providers import LocationProviderUnavailable


class SlowMockProvider:
    name = "slow_provider"
    supports_reverse = True

    def __init__(self, delay: float = 0.5, error: Exception | None = None):
        self.delay = delay
        self.error = error
        self.calls = 0

    def search(self, query: str, *, language: str, limit: int, country_code: str = "", admin_hint: str = ""):
        self.calls += 1
        time.sleep(self.delay)
        if self.error:
            raise self.error
        return [
            LocationCandidate(
                canonical_name=query,
                latitude=12.34,
                longitude=56.78,
                provider=self.name,
                place_type="city",
                population=1000000,
            )
        ]

    def reverse(self, latitude: float, longitude: float, *, language: str):
        self.calls += 1
        time.sleep(self.delay)
        return []


def test_location_resolver_enforces_budget_deadline():
    # If each provider takes 0.25s, but budget is 0.1s, it stops before exhaustively trying all providers
    p1 = SlowMockProvider(delay=0.15, error=TimeoutError("p1 timeout"))
    p2 = SlowMockProvider(delay=0.15, error=TimeoutError("p2 timeout"))
    p3 = SlowMockProvider(delay=0.15, error=TimeoutError("p3 timeout"))

    resolver = LocationResolver((p1, p2, p3), timeout=0.1)
    start = time.monotonic()
    result = resolver.resolve("test place")
    elapsed = time.monotonic() - start

    assert result.ok is False
    assert "resolution_budget_exhausted" in result.warnings
    assert p3.calls == 0  # 3rd provider never called because deadline elapsed
    assert elapsed < 0.5  # strictly bounded


def test_location_resolver_persistent_disk_caching(tmp_path, monkeypatch):
    cache_file = tmp_path / "location_cache.json"

    def mock_cache_path():
        return cache_file

    monkeypatch.setattr("core.resolution.location_service._get_persistent_cache_file", mock_cache_path)

    provider = SlowMockProvider(delay=0.01)
    resolver1 = LocationResolver((provider,))

    res1 = resolver1.resolve("Persistent City")
    assert res1.ok is True
    assert provider.calls == 1
    assert cache_file.exists()

    # Create a fresh resolver instance (simulating app restart / new process)
    resolver2 = LocationResolver((provider,))
    res2 = resolver2.resolve("Persistent City")
    assert res2.ok is True
    assert res2.resolved.canonical_name == "Persistent City"
    # Should hit disk cache immediately without calling the provider again
    assert provider.calls == 1


def test_streaming_tool_executor_emits_execution_started_stage():
    from agent.llm.schemas import LLMToolCall
    from core.runtime_engine.models import SSOTRuntimeConfig
    from core.runtime_engine.query_loop import StreamingToolExecutor

    emitted = []

    class DummyEmitter:
        def emit(self, event_name, payload):
            emitted.append((event_name, payload))

    class DummyRuntime:
        def invoke_raw(self, tool, args):
            return {"ok": True, "result": "mock"}

    executor = StreamingToolExecutor(DummyRuntime(), SSOTRuntimeConfig(), DummyEmitter())
    tc = LLMToolCall(id="call_1", name="web__manage", arguments={"action": "weather", "location": "TestCity"})

    # Test direct _execute_one emission
    import asyncio
    result = asyncio.run(executor._execute_one(tc))

    assert result.ok is True
    started_events = [e for e in emitted if e[0] == "execution_started"]
    assert len(started_events) >= 1
    assert started_events[0][1]["tool"] == "web.manage"
    assert started_events[0][1]["action"] == "weather"
