"""Memory Governance — canonical schema, gate, retrieval, and conflict lifecycle."""

from __future__ import annotations
import json, time as _time, logging, re, uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Optional, Literal
from storage.paths import user_memory_root
from storage.atomic_io import atomic_write_json
from storage.time_utils import from_iso, now_iso, to_iso
from storage.redaction import contains_secret as storage_contains_secret
from storage.redaction import redact_dict, redact_text
from storage.locking import FileLock


Scope = Literal["global","workspace","session","task"]
MemoryType = Literal[
    "core_rule","semantic_fact","episodic_case","procedural_rule",
    "profile","knowledge_note",
]
MemoryStatus = Literal["pending","active","rejected","expired","conflict"]
MemorySource = Literal[
    "user","tool","file","manual_confirm","agent_suggestion","subagent",
    "llm_tool","task","action","user_signal",
]

_REDACT_KEYS = {
    "password", "passwd", "pwd", "token", "api_key", "apikey",
    "secret", "credential", "authorization", "auth",
}
_VALID_SCOPES = {"global", "workspace", "session", "task"}
SUPPORTED_MEMORY_TYPES = frozenset({
    "core_rule", "semantic_fact", "episodic_case", "procedural_rule",
    "profile", "knowledge_note",
})
_VALID_MEMORY_TYPES = SUPPORTED_MEMORY_TYPES
_MEMORY_ID_RE = re.compile(r"^mem-[a-f0-9]{12}$")

MemoryProjectionHook = Callable[["MemoryRecord"], None]
MemoryDeleteHook = Callable[[str, str], None]
MemoryRankHook = Callable[[str, list[dict], int], list[dict]]
MemoryEventHook = Callable[[str, "MemoryRecord", str], None]

_projection_hook: MemoryProjectionHook | None = None
_delete_hook: MemoryDeleteHook | None = None
_rank_hook: MemoryRankHook | None = None
_event_hook: MemoryEventHook | None = None


def configure_memory_hooks(
    *,
    projection: MemoryProjectionHook | None = None,
    delete_projection: MemoryDeleteHook | None = None,
    rank: MemoryRankHook | None = None,
    event: MemoryEventHook | None = None,
) -> None:
    """Register upper-layer services without making storage import them."""
    global _projection_hook, _delete_hook, _rank_hook, _event_hook
    if projection is not None:
        _projection_hook = projection
    if delete_projection is not None:
        _delete_hook = delete_projection
    if rank is not None:
        _rank_hook = rank
    if event is not None:
        _event_hook = event

def _now(): return now_iso()
def _mid(): return f"mem-{uuid.uuid4().hex[:12]}"

@dataclass
class MemoryRecord:
    memory_id: str = field(default_factory=_mid)
    workspace_id: str = ""
    session_id: str = ""
    task_id: str = ""
    scope: Scope = "workspace"
    memory_type: MemoryType = "knowledge_note"
    status: MemoryStatus = "pending"
    source: MemorySource = "agent_suggestion"
    source_ref: str = ""
    content: str = ""
    summary: str = ""
    confidence: float = 0.5
    ttl_seconds: Optional[int] = None
    expires_at: str = ""
    citations: list = field(default_factory=list)
    conflict_group: str = ""
    created_by: str = ""
    created_at: str = ""
    updated_at: str = ""
    last_used_at: str = ""
    redacted: bool = True
    metadata: dict = field(default_factory=dict)
    schema_version: int = 2

    def __post_init__(self):
        n = _now()
        if not self.created_at: self.created_at = n
        if not self.updated_at: self.updated_at = n
        if self.ttl_seconds and not self.expires_at:
            self.expires_at = to_iso(_time.time() + self.ttl_seconds)

    def is_retrievable(self) -> bool:
        if self.status != "active": return False
        if self.memory_type not in _VALID_MEMORY_TYPES: return False
        if self.expires_at:
            try:
                if from_iso(self.expires_at) < _time.time():
                    return False
            except (TypeError, ValueError):
                return False
        return True

    def to_dict(self) -> dict: return asdict(self)
    @classmethod
    def from_dict(cls, d: dict): return cls(**{k:v for k,v in d.items() if k in cls.__dataclass_fields__})


