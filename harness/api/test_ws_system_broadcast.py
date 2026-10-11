from __future__ import annotations

import json
import threading
import time

from backend.ws import agent_ws


class _SlowSocket:
    def __init__(self):
        self.sent = []
        self.entered = threading.Event()
        self.release = threading.Event()

    def send(self, payload):
        self.entered.set()
        self.release.wait(timeout=3)
        self.sent.append(payload)


def test_broadcast_enqueue_does_not_block_runtime_thread(monkeypatch):
    slow = _SlowSocket()
    with agent_ws._active_ws_lock:
        agent_ws._active_ws_connections.clear()
        agent_ws._active_ws_connections["slow"] = ("alice", "ws-1", slow)

    started = time.monotonic()
    with monkeypatch.context() as ctx:
        ctx.setattr(agent_ws, "current_storage_principal", lambda: "alice", raising=False)
        # broadcast_ws_event imports this function lazily.
        import storage.principal
        ctx.setattr(storage.principal, "current_storage_principal", lambda: "alice")
        agent_ws.broadcast_ws_event({
            "name": "job_updated",
            "data": {"workspace_id": "ws-1", "job_id": "job-1"},
        })
    assert time.monotonic() - started < 0.1
    assert slow.entered.wait(timeout=1)
    slow.release.set()


def test_turn_frames_do_not_share_a_coalesce_key():
    from backend.ws.agent_ws import broadcast_coalesce_key

    first = broadcast_coalesce_key("alice", "ws-1", {
        "name": "turn_frame",
        "data": {"workspace_id": "ws-1", "client_request_id": "req-1", "seq": 1},
    })
    second = broadcast_coalesce_key("alice", "ws-1", {
        "name": "turn_frame",
        "data": {"workspace_id": "ws-1", "client_request_id": "req-1", "seq": 2},
    })
    assert first != second


def test_topology_updates_coalesce_by_topology_id():
    from backend.ws.agent_ws import broadcast_coalesce_key

    older = broadcast_coalesce_key("alice", "ws-1", {
        "name": "topology_updated",
        "data": {"workspace_id": "ws-1", "topology_id": "topo-1", "version": 2},
    })
    newer = broadcast_coalesce_key("alice", "ws-1", {
        "name": "topology_updated",
        "data": {"workspace_id": "ws-1", "topology_id": "topo-1", "version": 3},
    })
    other = broadcast_coalesce_key("alice", "ws-1", {
        "name": "topology_updated",
        "data": {"workspace_id": "ws-1", "topology_id": "topo-2", "version": 1},
    })
    assert older == newer
    assert older != other


def test_pending_broadcasts_coalesce_to_latest_snapshot():
    with agent_ws._broadcast_cv:
        agent_ws._broadcast_pending.clear()
        agent_ws._broadcast_pending["alice:ws-1:job-1"] = ("alice", "ws-1", "old")
        agent_ws._broadcast_pending["alice:ws-1:job-1"] = ("alice", "ws-1", "new")
        assert len(agent_ws._broadcast_pending) == 1
        assert next(iter(agent_ws._broadcast_pending.values()))[2] == "new"


class _FastSocket:
    def __init__(self):
        self.sent = []
        self.received = threading.Event()

    def send(self, payload):
        self.sent.append(payload)
        self.received.set()


def test_slow_broadcast_recipient_does_not_block_peer_delivery(monkeypatch):
    slow = _SlowSocket()
    fast = _FastSocket()
    with agent_ws._active_ws_lock:
        agent_ws._active_ws_connections.clear()
        agent_ws._active_ws_connections.update({
            "slow-peer": ("alice", "ws-1", slow),
            "fast": ("alice", "ws-1", fast),
        })
    import storage.principal
    with monkeypatch.context() as ctx:
        ctx.setattr(storage.principal, "current_storage_principal", lambda: "alice")
        agent_ws.broadcast_ws_event({
            "name": "job_updated",
            "data": {"workspace_id": "ws-1", "job_id": "job-peer-delivery"},
        })
    assert slow.entered.wait(timeout=1)
    try:
        assert fast.received.wait(timeout=0.5)
    finally:
        slow.release.set()


def test_slow_recipient_preserves_deferred_events_for_distinct_jobs(monkeypatch):
    slow = _SlowSocket()
    with agent_ws._active_ws_lock:
        agent_ws._active_ws_connections.clear()
        agent_ws._active_ws_connections["slow-multiple"] = ("alice", "ws-1", slow)
        agent_ws._broadcast_inflight.clear()
        agent_ws._broadcast_deferred.clear()
    import storage.principal
    with monkeypatch.context() as ctx:
        ctx.setattr(storage.principal, "current_storage_principal", lambda: "alice")
        for job_id in ("job-first", "job-second", "job-third"):
            agent_ws.broadcast_ws_event({
                "name": "job_updated",
                "data": {"workspace_id": "ws-1", "job_id": job_id},
            })
    assert slow.entered.wait(timeout=1)
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        with agent_ws._active_ws_lock:
            deferred = dict(agent_ws._broadcast_deferred.get("slow-multiple", {}))
        if len(deferred) == 2:
            break
        time.sleep(0.01)
    assert len(deferred) == 2
    slow.release.set()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and len(slow.sent) < 3:
        time.sleep(0.01)
    assert [
        json.loads(payload)["data"]["job_id"] for payload in slow.sent
    ] == ["job-first", "job-second", "job-third"]


def test_remote_broadcast_restores_owner_from_bus_envelope(monkeypatch):
    import sys
    from types import SimpleNamespace
    from storage.principal import current_storage_principal
    delivered = []
    event = {"name": "topology_updated", "data": {"workspace_id": "default", "topology_id": "topo", "version": 2}}
    class Pubsub:
        def subscribe(self, _channel):
            pass
        def listen(self):
            yield {"type": "message", "data": json.dumps({"origin": "other-process", "username": "alice", "event": event})}
    class Redis:
        @staticmethod
        def from_url(*args, **kwargs):
            return SimpleNamespace(pubsub=lambda: Pubsub())
    monkeypatch.setitem(sys.modules, "redis", SimpleNamespace(Redis=Redis))
    monkeypatch.setattr(agent_ws, "broadcast_ws_event", lambda value, **kw: delivered.append((current_storage_principal(), value)))
    agent_ws._listen_broadcasts("redis://test")
    assert delivered == [("alice", event)]
