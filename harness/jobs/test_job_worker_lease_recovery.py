from __future__ import annotations



def test_reclaimed_running_job_is_fenced_without_reexecution(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    import jobs.worker as worker
    from jobs.queue import QueueReceipt
    from jobs.schemas import JobRecord
    from jobs.store import create_job, get_job

    job = create_job(JobRecord(
        job_id="job_leaseexpired",
        workspace_id="default",
        job_type="agent_run",
        status="running",
        payload={"message": "must not replay"},
    ))

    class ReclaimedQueue:
        def __init__(self):
            self.acked = []

        def reclaim_stale(self, _seconds):
            return 1

        def claim(self, _worker_id):
            return QueueReceipt("default", job.job_id, "receipt-2", attempt=2)

        def ack(self, receipt):
            self.acked.append(receipt)

        def retry(self, *_args):
            raise AssertionError("reclaimed running job must not be retried")

        def heartbeat(self, *_args):
            return True

    queue = ReclaimedQueue()
    executed = []
    monkeypatch.setattr("jobs.queue.get_job_queue", lambda: queue)
    monkeypatch.setattr("jobs.runner.run_job", lambda *_args: executed.append(True))

    outcome = worker.run_once()
    current = get_job("default", job.job_id)

    assert outcome["status"] == "lease_expired"
    assert executed == []
    assert queue.acked and queue.acked[0].attempt == 2
    assert current and current.status == "failed"
    unknown = current.metadata["active_turn"]["unknown_outcome"]
    assert unknown["error_code"] == "WORKER_LEASE_EXPIRED"
    assert unknown["execution_may_continue"] is True

    queue.enqueue = lambda *_args: None
    from jobs.manager import retry_job
    retried = retry_job("default", job.job_id)
    assert retried.status == "queued"


def test_lost_lease_is_not_acked_or_recorded_as_completed(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_JOB_HEARTBEAT_SECONDS", "0.05")
    import jobs.worker as worker
    from jobs.queue import QueueReceipt
    from jobs.schemas import JobRecord
    from jobs.store import create_job, get_job

    job = create_job(JobRecord(
        job_id="job_leaselost",
        workspace_id="default",
        job_type="agent_run",
        status="queued",
        payload={"message": "keep going"},
    ))

    class LosingQueue:
        def __init__(self):
            self.acked = []
            self.retried = []

        def reclaim_stale(self, _seconds):
            return 0

        def claim(self, _worker_id):
            return QueueReceipt("default", job.job_id, "receipt-1", attempt=1)

        def ack(self, receipt):
            self.acked.append(receipt)

        def retry(self, receipt, reason=""):
            self.retried.append((receipt, reason))

        def heartbeat(self, *_args):
            return False

    queue = LosingQueue()
    monkeypatch.setattr("jobs.queue.get_job_queue", lambda: queue)

    def still_running(*_args, **_kwargs):
        import time
        time.sleep(0.2)

    monkeypatch.setattr("jobs.runner.run_job", still_running)
    outcome = worker.run_once()
    current = get_job("default", job.job_id)

    assert outcome["status"] == "lease_lost"
    assert queue.acked == []
    assert queue.retried == []
    assert current.status != "succeeded"