def memory_scope_visible(record: dict, *, workspace_id: str = "", session_id: str = "", task_id: str = "") -> bool:
    """Personal memory is shared; project and transient memory retain ownership."""
    scope = record.get("scope")
    if scope == "global":
        return True
    if not workspace_id or record.get("workspace_id") != workspace_id:
        return False
    if scope == "workspace":
        return True
    if scope == "session":
        return bool(session_id) and record.get("session_id") == session_id
    if scope == "task":
        return bool(task_id) and record.get("task_id") == task_id
    return False


class MemoryStore:
    """Persist one governed long-term memory collection per user."""

    def __init__(self):
        self._load_errors: list[dict[str, str]] = []

    def load_errors(self) -> list[dict[str, str]]:
        """Return record-level load diagnostics from the latest read."""
        return list(self._load_errors)

    def _record_load_error(self, path: Path, exc: Exception) -> None:
        self._load_errors.append({"path": str(path.name), "error": type(exc).__name__})
        logging.getLogger("memory_governance.read").warning(
            "memory record unavailable: %s (%s)", path.name, type(exc).__name__,
        )

    def _validated_ws_id(self, ws_id: str) -> str:
        from storage.ids import validate_workspace_id
        return validate_workspace_id(ws_id)

    def _dir(self, ws_id: str) -> Path:
        self._validated_ws_id(ws_id)  # workspace remains required provenance.
        return user_memory_root()

    def _path(self, ws_id: str, memory_id: str) -> Path:
        memory_id = str(memory_id or "")
        if not _MEMORY_ID_RE.fullmatch(memory_id):
            raise ValueError("invalid_memory_id")
        return self._dir(ws_id) / f"{memory_id}.json"

    def mutation_lock(self, ws_id: str):
        root = self._dir(ws_id)
        root.mkdir(parents=True, exist_ok=True)
        return FileLock(root / '.mutation.lock')

    def _read_record(self, path: Path) -> MemoryRecord:
        """Preserve legacy shared explicit rules and profiles once, without interpreting prose."""
        data = json.loads(path.read_text(encoding="utf-8"))
        if int(data.get('schema_version') or 1) < 2:
            with FileLock(path.with_suffix('.migration.lock')):
                data = json.loads(path.read_text(encoding="utf-8"))
                if int(data.get('schema_version') or 1) < 2:
                    metadata = dict(data.get('metadata') or {})
                    if data.get('scope') == 'workspace' and (
                        data.get('memory_type') == 'profile'
                        or metadata.get('generation_origin') == 'user_memory_command'
                    ):
                        data['scope'] = 'global'
                        metadata['scope_migration'] = 'legacy_shared_user_rule_v2'
                    data['metadata'] = metadata
                    data['schema_version'] = 2
                    atomic_write_json(path, data)
        return MemoryRecord.from_dict(data)

    def _save(self, record: MemoryRecord):
        """Internal write — gate checks are enforced by MemoryWriteGate."""
        record.workspace_id = self._validated_ws_id(record.workspace_id)
        record.content = _redact(record.content)
        record.summary = _redact(record.summary)
        record.source_ref = _redact(record.source_ref)
        record.citations = _redact_structured(list(record.citations or []))
        record.metadata = _redact_structured(dict(record.metadata or {}))
        d = self._dir(record.workspace_id); d.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self._path(record.workspace_id, record.memory_id), record.to_dict())

        if _projection_hook is not None:
            try:
                _projection_hook(record)
            except Exception as e:
                logging.getLogger("memory_governance._save").warning(
                    "memory projection failed for %s: %s",
                    record.memory_id, e,
                )
        else:
            self.default_projection_upsert(record)

    def projection_item(self, record: MemoryRecord) -> dict:
        return {
            "item_type": "memory_hit",
            "item_id": f"mh_{record.memory_id}",
            "workspace_id": record.workspace_id,
            "source": "memory_governance",
            "title": record.summary[:200] if record.summary else record.content[:200],
            "summary": record.summary if record.summary else record.content,
            "content": record.content,
            "memory_id": record.memory_id,
            "memory_type": record.memory_type,
            "confidence": record.confidence,
            "scope": record.scope,
            "session_id": record.session_id,
            "task_id": record.task_id,
            "expires_at": record.expires_at,
            "tags": [],
            "status": record.status,
            "memory_status": record.status,
            "confirmation_status": "confirmed",
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "memory_key": str((record.metadata or {}).get("memory_key") or ""),
            "authority": str((record.metadata or {}).get("authority") or ""),
            "authority_rank": int((record.metadata or {}).get("authority_rank") or 0),
        }

    def default_projection_upsert(self, record: MemoryRecord) -> None:
        """Persist a storage-owned projection for environments without hooks."""
        from storage.records import append_jsonl

        item_id = f"mh_{record.memory_id}"
        if record.is_retrievable():
            append_jsonl(record.workspace_id, ("context", "items.jsonl"), self.projection_item(record))
            return
        append_jsonl(record.workspace_id, ("context", "items.jsonl"), {
            "item_id": item_id,
            "deleted": True,
            "deleted_at": _now(),
        })

    def delete_projection(self, ws_id: str, memory_id: str) -> None:
        if _delete_hook is not None:
            try:
                _delete_hook(ws_id, memory_id)
                return
            except Exception as exc:
                logging.getLogger("memory_governance.delete").warning(
                    "memory projection hook delete failed for %s: %s", memory_id, exc,
                )
        try:
            from storage.records import mutate_jsonl

            item_id = f"mh_{memory_id}"

            def remove(rows):
                kept = [row for row in rows if row.get("item_id") != item_id]
                return kept, None

            mutate_jsonl(ws_id, ("context", "items.jsonl"), remove)
        except Exception:
            logging.getLogger("memory_governance._save").warning(
                "memory projection delete failed for %s", memory_id, exc_info=True,
            )

    def delete_file(self, ws_id: str, memory_id: str) -> bool:
        """Physically delete a memory record file."""
        with self.mutation_lock(ws_id):
            return self._delete_file_locked(ws_id, memory_id)

    def _delete_file_locked(self, ws_id: str, memory_id: str) -> bool:
        ws_id = self._validated_ws_id(ws_id)
        record = self.get(ws_id, memory_id)
        if record is None:
            return False
        try:
            p = self._path(ws_id, memory_id)
        except ValueError:
            return False
        if p.exists():
            # Deleting a link must not resurrect ancestors after interrupted cleanup.
            records = self.list_all(ws_id)
            if record.status == 'active' or record.memory_id in self.superseded_records(records):
                _retire_revision_ancestors(self, record, records)
            p.unlink()
            self.delete_projection(record.workspace_id, memory_id)
            return True
        return False

    def get(self, ws_id: str, memory_id: str) -> Optional[MemoryRecord]:
        with self.mutation_lock(ws_id):
            return self._get_locked(ws_id, memory_id)

    def _get_locked(self, ws_id: str, memory_id: str) -> Optional[MemoryRecord]:
        self._load_errors = []
        try:
            p = self._path(ws_id, memory_id)
        except ValueError:
            return None
        if not p.exists(): return None
        try:
            record = self._read_record(p)
            return record if record.scope == 'global' or record.workspace_id == ws_id else None
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            self._record_load_error(p, exc)
            return None

    def list_all(self, ws_id: str) -> list[MemoryRecord]:
        with self.mutation_lock(ws_id):
            return self._list_all_locked(ws_id)

    def _list_all_locked(self, ws_id: str) -> list[MemoryRecord]:
        self._load_errors = []
        d = self._dir(ws_id)
        if not d.exists(): return []
        recs = []
        candidates: list[tuple[float, Path]] = []
        for f in d.glob("*.json"):
            try:
                candidates.append((f.stat().st_mtime, f))
            except OSError as exc:
                self._record_load_error(f, exc)
        for _, f in sorted(candidates, key=lambda item: item[0], reverse=True):
            try:
                record = self._read_record(f)
                if record.scope == 'global' or record.workspace_id == ws_id:
                    recs.append(record)
            except Exception as exc:  # bad user data must not hide healthy records
                self._record_load_error(f, exc)
                continue
        return recs

    def list_by_status(self, ws_id: str, status: MemoryStatus) -> list[MemoryRecord]:
        return [r for r in self.list_all(ws_id) if r.status == status]

    @staticmethod
    def revision_ancestors(record: MemoryRecord, records: list[MemoryRecord]) -> list[MemoryRecord]:
        by_id = {r.memory_id: r for r in records}
        seen = {record.memory_id}
        ancestors = []
        current = record
        while True:
            target_id = str(current.metadata.get('supersedes_memory_id') or '')
            target = by_id.get(target_id)
            if not target or target_id in seen or not _same_revision_domain(record, target):
                return ancestors
            ancestors.append(target)
            seen.add(target_id)
            current = target

    @staticmethod
    def superseded_records(records: list[MemoryRecord]) -> dict[str, str]:
        """Derive published replacement chains, including interrupted cleanup."""
        replaced = {}
        for newer in records:
            for older in MemoryStore.revision_ancestors(newer, records):
                if newer.status == 'active':
                    replaced.setdefault(older.memory_id, newer.memory_id)
                elif newer.status in {'pending', 'conflict'} and older.status in {'pending', 'conflict'}:
                    replaced.setdefault(older.memory_id, newer.memory_id)
                else:
                    break
        return replaced

    def list_retrievable(self, ws_id: str, scope: Scope = "workspace",
                         session_id: str = "", memory_type: str = "",
                         limit: int = 100, task_id: str = "") -> list[dict]:
        all_recs = self.list_all(ws_id)
        replaced = self.superseded_records(all_recs)
        results = []
        for r in all_recs:
            if not r.is_retrievable(): continue
            if r.memory_id in replaced: continue
            if not memory_scope_visible(r.to_dict(), workspace_id=ws_id, session_id=session_id, task_id=task_id):
                continue
            if memory_type and r.memory_type != memory_type: continue
            results.append(r)
            if limit > 0 and len(results) >= limit:
                break
        return [r.to_dict() for r in results]

    def search(self, ws_id: str, query: str, limit: int = 10, offset: int = 0,
               retrievable_only: bool = False, session_id: str = "", task_id: str = "",
               scope_filter: str = "", type_filter: str = "", status_filter: str = "") -> list[dict]:
        """Search all lifecycle records for the memory-management surface."""
        ws_id = self._validated_ws_id(ws_id)
        limit = 0 if int(limit) == 0 else max(1, min(int(limit), 100))
        offset = max(0, int(offset))
        records = (self.list_retrievable(ws_id, session_id=session_id, task_id=task_id, limit=0)
                   if retrievable_only else [record.to_dict() for record in self.list_all(ws_id)])
        records = [r for r in records if (not scope_filter or r['scope'] == scope_filter)
                   and (not type_filter or r['memory_type'] == type_filter)
                   and (not status_filter or r['status'] == status_filter)]
        count = offset + limit if limit else len(records)
        if not str(query or "").strip():
            return records[offset:offset + limit] if limit else records[offset:]
        if _rank_hook is not None:
            return _rank_hook(str(query), records, count)[offset:offset + limit] if limit else _rank_hook(str(query), records, count)[offset:]
        return _rank_records(str(query), records, count)[offset:offset + limit] if limit else _rank_records(str(query), records, count)[offset:]

    def find_conflicts(self, record: MemoryRecord) -> list[MemoryRecord]:
        """Find records with the same structured semantic key."""
        memory_key = str((record.metadata or {}).get("memory_key") or "").strip()
        if not memory_key:
            return []
        existing = self.list_all(record.workspace_id)
        replaced = self.superseded_records(existing)
        conflicts = []
        for r in existing:
            if r.memory_id == record.memory_id: continue
            if r.memory_id in replaced: continue
            if r.scope != record.scope: continue
            if r.memory_type != record.memory_type: continue
            if record.scope == "session" and r.session_id != record.session_id: continue
            if record.scope == "task" and r.task_id != record.task_id: continue
            if r.status not in ("active", "pending"): continue
            existing_key = str((r.metadata or {}).get("memory_key") or "").strip()
            if existing_key == memory_key:
                conflicts.append(r)
        return conflicts


