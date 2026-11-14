"""Offline queue fault probes; no Redis server or network is used."""
import json
import pytest

from jobs.queue import RedisJobQueue, QueueReceipt


class MemoryRedis:
    def __init__(self):
        self.queued, self.processing, self.leases, self.dispatched = [], [], {}, {}
        self.failure = ""

    def lpush(self, _key, value):
        if self.failure:
            raise OSError("connection lost")
        self.queued.insert(0, value)

    def lrem(self, _key, _count, value):
        self.processing.remove(value)

    def hdel(self, _key, value):
        self.leases.pop(value, None)

    def eval(self, _script, key_count, *args):
        if self.failure == "before":
            raise OSError("connection lost before execution")
        keys, values = args[:key_count], args[key_count:]
        if key_count == 2:
            dispatch_id, payload = values
            if dispatch_id in self.dispatched:
                return 0
            self.queued.insert(0, payload)
            self.dispatched[dispatch_id] = payload
            result = 1
        elif keys[0] == RedisJobQueue.LEASES:
            old, new = values
            if old not in self.leases:
                return 0
            self.queued.insert(0, new)
            self.processing.remove(old)
            self.leases.pop(old)
            result = 1
        else:
            if not self.queued:
                return None
            payload = self.queued.pop()
            self.processing.insert(0, payload)
            self.leases[payload] = values[0]
            result = payload
        if self.failure == "after":
            raise OSError("connection lost after execution")
        return result


def queue():
    result = object.__new__(RedisJobQueue)
    result.client = MemoryRedis()
    return result


@pytest.mark.parametrize("failure", ["before", "after"])
def test_retry_preserves_a_delivery_across_unknown_redis_result(failure):
    q = queue()
    old = q._payload("team", "job_synthetic", principal="alice", delivery_id="generation-1")
    receipt = QueueReceipt("team", "job_synthetic", old, 1, "alice", "generation-1")
    q.client.processing.append(old)
    q.client.leases[old] = "lease"
    q.client.failure = failure
    with pytest.raises(OSError):
        q.retry(receipt)
    assert len(q.client.processing) + len(q.client.queued) == 1
    if failure == "before":
        assert old in q.client.leases
    q.client.failure = ""
    q.retry(receipt)
    q.retry(receipt)  # retrying a lost reply cannot duplicate the new delivery
    assert not q.client.processing and not q.client.leases
    assert len(q.client.queued) == 1
    payload = json.loads(q.client.queued[0])
    assert payload["attempt"] == 2
    assert payload["principal"] == "alice"
    assert payload["delivery_id"] == "generation-1"


@pytest.mark.parametrize("failure", ["before", "after"])
def test_durable_queued_job_recovers_failed_or_unknown_first_dispatch(monkeypatch, tmp_path, failure):
    from jobs.manager import create_job, enqueue_job
    from jobs.store import get_job
    from storage.principal import storage_principal
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr("storage.principal.known_storage_principals", lambda: ["alice", "bob"])
    q = queue()
    monkeypatch.setattr("jobs.queue.get_job_queue", lambda: q)
    with storage_principal("alice"):
        job = create_job("team", "workflow_run", payload={"workflow_id": "synthetic"}, enqueue=False)
        q.client.failure = failure
        with pytest.raises(OSError):
            enqueue_job("team", job.job_id)
        assert get_job("team", job.job_id).status == "queued"
    q.client.failure = ""
    q.dispatch_pending()
    q.dispatch_pending()
    assert len(q.client.queued) == 1
    receipt = q.claim("worker")
    assert receipt.principal == "alice" and receipt.job_id == job.job_id
    assert len(q.client.processing) == 1
    q.dispatch_pending()
    assert not q.client.queued  # a processing delivery is not re-enqueued


def test_manual_retry_uses_a_new_durable_dispatch_identity(monkeypatch, tmp_path):
    from jobs.manager import create_job, retry_job
    from jobs.store import update_job
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr("storage.principal.known_storage_principals", list)
    q = queue()
    monkeypatch.setattr("jobs.queue.get_job_queue", lambda: q)
    job = create_job("team", "workflow_run", payload={"workflow_id": "synthetic"})
    first = json.loads(q.client.queued[0])["delivery_id"]
    q.client.queued.clear()
    update_job("team", job.job_id, {"status": "failed"})
    retry_job("team", job.job_id)
    q.dispatch_pending()
    assert len(q.client.queued) == 1
    assert json.loads(q.client.queued[0])["delivery_id"] != first


def test_dispatch_refuses_missing_record_without_creating_a_delivery(monkeypatch):
    q = queue()
    monkeypatch.setattr("jobs.store.get_job", lambda *_args: None)
    with pytest.raises(ValueError, match="missing or unreadable"):
        q.enqueue("team", "job_missing")
    assert q.client.queued == [] and q.client.dispatched == {}
