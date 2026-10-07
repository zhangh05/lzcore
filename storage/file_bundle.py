"""File-domain backup: payloads, identities and their actual owner evidence."""
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from storage.paths import workspace_root
from storage.project_changes import workspace_files_lock
from storage.principal import current_storage_principal, principal_storage_key
from storage.file_store import list_files
from storage.reference_index import list_references
from storage.artifact_metadata_store import list_artifact_records
from core.tools.path_security import safe_workspace_path


def _identity():
    principal = current_storage_principal()
    return principal_storage_key(principal) if principal else ''


def export_bundle(workspace_id, *, output=None):
    from core.context.context_store import get_context_store
    with workspace_files_lock(workspace_id):
        root = workspace_root(workspace_id)
        records = list_files(workspace_id, lifecycle='')
        references = list_references(workspace_id)
        owners = {}
        sessions = {r.get('metadata', {}).get('session_id') for r in references if r.get('owner_type') in {'message', 'session'}}
        sessions.update(r.get('session_id') for r in records)
        sessions.update(r.get('owner_id') for r in references if r.get('owner_type') == 'session')
        for sid in sessions - {None, ''}:
            from storage.ids import validate_session_id
            validate_session_id(sid)
            for path in [root / f'sessions/{sid}.json', *(root / f'sessions/{sid}/messages').glob('*.json')]:
                if path.is_file():
                    owners[path.relative_to(root).as_posix()] = path.read_text(encoding='utf-8')
        context = get_context_store(workspace_id)
        knowledge = [*context.list_items(item_type='knowledge_source', limit=1_000_000), *context.list_items(item_type='knowledge_chunk', limit=1_000_000)]
        manifest = {'version': 1, 'workspace_id': workspace_id, 'principal_id': _identity(), 'files': records,
                    'references': references, 'artifacts': list_artifact_records(workspace_id), 'owners': owners,
                    'knowledge': knowledge, 'unavailable_payloads': [], 'scope': 'files_and_owner_evidence'}
        owns_output = output is None
        output = io.BytesIO() if owns_output else output
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for record in records:
                lifecycle = record.get('lifecycle', 'active')
                relative = (record.get('metadata') or {}).get('trash_path') if lifecycle == 'soft_deleted' else record['path']
                path = safe_workspace_path(workspace_id, relative or record['path'])
                if lifecycle in {'purged', 'deleted'} or not path.is_file():
                    manifest['unavailable_payloads'].append(record['file_id']); continue
                with path.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if digest != record['sha256'] or path.stat().st_size != record['size_bytes']:
                    raise ValueError('backup_payload_hash_mismatch:' + record['file_id'])
                archive.write(path, 'payload/' + record['file_id'])
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
        return output.getvalue() if owns_output else None