# ── Write Gate ──

class MemoryWriteGate:
    """All memory writes must go through this gate."""

    def __init__(self, store: MemoryStore = None):
        self.store = store or MemoryStore()

    def write(self, candidate: MemoryRecord) -> dict:
        """Apply the single layered memory safety and authority policy."""
        if not candidate.workspace_id:
            return {"ok": False, "error": "workspace_id is required", "rejected": True, "status": "rejected", "memory_id": ""}
        try:
            candidate.workspace_id = self.store._validated_ws_id(candidate.workspace_id)
        except ValueError:
            return {"ok": False, "error": "invalid_workspace_id", "rejected": True, "status": "rejected", "memory_id": candidate.memory_id}
        with self.store.mutation_lock(candidate.workspace_id):
            return self._write_locked(candidate)

    def _write_locked(self, candidate: MemoryRecord) -> dict:
        # 1. Workspace required
        if not candidate.workspace_id:
            return {"ok": False, "status": "rejected", "memory_id": "",
                    "rejected": True, "error": "workspace_id is required"}
        try:
            from storage.ids import validate_workspace_id
            candidate.workspace_id = validate_workspace_id(candidate.workspace_id)
        except Exception:
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "invalid_workspace_id"}
        if candidate.scope not in _VALID_SCOPES:
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "invalid_memory_scope"}
        if candidate.memory_type not in _VALID_MEMORY_TYPES:
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "invalid_memory_type"}
        if candidate.scope == "session" and not candidate.session_id:
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "session_id_required"}
        if candidate.scope == "task" and not candidate.task_id:
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "task_id_required"}

        try:
            self.store._path(candidate.workspace_id, candidate.memory_id)
        except ValueError:
            return {'ok': False, 'error': 'invalid_memory_id', 'memory_id': candidate.memory_id}
        existing = self.store.get(candidate.workspace_id, candidate.memory_id)
        if self.store.load_errors():
            return {'ok': False, 'error': 'memory_record_unavailable', 'memory_id': candidate.memory_id}
        if existing is not None:
            if existing.content == _redact(candidate.content) and _same_revision_domain(candidate, existing):
                return {'ok': True, 'status': existing.status, 'memory_id': existing.memory_id, 'reconciled': True}
            return {'ok': False, 'error': 'memory_identity_conflict', 'memory_id': candidate.memory_id}

        # 2. Secret rejection on original content before redaction; otherwise
        # redaction can hide the exact pattern from the detector.
        persistable_payload = {
            "content": candidate.content,
            "summary": candidate.summary,
            "source_ref": candidate.source_ref,
            "citations": candidate.citations,
            "metadata": candidate.metadata,
        }
        if _contains_secret_pattern(persistable_payload):
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "content contains secret-like patterns, rejected"}
        if _is_low_value_memory(candidate):
            candidate.status = "rejected"
            candidate.redacted = True
            self.store._save(candidate)
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id,
                    "rejected": True, "error": "low_value_memory"}

        # 3. Redaction
        candidate.content = _redact(candidate.content)
        candidate.summary = _redact(candidate.summary)

        # Agent and subagent claims are proposals until the selected gate makes
        # an explicit decision. Confidence alone is never proof.
        is_subagent = candidate.created_by == "subagent" or candidate.source == "subagent"
        is_agent_generated = candidate.source in ("agent_suggestion", "subagent") or is_subagent
        if is_agent_generated:
            candidate.status = "pending"

        # Explicit user rules and manual knowledge are authoritative at write time.
        _auto_confirm_types = {"core_rule", "knowledge_note", "profile"}
        _auto_sources = {"user", "manual_confirm"}
        if (
            candidate.status == "pending"
            and candidate.memory_type in _auto_confirm_types
            and candidate.confidence >= 0.5
            and candidate.source in _auto_sources
        ):
            candidate.status = "active"

        warnings: list[dict] = []

        # The task-level consolidator already made the single semantic decision.
        # This gate only validates its cached score and evidence authority; it
        # never makes a second LLM call.
        if is_agent_generated:
            accepted, skipped = _validate_consolidation_decision(candidate)
            if accepted is None:
                candidate.status = "pending"
                warnings.extend(skipped)
            elif not accepted:
                reason = skipped[0].get("reason", "consolidation_rejected") if skipped else "consolidation_rejected"
                candidate.status = "pending"
                warnings.extend(skipped)
            else:
                score = int(candidate.metadata.get("llm_score", 0) or 0)
                # A generated procedural instruction can easily turn one
                # task's transient recovery tactic into a workspace-wide rule.
                # Keep it pending until a human confirms it; verified tools
                # may establish facts and cases, not standing operating policy.
                auto_safe_types = {"semantic_fact", "episodic_case"}
                authority = str(candidate.metadata.get("authority") or "")
                if (
                    is_subagent
                    or score < 4
                    or candidate.memory_type not in auto_safe_types
                    or authority != "verified_tool"
                    or not _has_verified_observation(candidate)
                ):
                    candidate.status = "pending"
                else:
                    candidate.status = "active"
                warnings.extend(skipped)

        # Explicit revision targets are ownership-checked before any write.
        target_id = str(candidate.metadata.get('supersedes_memory_id') or '')
        target = self.store.get(candidate.workspace_id, target_id) if target_id else None
        if target_id and (target is None or target.memory_id == candidate.memory_id or not _same_revision_domain(candidate, target)):
            return {"ok": False, "status": "rejected", "memory_id": candidate.memory_id, "error": "invalid_memory_revision_target", "rejected": True}
        if target and target.memory_id in self.store.superseded_records(self.store.list_all(candidate.workspace_id)):
            return {'ok': False, 'error': 'memory_revision_stale', 'memory_id': candidate.memory_id}
        # 8. Conflict detection
        conflicts = self.store.find_conflicts(candidate)
        if target is not None and target.status == 'active' and target not in conflicts:
            conflicts.append(target)
        previous = None
        if conflicts:
            duplicates = [
                existing for existing in conflicts
                if str(existing.content or existing.summary).strip() == str(candidate.content or candidate.summary).strip()
            ]
            if duplicates:
                existing = duplicates[0]
                return {
                    "ok": True,
                    "status": existing.status,
                    "memory_id": existing.memory_id,
                    "rejected": False,
                    "duplicate": True,
                    "duplicate_of": existing.memory_id,
                }
            if candidate.source in {"user", "manual_confirm"} and (target is not None or candidate.memory_type == "core_rule"):
                previous = target or sorted(conflicts, key=lambda item: item.updated_at, reverse=True)[0]
                candidate.metadata["supersedes_memory_id"] = previous.memory_id
                conflicts = []
            active_conflicts = [c for c in conflicts if c.status == "active"]
            if active_conflicts:
                group = f"cg-{uuid.uuid4().hex[:12]}"
                candidate.status = "conflict"
                candidate.conflict_group = group
                candidate.metadata["conflict_memory_ids"] = [c.memory_id for c in active_conflicts]
                for existing in active_conflicts:
                    existing.conflict_group = group
                    existing.updated_at = _now()
                    self.store._save(existing)

        # 9. Persist
        candidate.redacted = True
        self.store._save(candidate)
        if target is not None and target.status in {'pending', 'conflict'}:
            target.status = 'rejected'
            target.updated_at = _now()
            target.metadata['superseded_by'] = candidate.memory_id
            self.store._save(target)
        if candidate.status == 'active':
            _retire_revision_ancestors(self.store, candidate)
        result = {"ok": True, "status": candidate.status, "memory_id": candidate.memory_id,
                  "rejected": False, "conflict": candidate.status == "conflict"}
        if warnings:
            result["warnings"] = warnings
        return result


