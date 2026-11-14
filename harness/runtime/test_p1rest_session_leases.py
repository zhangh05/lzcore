"""Turn holders and queued claims retain one session identity during eviction."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent.app.session_manager import SessionManager


def test_holder_and_waiter_pin_session_until_last_release(monkeypatch):
    manager = SessionManager(ttl_seconds=1, max_sessions=2)
    clock = [10.0]
    monkeypatch.setattr('agent.app.session_manager.time.monotonic', lambda: clock[0])
    sid, session, holder = manager.get_or_create('session-a', 'lease-ws', reserve_turn=True)
    claimed, entered = threading.Event(), threading.Event()
    release = threading.Event()

    def wait_turn():
        _, queued_session, waiter = manager.get_or_create(sid, 'lease-ws', reserve_turn=True)
        claimed.set()
        with waiter:
            assert queued_session is session
            entered.set()
            assert release.wait(3)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with holder:
            future = pool.submit(wait_turn)
            assert claimed.wait(2)
            clock[0] = 20.0
            manager.get_or_create('session-b', 'lease-ws')
            assert manager.get_or_create(sid, 'lease-ws')[1] is session
            assert not entered.is_set()
        try:
            assert entered.wait(2)
            clock[0] = 30.0
            manager.get_or_create('session-c', 'lease-ws')
            assert manager.get_or_create(sid, 'lease-ws')[1] is session
        finally:
            release.set()
        future.result(timeout=3)
    assert not manager._turn_leases
    clock[0] = 40.0
    assert manager.get_or_create(sid, 'lease-ws')[1] is not session


def test_claim_before_acquire_pins_capacity_and_exception_releases():
    manager = SessionManager(max_sessions=1)
    _, session, lease = manager.get_or_create('session-a', 'lease-ws', reserve_turn=True)
    with pytest.raises(RuntimeError, match='session_capacity_busy'):
        manager.get_or_create('session-b', 'lease-ws')
    with pytest.raises(OSError):
        with lease:
            raise OSError('synthetic storage failure')
    assert not manager._turn_leases
    manager.get_or_create('session-b', 'lease-ws')
    assert manager.snapshot()['session_count'] == 1


def test_facade_storage_failure_does_not_leak_lease(monkeypatch):
    from agent.app.facade import AgentApp
    app = AgentApp()
    app.session_manager.restore_callback = None
    def fail(*a):
        raise OSError('synthetic storage failure')
    monkeypatch.setattr('storage.session_store.ensure_session', fail)
    with pytest.raises(OSError):
        app.submit_user_message('hello', 'lease-ws', 'session-a')
    assert not app.session_manager._turn_leases
