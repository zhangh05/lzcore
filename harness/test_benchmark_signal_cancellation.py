import signal
import threading

import pytest

from scripts.run_coding_benchmark import signal_cancellation


def test_operator_signal_sets_runtime_gate_and_restores_handlers():
    previous = {kind: signal.getsignal(kind) for kind in (signal.SIGINT, signal.SIGTERM)}
    cancel, requested = threading.Event(), threading.Event()
    with signal_cancellation(cancel, requested):
        handler = signal.getsignal(signal.SIGINT)
        handler(signal.SIGINT, None)
        assert cancel.is_set() and requested.is_set()
    assert all(signal.getsignal(kind) is original for kind, original in previous.items())


def test_cancel_handlers_restore_when_agent_raises():
    previous = signal.getsignal(signal.SIGINT)
    with pytest.raises(RuntimeError), signal_cancellation(threading.Event(), threading.Event()):
        raise RuntimeError("failed agent")
    assert signal.getsignal(signal.SIGINT) is previous
