"""Lock pool reclamation must preserve mutual exclusion for waiters."""
import gc
import threading
from concurrent.futures import ThreadPoolExecutor
from storage.locking import FileLock
from storage.records import _lock_for


def test_completed_historical_paths_do_not_accumulate_locks(tmp_path):
    baseline = len(FileLock._thread_locks)
    for i in range(100):
        with FileLock(tmp_path / f"record_{i}.lock"):
            pass
        with _lock_for(tmp_path / f"record_{i}.json"):
            pass
    gc.collect()
    assert len(FileLock._thread_locks) <= baseline


def test_waiting_threads_share_the_same_lock_until_all_release(tmp_path):
    path = tmp_path / "record.lock"
    waiting, acquired, release = threading.Event(), threading.Event(), threading.Event()
    shared = _lock_for(path)

    def waiter(shared_lock):
        waiting.set()
        with FileLock(path) as held:
            assert held._thread_lock is shared_lock
            acquired.set()
            assert release.wait(5)
    with ThreadPoolExecutor(max_workers=1) as pool:
        try:
            with FileLock(path):
                future = pool.submit(waiter, shared)
                assert waiting.wait(5)
                assert not acquired.is_set()
                assert _lock_for(path) is shared
            assert acquired.wait(5)
            assert _lock_for(path) is shared
        finally:
            release.set()
        future.result(timeout=5)
    del shared
    gc.collect()
    assert str(path.resolve()) not in FileLock._thread_locks