# ── Promotion ──

def confirm_memory(ws_id: str, memory_id: str, *, authority: str = "manual_confirm") -> dict:
    store = MemoryStore()
    with store.mutation_lock(ws_id):
        return _confirm_memory_locked(store, ws_id, memory_id, authority)

def _confirm_memory_locked(store: MemoryStore, ws_id: str, memory_id: str, authority: str) -> dict:
    rec = store.get(ws_id, memory_id)
    if not rec: return {"ok": False, "error": "not found"}
    if rec.status not in ("pending", "conflict"):
        return {"ok": False, "error": f"cannot confirm status {rec.status}"}
    target_id = str(rec.metadata.get('supersedes_memory_id') or '')
    target = store.get(ws_id, target_id) if target_id else None
    if target_id and (target is None or target.memory_id == rec.memory_id or not _same_revision_domain(rec, target)):
        return {'ok': False, 'error': 'invalid_memory_revision_target'}
    if rec.metadata.get('proposed_action') == 'expire':
        if target is None:
            return {'ok': False, 'error': 'invalid_memory_revision_target'}
        target.status = 'expired'
        target.updated_at = _now()
        store._save(target)
        rec.status = 'expired'
        rec.updated_at = _now()
        rec.metadata.update(decision='confirmed_retirement', authority=authority, authority_rank=90 if authority == 'manual_confirm' else 60)
        store._save(rec)
        _emit_event(ws_id, rec, 'memory_confirmed')
        return {'ok': True, 'status': 'expired', 'memory_id': rec.memory_id}
    if target and target.memory_id in store.superseded_records(store.list_all(ws_id)):
        return {'ok': False, 'error': 'memory_revision_stale'}
    rec.status = "active"; rec.updated_at = _now()
    rec.metadata.update(authority=authority, authority_rank=90 if authority == 'manual_confirm' else 60)
    store._save(rec)
    # The replacement becomes authoritative before the old record is retired.
    # Retrieval also honors the persisted replacement link across interruption.
    _retire_revision_ancestors(store, rec)
    # Resolve conflicts: expire conflicting active memories in same group
    if rec.conflict_group:
        for r in store.list_all(ws_id):
            if r.conflict_group == rec.conflict_group and r.memory_id != rec.memory_id and r.status == "active":
                r.status = "expired"; store._save(r)
    _emit_event(ws_id, rec, "memory_confirmed")
    return {"ok": True, "status": "active"}