def restore_bundle(workspace_id, raw, *, preview=True):
    from storage.schemas import FileRecord, FileReference
    from storage.ids import validate_session_id
    def identifier(value, prefix):
        if not re.fullmatch(prefix + r"_[A-Za-z0-9_-]{1,64}", str(value)):
            raise ValueError("backup_identity_invalid")
        return value
    from storage.atomic_io import atomic_write_stream, atomic_write_json
    from storage.records import mutate_jsonl
    from storage.workspace_files import is_current_workspace_write_path
    from core.context.context_store import get_context_store
    source = io.BytesIO(raw) if isinstance(raw, bytes) else raw
    source.seek(0)
    bundle_digest = hashlib.file_digest(source, 'sha256').hexdigest()
    source.seek(0)
    with workspace_files_lock(workspace_id), zipfile.ZipFile(source) as archive:
        entries = archive.namelist()
        if len(entries) != len(set(entries)):
            raise ValueError('backup_duplicate_entries')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('version') != 1 or manifest.get('workspace_id') != workspace_id or manifest.get('principal_id') != _identity():
            raise ValueError('backup_scope_or_version_mismatch')
        root = workspace_root(workspace_id)
        current = {r['file_id']: r for r in list_files(workspace_id, lifecycle='')}
        existing_artifacts = {r['artifact_id']: r for r in list_artifact_records(workspace_id)}
        prepared, conflicts = [], []
        for record in manifest['files']:
            FileRecord(**record); identifier(record['file_id'], 'file')
            if record['workspace_id'] != workspace_id:
                raise ValueError('backup_file_workspace_mismatch')
            target = safe_workspace_path(workspace_id, record['path'])
            if not is_current_workspace_write_path(workspace_id, target):
                raise ValueError('backup_payload_outside_managed_storage')
            relative = (record.get('metadata') or {}).get('trash_path') if record.get('lifecycle') == 'soft_deleted' else record['path']
            target = safe_workspace_path(workspace_id, relative or record['path'])
            if not is_current_workspace_write_path(workspace_id, target) and not target.is_relative_to(root.resolve() / '.trash'):
                raise ValueError('backup_trash_outside_storage')
            entry = 'payload/' + record['file_id']
            payload = entry if entry in entries else None
            if payload is None and record['file_id'] not in manifest.get('unavailable_payloads', []):
                raise ValueError('backup_payload_missing')
            if payload is not None:
                if archive.getinfo(entry).file_size != record['size_bytes']:
                    raise ValueError('backup_payload_size_mismatch')
                with archive.open(entry) as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if digest != record['sha256']:
                    raise ValueError('backup_payload_hash_mismatch')
            if record['file_id'] in current and current[record['file_id']] != record:
                conflicts.append({'file_id': record['file_id'], 'kind': 'record_conflict'})
            if target.exists() and payload is not None:
                with target.open('rb') as stream:
                    current_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if current_digest != record['sha256']:
                    conflicts.append({'file_id': record['file_id'], 'kind': 'path_conflict'})
            prepared.append((record, target, payload))
        ids = {r['file_id'] for r, _, _ in prepared}
        if len(ids) != len(prepared) or len({str(p) for _, p, entry in prepared if entry}) != sum(bool(entry) for _, _, entry in prepared):
            raise ValueError('backup_duplicate_file_identity_or_path')
        reference_key = lambda r: (r['file_id'], r['owner_type'], r['owner_id'], r['relation'])
        current_refs = {reference_key(r): r for r in list_references(workspace_id)}
        ref_ids = {r['ref_id']: reference_key(r) for r in current_refs.values()}
        seen_refs = set()
        for ref in manifest['references']:
            FileReference(**ref)
            key = reference_key(ref)
            if key in seen_refs or ref['ref_id'] in ref_ids and ref_ids[ref['ref_id']] != key:
                raise ValueError('backup_reference_identity_conflict')
            seen_refs.add(key)
            if ref['workspace_id'] != workspace_id or ref['file_id'] not in ids:
                raise ValueError('backup_reference_target_missing')
        for artifact in manifest['artifacts']:
            aid = identifier(artifact['artifact_id'], 'art')
            if artifact.get('workspace_id') != workspace_id or artifact.get('file_id') and artifact['file_id'] not in ids:
                raise ValueError('backup_artifact_scope_mismatch')
            if aid in existing_artifacts and existing_artifacts[aid] != artifact:
                conflicts.append({'artifact_id': aid, 'kind': 'artifact_conflict'})
        owners = []
        for relative, value in manifest.get('owners', {}).items():
            parts = Path(relative).parts
            document = json.loads(value)
            if len(parts) == 2 and parts[0] == 'sessions' and parts[1].endswith('.json'):
                sid = validate_session_id(Path(parts[1]).stem)
            elif len(parts) == 4 and parts[0] == 'sessions' and parts[2] == 'messages' and parts[3].endswith('.json'):
                sid = validate_session_id(parts[1])
            else:
                raise ValueError('backup_owner_path_invalid')
            if document.get('session_id') != sid:
                raise ValueError('backup_owner_identity_mismatch')
            target = safe_workspace_path(workspace_id, relative)
            if target.exists() and json.loads(target.read_text(encoding='utf-8')) != document:
                conflicts.append({'path': relative, 'kind': 'owner_conflict'})
            owners.append((target, document))
        context = get_context_store(workspace_id)
        for item in manifest.get('knowledge', []):
            if item.get('item_type') not in {'knowledge_source', 'knowledge_chunk'} or item.get('workspace_id', workspace_id) != workspace_id:
                raise ValueError('backup_knowledge_scope_mismatch')
            previous = context.get(item['item_id'])
            if previous and previous != item:
                conflicts.append({'owner_id': item['item_id'], 'kind': 'knowledge_conflict'})
        result = {'preview': preview, 'conflicts': conflicts, 'files': len(prepared), 'references': len(manifest['references']),
                  'unavailable_payloads': manifest.get('unavailable_payloads', []), 'scope': 'files_and_owner_evidence'}
        if preview or conflicts:
            return {'ok': not conflicts, **result}
        intent = root / 'sys/file-restore.intent.json'
        atomic_write_json(intent, {'version': 1, 'bundle_sha256': bundle_digest, 'manifest': manifest})
        for record, target, payload in prepared:
            if payload is not None and not target.exists():
                with archive.open(payload) as stream:
                    atomic_write_stream(target, stream)
        def merge(key, additions):
            def update(rows):
                known = {r[key] for r in rows}
                return rows + [r for r in additions if r[key] not in known], None
            return update
        mutate_jsonl(workspace_id, ('index', 'files.jsonl'), merge('file_id', manifest['files']))
        from storage.artifact_metadata_store import upsert_artifact_record
        for artifact in manifest['artifacts']:
            if artifact['artifact_id'] not in existing_artifacts:
                upsert_artifact_record(workspace_id, artifact, add_to_index=True, settle_references=False)
        for target, document in owners:
            if not target.exists():
                atomic_write_json(target, document)
        for item in manifest.get('knowledge', []):
            if not context.get(item['item_id']):
                context.put(item)
        def merge_refs(additions):
            def update(rows):
                known = {reference_key(r) for r in rows}
                return rows + [r for r in additions if reference_key(r) not in known], None
            return update
        mutate_jsonl(workspace_id, ('index', 'references.jsonl'), merge_refs(manifest['references']))
        intent.unlink()
        from storage.events import publish
        publish(workspace_id, 'file', 'restored_bundle', '')
        return {'ok': True, **result, 'restored': True}
