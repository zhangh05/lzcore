"""Reconcile controlled file mutations while preserving referenced versions.

The caller holds workspace_files_lock across execution and settlement. This
adapter observes bytes, never interprets or replays the writer's command.
"""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import shutil
import uuid

from storage import index
from storage.paths import workspace_root
from storage.reference_index import list_references


class FileSettlementError(RuntimeError):
    """A writer may have committed; only read-back can establish the outcome."""


@contextmanager
def managed_file_mutation(workspace_id: str, *, paths: list[Path] | None = None,
                          scope: Path | None = None):
    root = workspace_root(workspace_id).resolve()
    refs = {r.get('file_id') for r in list_references(workspace_id)}
    snapshots = []
    result = []
    settled = False
    records = index.read_file_records(workspace_id)
    seen = set()
    try:
        for record in records:
            if record.get('lifecycle', 'active') != 'active':
                continue
            target = (root / record['path']).resolve()
            target.relative_to(root)
            if paths is not None and target not in paths:
                continue
            if scope is not None and not target.is_relative_to(scope.resolve()):
                continue
            if not target.is_file():
                continue
            if target in seen:
                raise ValueError('managed_file_index_ambiguous')
            seen.add(target)
            old_hash = _hash(target)
            snapshot = None
            if record['file_id'] in refs:
                snapshot = root / 'files/tmp' / f'mutation_{uuid.uuid4().hex}.tmp'
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, snapshot)
            snapshots.append((record, target, old_hash, snapshot))
        try:
            yield result
        finally:
            for record, target, old_hash, snapshot in snapshots:
                exists = target.is_file()
                digest = _hash(target) if exists else ''
                if exists and digest == old_hash:
                    # Also reconcile previously stale metadata for an unchanged
                    # unreferenced working file, without rewriting evidence.
                    if not snapshot and (record.get('sha256') != digest or record.get('size_bytes') != target.stat().st_size):
                        _update(workspace_id, record['file_id'], {'sha256': digest, 'size_bytes': target.stat().st_size})
                    continue
                if snapshot is not None:
                    version = root / 'files/data/.versions' / f"{record['file_id']}__{uuid.uuid4().hex[:12]}{target.suffix}"
                    version.parent.mkdir(parents=True, exist_ok=True)
                    snapshot.replace(version)
                    _update(workspace_id, record['file_id'], {
                        'path': version.relative_to(root).as_posix(), 'sha256': old_hash,
                        'size_bytes': version.stat().st_size,
                        'metadata': {**record.get('metadata', {}), 'historical_version': True},
                    })
                    if exists:
                        from storage.file_store import create_file_record
                        current = create_file_record(workspace_id, 'working_file', record['file_kind'],
                            target.relative_to(root).as_posix(), original_name=record.get('original_name', target.name),
                            binary=record.get('binary', False), mime_type=record.get('mime_type', ''),
                            source='workspace_mutation', sensitivity=record.get('sensitivity', 'internal'),
                            metadata={'previous_file_id': record['file_id']})
                        result.append({'file_id': current.file_id, 'previous_file_id': record['file_id'], 'filepath': current.path})
                elif exists:
                    _update(workspace_id, record['file_id'], {'sha256': digest, 'size_bytes': target.stat().st_size})
                    result.append({'file_id': record['file_id'], 'filepath': record['path']})
                else:
                    _update(workspace_id, record['file_id'], {'lifecycle': 'purged'})
                    result.append({'file_id': record['file_id'], 'lifecycle': 'purged'})
            if result:
                from storage.events import publish
                for item in result:
                    publish(workspace_id, 'file', 'updated', item['file_id'])
            settled = True
    except (OSError, RuntimeError) as exc:
        raise FileSettlementError('file mutation needs read-back; automatic replay is forbidden') from exc
    finally:
        for _, _, _, snapshot in snapshots:
            if snapshot is not None and settled:
                snapshot.unlink(missing_ok=True)


def _hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _update(workspace_id, file_id, changes):
    if not index.update_file_record(workspace_id, file_id, changes):
        raise FileSettlementError('managed file metadata settlement failed')