def reject_memory(ws_id: str, memory_id: str) -> dict:
    return _retire_memory(ws_id, memory_id, 'rejected')


def expire_memory(ws_id: str, memory_id: str) -> dict:
    return _retire_memory(ws_id, memory_id, 'expired')


def _retire_memory(ws_id: str, memory_id: str, status: str) -> dict:
    store = MemoryStore()
    with store.mutation_lock(ws_id):
        rec = store.get(ws_id, memory_id)
        if not rec:
            return {'ok': False, 'error': 'not found'}
        if rec.status != status:
            if rec.status == 'active':
                _retire_revision_ancestors(store, rec)
            rec.status = status
            rec.updated_at = _now()
            store._save(rec)
            _emit_event(ws_id, rec, 'memory_' + status)
        return {'ok': True, 'status': status, 'memory_id': memory_id}


def _same_revision_domain(new: MemoryRecord, old: MemoryRecord) -> bool:
    return (new.scope == old.scope and new.memory_type == old.memory_type
            and (new.scope == 'global' or new.workspace_id == old.workspace_id)
            and (new.scope != 'session' or new.session_id == old.session_id)
            and (new.scope != 'task' or new.task_id == old.task_id))


def _retire_revision_ancestors(store: MemoryStore, record: MemoryRecord, records=None) -> None:
    for previous in store.revision_ancestors(record, records if records is not None else store.list_all(record.workspace_id)):
        if previous.status == 'active':
            previous.status = 'expired'
            previous.updated_at = _now()
            previous.metadata['superseded_by'] = record.memory_id
            store._save(previous)


