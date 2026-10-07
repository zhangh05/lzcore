"""Observe governed writes and retain the actual bytes used by existing owners.

Callers hold workspace_files_lock. Pending intents support explicit metadata
read-back only; they never store or replay a writer command.
"""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import json
import shutil
import uuid
from storage import index
from storage.atomic_io import atomic_write_json
from storage.paths import workspace_root
from storage.reference_index import list_references


class FileSettlementError(RuntimeError):
    def __init__(self, message, *, intent='', executed=True):
        super().__init__(message)
        self.intent = intent
        self.executed = executed

    def as_result(self):
        return {'ok': False, 'error': str(self), 'error_code': 'EXECUTION_UNKNOWN' if self.executed else 'FILE_MUTATION_PREPARATION_FAILED',
                'intent': self.intent, 'executed': self.executed, 'automatic_retry_allowed': False}


@contextmanager
def managed_file_mutation(workspace_id: str, *, paths: list[Path] | None = None, scope: Path | None = None):
    root = workspace_root(workspace_id).resolve()
    referenced = {r.get('file_id') for r in list_references(workspace_id)}
    items, result = [], []
    intent = root / 'sys/file-mutations' / f'{uuid.uuid4().hex}.json'
    started = False
    try:
        seen = set()
        for record in index.read_file_records(workspace_id):
            if record.get('lifecycle', 'active') != 'active':
                continue
            target = (root / record['path']).resolve()
            target.relative_to(root)
            if paths is not None and target not in paths or scope is not None and not target.is_relative_to(scope.resolve()) or not target.is_file():
                continue
            if target in seen:
                raise ValueError('managed_file_index_ambiguous')
            seen.add(target)
            digest = _hash(target)
            version = ''
            if record['file_id'] in referenced:
                if digest != record['sha256']:
                    raise ValueError('referenced_payload_changed_requires_readback:' + record['file_id'])
                snapshot = root / 'files/data/.versions' / f"{record['file_id']}__{uuid.uuid4().hex[:12]}{target.suffix}"
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, snapshot)
                version = snapshot.relative_to(root).as_posix()
            items.append({'record': record, 'before_sha256': digest, 'version_path': version,
                          'current_file_id': 'file_' + uuid.uuid4().hex[:16] if version else record['file_id']})
        if items:
            atomic_write_json(intent, {'version': 1, 'workspace_id': workspace_id, 'items': items})
        started = True
        try:
            yield result
        finally:
            for item in items:
                result.extend(_settle(workspace_id, item))
            if result:
                from storage.events import publish
                for item in result:
                    publish(workspace_id, 'file', 'updated', item['file_id'])
            intent.unlink(missing_ok=True)
    except ValueError as exc:
        if not started:
            raise
        raise FileSettlementError(str(exc), intent=intent.relative_to(root).as_posix(), executed=True) from exc
    except (OSError, RuntimeError) as exc:
        raise FileSettlementError('file mutation requires read-back; writer replay is forbidden',
                                  intent=intent.relative_to(root).as_posix(), executed=started) from exc
    finally:
        if not started:
            for item in items:
                if item['version_path']:
                    (root / item['version_path']).unlink(missing_ok=True)


