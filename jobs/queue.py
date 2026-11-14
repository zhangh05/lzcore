"""Job queue contract for local and distributed worker implementations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class QueueReceipt:
    workspace_id: str
    job_id: str
    lease_id: str
    attempt: int
    principal: str = ""
    delivery_id: str = ""


class JobQueue(Protocol):
    def enqueue(self, workspace_id: str, job_id: str) -> QueueReceipt: ...
    def claim(self, worker_id: str) -> QueueReceipt | None: ...
    def ack(self, receipt: QueueReceipt) -> None: ...
    def retry(self, receipt: QueueReceipt, reason: str = "") -> None: ...
    def heartbeat(self, receipt: QueueReceipt, worker_id: str) -> bool: ...
    def reclaim_stale(self, max_age_seconds: int) -> int: ...
    def health(self) -> dict[str, Any]: ...


def queue_mode() -> str:
    import os
    return os.environ.get("LZCORE_QUEUE_MODE", "filesystem").strip().lower() or "filesystem"


def queue_configuration() -> dict[str, Any]:
    import os
    mode = queue_mode()
    configured = bool(os.environ.get("LZCORE_QUEUE_URL"))
    return {"mode": mode, "url_configured": configured, "distributed_ready": mode == "redis" and configured}


class FileJobQueue:
    def enqueue(self, workspace_id: str, job_id: str) -> QueueReceipt:
        return QueueReceipt(workspace_id, job_id, f"file:{job_id}", 1)

    def claim(self, worker_id: str) -> QueueReceipt | None:
        from jobs.store import get_next_queued_job
        from storage.principal import (
            current_storage_principal,
            known_storage_principals,
            storage_principal,
        )
        principals = [current_storage_principal(), *known_storage_principals()]
        # The empty principal is the durable legacy/bootstrap storage domain,
        # not an invalid identity.  Workers must scan it alongside every
        # user-scoped domain or queued jobs created before identity binding can
        # never be claimed after a restart.
        for principal in dict.fromkeys(principals):
            with storage_principal(principal):
                job = get_next_queued_job()
            if job:
                return QueueReceipt(job.workspace_id, job.job_id, f"file:{job.job_id}", job.retry_count + 1, principal)
        return None

    def ack(self, receipt: QueueReceipt) -> None:
        return None

    def retry(self, receipt: QueueReceipt, reason: str = "") -> None:
        return None

    def heartbeat(self, receipt: QueueReceipt, worker_id: str) -> bool:
        return True

    def reclaim_stale(self, max_age_seconds: int) -> int:
        return 0

    def health(self) -> dict[str, Any]:
        return {"ok": True, "mode": "filesystem"}


class RedisJobQueue:
    QUEUED = "lzcore:jobs:queued"
    PROCESSING = "lzcore:jobs:processing"
    LEASES = "lzcore:jobs:leases"
    DISPATCHED = "lzcore:jobs:dispatched"

    def __init__(self, url: str):
        import redis
        self.client = redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)

    @staticmethod
    def _payload(workspace_id: str, job_id: str, attempt: int = 1, principal: str = "", delivery_id: str = "") -> str:
        import json
        return json.dumps({"workspace_id": workspace_id, "job_id": job_id, "attempt": attempt, "principal": principal, "delivery_id": delivery_id}, separators=(",", ":"))

    def enqueue(self, workspace_id: str, job_id: str) -> QueueReceipt:
        import json
        from storage.principal import current_storage_principal
        from jobs.store import get_job
        principal = current_storage_principal()
        record = get_job(workspace_id, job_id)
        if record is None:
            raise ValueError("cannot dispatch a missing or unreadable job")
        generation = record.retry_count
        dispatch_id = json.dumps([principal, workspace_id, job_id, generation], separators=(",", ":"))
        payload = self._payload(workspace_id, job_id, principal=principal, delivery_id=dispatch_id)
        # queued + retry_count is the durable outbox identity. If the reply is
        # lost, repeating this script observes the same dispatch marker.
        self.client.eval(
            """
            if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return 0 end
            redis.call('LPUSH', KEYS[1], ARGV[2])
            redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
            return 1
            """, 2, self.QUEUED, self.DISPATCHED, dispatch_id, payload,
        )
        return QueueReceipt(workspace_id, job_id, payload, 1, principal, dispatch_id)

    def dispatch_pending(self) -> None:
        """Reconcile durable queued jobs, including interrupted first dispatches."""
        from jobs.store import queued_jobs_for_dispatch
        from storage.principal import current_storage_principal, known_storage_principals, storage_principal
        principals = [current_storage_principal(), "", *known_storage_principals()]
        for principal in dict.fromkeys(principals):
            with storage_principal(principal):
                for job in queued_jobs_for_dispatch():
                    self.enqueue(job.workspace_id, job.job_id)

    def claim(self, worker_id: str) -> QueueReceipt | None:
        import json
        import time
        self.dispatch_pending()
        payload = self.client.eval(
            """
            local payload = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
            if not payload then
              return false
            end
            redis.call('HSET', KEYS[3], payload, ARGV[1])
            return payload
            """,
            3,
            self.QUEUED,
            self.PROCESSING,
            self.LEASES,
            json.dumps({"worker_id": worker_id, "heartbeat_at": time.time()}),
        )
        if not payload:
            return None
        data = json.loads(payload)
        return QueueReceipt(data["workspace_id"], data["job_id"], payload, int(data.get("attempt", 1)), str(data.get("principal") or ""), str(data.get("delivery_id") or ""))

    def ack(self, receipt: QueueReceipt) -> None:
        self.client.lrem(self.PROCESSING, 1, receipt.lease_id)
        self.client.hdel(self.LEASES, receipt.lease_id)

    def retry(self, receipt: QueueReceipt, reason: str = "") -> None:
        self.client.eval(
            """
            if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
            redis.call('LPUSH', KEYS[3], ARGV[2])
            redis.call('LREM', KEYS[2], 1, ARGV[1])
            redis.call('HDEL', KEYS[1], ARGV[1])
            return 1
            """, 3, self.LEASES, self.PROCESSING, self.QUEUED,
            receipt.lease_id,
            self._payload(receipt.workspace_id, receipt.job_id, receipt.attempt + 1, receipt.principal, receipt.delivery_id),
        )

    def heartbeat(self, receipt: QueueReceipt, worker_id: str) -> bool:
        import json
        import time
        if not self.client.hexists(self.LEASES, receipt.lease_id):
            return False
        self.client.hset(self.LEASES, receipt.lease_id, json.dumps({"worker_id": worker_id, "heartbeat_at": time.time()}))
        return True

    def reclaim_stale(self, max_age_seconds: int) -> int:
        import json
        import time
        reclaimed = 0
        now = time.time()
        for payload, raw in self.client.hgetall(self.LEASES).items():
            try:
                lease = json.loads(raw)
                stale = now - float(lease.get("heartbeat_at") or 0) > max(1, max_age_seconds)
                data = json.loads(payload)
            except (TypeError, ValueError, json.JSONDecodeError):
                stale = True
                data = {}
            if not stale:
                continue
            if not data.get("workspace_id") or not data.get("job_id"):
                self.client.hdel(self.LEASES, payload)
                self.client.lrem(self.PROCESSING, 1, payload)
                continue
            moved = self.client.eval(
                """
                if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
                  return 0
                end
                redis.call('HDEL', KEYS[1], ARGV[1])
                redis.call('LREM', KEYS[2], 1, ARGV[1])
                redis.call('LPUSH', KEYS[3], ARGV[3])
                return 1
                """,
                3,
                self.LEASES,
                self.PROCESSING,
                self.QUEUED,
                payload,
                raw,
                self._payload(data["workspace_id"], data["job_id"], int(data.get("attempt", 1)) + 1, str(data.get("principal") or ""), str(data.get("delivery_id") or "")),
            )
            if int(moved or 0):
                reclaimed += 1
        return reclaimed

    def health(self) -> dict[str, Any]:
        return {"ok": bool(self.client.ping()), "mode": "redis"}


def get_job_queue():
    import os
    mode = queue_mode()
    if mode == "redis":
        url = os.environ.get("LZCORE_QUEUE_URL", "").strip()
        if not url:
            raise RuntimeError("LZCORE_QUEUE_URL is required for redis queue")
        return RedisJobQueue(url)
    return FileJobQueue()