def verified_observation(workspace_id: str, session_id: str, evidence: dict) -> dict | None:
    """Validate an exact, historical tool quotation, never a generated claim."""
    from storage.memory_event_store import read_events
    if not session_id or not isinstance(evidence, dict):
        return None
    index = evidence.get('tool_index')
    quote = evidence.get('quote')
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or not isinstance(quote, str) or not quote.strip():
        return None
    event = next((row for row in read_events(workspace_id, session_id)
                  if row.get('event_id') == evidence.get('event_id')), None)
    if not event or index >= len(event.get('tool_calls') or []):
        return None
    tool = event['tool_calls'][index]
    if quote != tool.get('summary'):
        return None
    status = '成功' if tool.get('ok') else '失败'
    content = f"历史工具观察（{event['created_at']} · {tool['tool_id']} · 工具执行{status}）：\n{quote}"
    return {'content': content, 'summary': '历史工具观察：' + tool['tool_id'], 'event_id': event['event_id'], 'tool_index': index,
            'quote': quote, 'recorded_at': event['created_at'], 'tool_id': tool['tool_id'], 'tool_ok': bool(tool.get('ok'))}


def _has_verified_observation(record: MemoryRecord) -> bool:
    if record.memory_type != 'episodic_case' or record.scope == 'global':
        return False
    evidence = verified_observation(record.workspace_id, record.session_id,
                                    record.metadata.get('verified_observation'))
    return bool(evidence and record.content == evidence['content'] and record.summary == evidence['summary'])