def _settle(workspace_id, item):
    from core.tools.path_security import safe_workspace_path
    from storage.file_store import create_file_record, get_file_record
    root = workspace_root(workspace_id).resolve()
    record = item['record']; fid = record['file_id']
    if record['workspace_id'] != workspace_id:
        raise ValueError('mutation_workspace_mismatch')
    target = safe_workspace_path(workspace_id, record['path'])
    version = safe_workspace_path(workspace_id, item['version_path']) if item['version_path'] else None
    exists = target.is_file(); digest = _hash(target) if exists else ''
    actual = get_file_record(workspace_id, fid)
    historical = {**record, 'path': item['version_path'], 'sha256': item['before_sha256'],
                  'metadata': {**record.get('metadata', {}), 'historical_version': True}}
    if version and version.exists():
        historical['size_bytes'] = version.stat().st_size
    if actual not in (record, historical):
        # Unreferenced settlement may already have completed before interruption.
        if version or not actual or actual.get('path') != record['path'] or (actual.get('sha256') != digest and not (not exists and actual.get('lifecycle') == 'purged')):
            raise ValueError('mutation_record_conflict')
    if exists and digest == item['before_sha256']:
        if actual == historical:
            raise ValueError('mutation_current_path_reverted_requires_review')
        if not version and (record['sha256'] != digest or record['size_bytes'] != target.stat().st_size):
            _update(workspace_id, fid, {'sha256': digest, 'size_bytes': target.stat().st_size})
        if version:
            version.unlink(missing_ok=True)
        return []
    if version:
        if not version.is_file() or _hash(version) != item['before_sha256']:
            raise ValueError('mutation_historical_bytes_unavailable')
        if actual != historical:
            _update(workspace_id, fid, {key: historical[key] for key in ('path', 'sha256', 'size_bytes', 'metadata')})
        if not exists:
            return [{'file_id': fid, 'filepath': historical['path'], 'current_path_removed': True}]
        current = get_file_record(workspace_id, item['current_file_id'])
        if current:
            if current['path'] != record['path'] or current['sha256'] != digest:
                raise ValueError('mutation_current_version_conflict')
        else:
            normalized = record.get('logical_type') == 'knowledge_normalized'
            current = create_file_record(workspace_id, 'knowledge_normalized' if normalized else 'working_file', record['file_kind'],
                record['path'], original_name=record.get('original_name', target.name), binary=record.get('binary', False),
                mime_type=record.get('mime_type', ''), source='workspace_mutation', sensitivity=record.get('sensitivity', 'internal'),
                metadata={**(record.get('metadata', {}) if normalized else {}), 'previous_file_id': fid}, file_id=item['current_file_id']).as_dict()
        return [{'file_id': current['file_id'], 'previous_file_id': fid, 'filepath': record['path']}]
    if exists:
        _update(workspace_id, fid, {'sha256': digest, 'size_bytes': target.stat().st_size})
        return [{'file_id': fid, 'filepath': record['path']}]
    _update(workspace_id, fid, {'lifecycle': 'purged'})
    return [{'file_id': fid, 'lifecycle': 'purged'}]


def reconcile_mutations(workspace_id, *, apply=False):
    from storage.project_changes import workspace_files_lock
    from core.tools.path_security import safe_workspace_path
    results = []
    with workspace_files_lock(workspace_id):
        for intent in (workspace_root(workspace_id) / 'sys/file-mutations').glob('*.json'):
            try:
                value = json.loads(intent.read_text(encoding='utf-8'))
                if value['version'] != 1 or value['workspace_id'] != workspace_id:
                    raise ValueError('mutation_intent_identity_mismatch')
                observed = []
                for item in value['items']:
                    record = item['record']
                    path = safe_workspace_path(workspace_id, record['path'])
                    observed.append({'file_id': record['file_id'], 'filepath': record['path'], 'exists': path.is_file(),
                                     'observed_sha256': _hash(path) if path.is_file() else ''})
                changes = []
                if apply:
                    for item in value['items']:
                        changes.extend(_settle(workspace_id, item))
                    intent.unlink()
                results.append({'intent': intent.name, 'state': 'observed_file_mutation', 'observed': observed,
                                'file_changes': changes, 'settled': apply, 'writer_outcome': 'not_inferred'})
            except (ValueError, OSError, KeyError, TypeError, RuntimeError) as exc:
                results.append({'intent': intent.name, 'state': 'unresolved', 'reason': str(exc)[:160]})
    return results


def _hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _update(workspace_id, file_id, changes):
    if not index.update_file_record(workspace_id, file_id, changes):
        raise FileSettlementError('managed file metadata settlement failed')