# ── Helpers ──

def _redact(text: str) -> str:
    return redact_text(str(text or "")).replace("[REDACTED_SECRET]", "[REDACTED]")


def _redact_structured(value: Any) -> Any:
    if isinstance(value, dict):
        return _normalize_redaction_mask(redact_dict(value))
    if isinstance(value, list):
        return [_redact_structured(item) for item in value]
    if isinstance(value, str):
        return _redact(value)
    return value


def _normalize_redaction_mask(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _normalize_redaction_mask(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_redaction_mask(item) for item in value]
    if value == "[REDACTED_SECRET]":
        return "[REDACTED]"
    if isinstance(value, str):
        return value.replace("[REDACTED_SECRET]", "[REDACTED]")
    return value

def _contains_secret_pattern(data) -> bool:
    return _structured_contains_secret(data)


def _structured_contains_secret(data: Any) -> bool:
    if isinstance(data, dict):
        for key, value in data.items():
            field = str(key).lower().replace("-", "_")
            if field in _REDACT_KEYS or field.endswith((
                "_password", "_passwd", "_pwd", "_token", "_api_key",
                "_secret", "_credential", "_authorization",
            )):
                return True
            if _structured_contains_secret(value):
                return True
        return False
    if isinstance(data, list):
        return any(_structured_contains_secret(item) for item in data)
    return storage_contains_secret(str(data or ""))


def _is_low_value_memory(record: MemoryRecord) -> bool:
    # Check summary and content independently — concatenating them can
    # hide generic content (e.g. "completed" + "completed." → "completed completed.").
    generic_words = {"", "started", "completed", "ok", "true", "false", "success", "failed", "done", "finish", "finished"}
    content = (record.content or "").strip()
    if not content:
        return True
    for text in (record.content, record.summary):
        text = (text or "").strip().lower().rstrip(".。!！?？,，;；")
        if not text:
            continue
        if text in generic_words:
            return True
        # Check after common separators (e.g. "workspace.file: completed" → "completed")
        for sep in (": ", ":", " — ", " - "):
            if sep in text:
                after = text.split(sep, 1)[1].strip()
                if after in generic_words:
                    return True
                after_first = after.split()[0] if after else ""
                if after_first in {"completed", "started", "finished", "success", "failed", "ok", "done", "running", "executed"} and len(after) <= len(after_first) + 8:
                    return True
    full = " ".join([record.summary or "", record.content or ""]).strip().lower()
    if record.memory_type == "episodic_case":
        import re
        generic_completion_patterns = [
            r"task\s+'?[\w\-]+'?\s+completed\s+successfully",
            r"task completed successfully",
            r"result:\s*search completed successfully",
        ]
        if any(re.search(p, full) for p in generic_completion_patterns):
            return True
    return False

def _validate_consolidation_decision(record: MemoryRecord) -> tuple[Optional[bool], list[dict]]:
    """Validate the task consolidator's cached semantic decision."""
    if record.metadata and isinstance(record.metadata, dict):
        cached_score = record.metadata.get("llm_score")
        if cached_score is not None:
            record.metadata["llm_score"] = int(cached_score)
            cached_keep = record.metadata.get("llm_keep", True)
            if cached_keep and int(cached_score) >= 3:
                cached_summary = record.metadata.get("llm_summary", "")
                if cached_summary:
                    record.summary = str(cached_summary)
                return True, []
            return False, [{"reason": f"llm_score_too_low ({cached_score})"}]
    return None, [{"reason": "consolidation_decision_missing"}]

def _text_similarity(a: str, b: str) -> float:
    def _tokens(text: str) -> set[str]:
        import re
        normalized = (text or "").lower().strip()
        if not normalized:
            return set()
        words = set(re.findall(r"[a-z0-9_./:-]+", normalized))
        cjk = re.findall(r"[\u4e00-\u9fff]", normalized)
        if cjk:
            words.update(cjk)
            words.update("".join(cjk[i:i + 2]) for i in range(len(cjk) - 1))
        if not words and normalized:
            compact = re.sub(r"\s+", "", normalized)
            words.update(compact[i:i + 3] for i in range(max(1, len(compact) - 2)))
        return {w for w in words if w}

    a_words = _tokens(a)
    b_words = _tokens(b)
    if not a_words or not b_words:
        return 0
    overlap = len(a_words & b_words)
    jaccard = overlap / len(a_words | b_words)
    containment = overlap / min(len(a_words), len(b_words))
    return max(jaccard, containment)

def _emit_event(ws_id: str, rec: MemoryRecord, event_type: str):
    if _event_hook is None:
        return
    try:
        _event_hook(ws_id, rec, event_type)
    except Exception:
        logging.getLogger("memory_governance.events").debug(
            "memory lifecycle event append failed", exc_info=True,
        )


def _rank_records(query: str, records: list[dict], limit: int) -> list[dict]:
    terms = _tokens(query)
    if not terms:
        return records[:limit]

    def score(record: dict) -> tuple[int, str]:
        text = " ".join(str(record.get(key, "")) for key in ("summary", "content", "memory_type"))
        record_terms = _tokens(text)
        return (len(terms & record_terms), str(record.get("updated_at") or record.get("created_at") or ""))

    ranked = sorted(records, key=score, reverse=True)
    return [record for record in ranked if score(record)[0] > 0][:limit]


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_./:-]+|[\u4e00-\u9fff]", str(text or "").lower()))


def is_auto_memory_enabled(workspace_id: str) -> bool:
    try:
        from storage.workspace_store import get_workspace_state

        return get_workspace_state(workspace_id).get("memory_enabled", True) is not False
    except Exception:
        logging.getLogger("memory_governance.settings").debug(
            "auto memory enabled lookup failed", exc_info=True,
        )
        return True
