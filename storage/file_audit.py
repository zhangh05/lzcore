"""Explicit consistency audit and evidence-derived, idempotent reference repair."""
import hashlib
import json
import time
import uuid
from pathlib import Path
from storage.paths import workspace_root
from storage.file_store import list_files
from storage.reference_index import list_references
from storage.artifact_metadata_store import list_artifact_records
from storage.project_changes import workspace_files_lock


def owner_facts(workspace_id):
    root = workspace_root(workspace_id)
    expected, owners, unresolved = {}, {'artifact': set(), 'message': set(), 'knowledge_source': set()}, []
    def expect(fid, owner_type, owner_id, relation, metadata=None):
        if fid:
            expected[(fid, owner_type, owner_id, relation)] = {'file_id': fid, 'owner_type': owner_type, 'owner_id': owner_id, 'relation': relation, 'metadata': metadata or {}}
    for artifact in list_artifact_records(workspace_id):
        if artifact.get('lifecycle') == 'deleted':
            continue
        aid = artifact['artifact_id']; owners['artifact'].add(aid)
        expect(artifact.get('file_id'), 'artifact', aid, 'content')
        for fid in [*artifact.get('metadata', {}).get('source_file_ids', []), artifact.get('metadata', {}).get('source_file_id')]:
            expect(fid, 'artifact', aid, 'source')
    for path in (root / 'sessions').glob('*/messages/*.json'):
        try:
            message = json.loads(path.read_text(encoding='utf-8'))
            sid, rid, role = message['session_id'], message['run_id'], message['role']
            if sid != path.parent.parent.name or role not in {'user', 'assistant'}:
                raise ValueError('message_identity_mismatch')
            oid = f'{sid}/{rid}:{role}'; owners['message'].add(oid)
            meta = message.get('metadata') or {}
            for attachment in list(meta.get('attachments') or []) + list((meta.get('history_state') or {}).get('attachments') or []):
                if isinstance(attachment, dict):
                    expect(attachment.get('file_id'), 'message', oid, 'attachment', {'session_id': sid, 'run_id': rid})
            expect((message.get('artifact_ref') or {}).get('file_id'), 'message', oid, 'content', {'session_id': sid, 'run_id': rid})
        except (OSError, ValueError, KeyError, TypeError) as exc:
            unresolved.append({'path': path.relative_to(root).as_posix(), 'reason': str(exc)[:160]})
    from core.context.context_store import get_context_store
    for source in get_context_store(workspace_id).list_items(item_type='knowledge_source', limit=1_000_000):
        oid = source['item_id']; owners['knowledge_source'].add(oid)
        meta = source.get('metadata') or {}
        expect(meta.get('source_file_id'), 'knowledge_source', oid, 'source')
        expect(meta.get('normalized_file_id'), 'knowledge_source', oid, 'normalized')
        if not meta.get('source_file_id'):
            unresolved.append({'owner_type': 'knowledge_source', 'owner_id': oid, 'reason': 'original_file_identity_unavailable'})
    return expected, owners, unresolved


def file_health(workspace_id, *, hashes=False):
    started = time.perf_counter()
    with workspace_files_lock(workspace_id):
        records = {r['file_id']: r for r in list_files(workspace_id, lifecycle='')}
        references = list_references(workspace_id)
        expected, owners, unresolved = owner_facts(workspace_id)
        issues = []
        root = workspace_root(workspace_id)
        for fid, record in records.items():
            lifecycle = record.get('lifecycle', 'active')
            if lifecycle in {'purged', 'deleted'}:
                continue
            relative = (record.get('metadata') or {}).get('trash_path') if lifecycle == 'soft_deleted' else record.get('path')
            from core.tools.path_security import safe_workspace_path
            try:
                path = safe_workspace_path(workspace_id, relative or record['path'])
                if not path.is_file():
                    issues.append({'file_id': fid, 'kind': 'payload_missing'}); continue
                if path.stat().st_size != record['size_bytes']:
                    issues.append({'file_id': fid, 'kind': 'size_mismatch'})
                if hashes:
                    with path.open('rb') as stream:
                        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    if digest != record['sha256']:
                        issues.append({'file_id': fid, 'kind': 'hash_mismatch'})
            except (ValueError, OSError) as exc:
                issues.append({'file_id': fid, 'kind': 'payload_check_failed', 'reason': str(exc)[:160]})
        keys = set()
        unchecked = set()
        for ref in references:
            key = (ref['file_id'], ref['owner_type'], ref['owner_id'], ref['relation'])
            if key in keys:
                issues.append({'ref_id': ref['ref_id'], 'kind': 'duplicate_reference'})
            keys.add(key)
            if ref['file_id'] not in records:
                issues.append({'ref_id': ref['ref_id'], 'kind': 'reference_file_missing'})
            if ref['owner_type'] in owners and ref['owner_id'] not in owners[ref['owner_type']]:
                issues.append({'ref_id': ref['ref_id'], 'kind': 'reference_owner_missing'})
            elif ref['owner_type'] not in owners:
                unchecked.add(ref['owner_type'])
        missing = [value for key, value in expected.items() if key not in keys]
        issues.extend({'kind': 'owner_reference_missing', **value} for value in missing)
        for directory in ('file-commits', 'artifact-commits', 'file-mutations'):
            issues.extend({'kind': 'pending_commit', 'intent': f'sys/{directory}/{path.name}'} for path in (root / 'sys' / directory).glob('*.json'))
        if (root / 'sys/file-restore.intent.json').exists():
            issues.append({'kind': 'pending_restore', 'intent': 'sys/file-restore.intent.json'})
        return {'ok': not issues, 'issues': issues, 'unresolved': unresolved,
                'checked': {'payload_existence': True, 'size': True, 'hashes': hashes, 'reference_targets': True,
                            'owner_types': sorted(owners), 'unchecked_owner_types': sorted(unchecked)},
                'file_count': len(records), 'reference_count': len(references), 'elapsed_ms': round((time.perf_counter() - started) * 1000, 2)}


def migrate_references(workspace_id, *, apply=False):
    from storage.atomic_io import atomic_write_json, atomic_write_bytes
    from storage.records import mutate_jsonl
    from storage.file_types import classify_file
    with workspace_files_lock(workspace_id):
        records = {r['file_id']: r for r in list_files(workspace_id, lifecycle='')}
        references = list_references(workspace_id)
        expected, _, unresolved = owner_facts(workspace_id)
        keys = {(r['file_id'], r['owner_type'], r['owner_id'], r['relation']) for r in references}
        additions = [ref for key, ref in expected.items() if key not in keys and ref['file_id'] in records]
        unresolved.extend({'reason': 'owner_file_missing', **ref} for ref in expected.values() if ref['file_id'] not in records)
        groups = {}
        classifications = []
        for record in records.values():
            groups.setdefault(record.get('sha256'), []).append(record['file_id'])
            actual = classify_file(record.get('original_name') or record['path'])
            if any(record.get(k) != actual[k] for k in actual):
                classifications.append({'file_id': record['file_id'], 'suggested': actual, 'applied': False})
        report = {'version': 1, 'applied': apply, 'additions': additions, 'unresolved': unresolved,
                  'classification_review': classifications, 'same_hash_groups': [fids for digest, fids in groups.items() if digest and len(fids) > 1],
                  'payloads_rewritten': False, 'references_removed': False}
        if apply and additions:
            root = workspace_root(workspace_id)
            backup = root / 'sys/file-migrations' / uuid.uuid4().hex
            path = root / 'index/references.jsonl'
            atomic_write_bytes(backup / 'references.before.jsonl', path.read_bytes() if path.exists() else b'')
            atomic_write_json(backup / 'manifest.json', report)
            def update(rows):
                existing = {(r['file_id'], r['owner_type'], r['owner_id'], r['relation']) for r in rows}
                from datetime import datetime, timezone
                for ref in additions:
                    key = (ref['file_id'], ref['owner_type'], ref['owner_id'], ref['relation'])
                    if key not in existing:
                        rows.append({**ref, 'ref_id': 'ref_' + uuid.uuid4().hex[:12], 'workspace_id': workspace_id,
                                     'created_at': datetime.now(timezone.utc).isoformat()})
                return rows, None
            mutate_jsonl(workspace_id, ('index', 'references.jsonl'), update)
            report['backup'] = backup.relative_to(root).as_posix()
            atomic_write_json(backup / 'result.json', report)
        return report


def reconcile_file_commits(workspace_id, *, apply=False):
    """Settle verified metadata only. Never copy or regenerate a payload."""
    from storage import index
    from storage.schemas import FileRecord
    from core.tools.path_security import safe_workspace_path
    results = []
    with workspace_files_lock(workspace_id):
        known = {r['file_id']: r for r in list_files(workspace_id, lifecycle='')}
        for intent in (workspace_root(workspace_id) / 'sys/file-commits').glob('*.json'):
            try:
                value = json.loads(intent.read_text(encoding='utf-8'))
                record = FileRecord(**value['record'])
                if value['version'] != 1 or record.workspace_id != workspace_id or intent.stem != record.file_id:
                    raise ValueError('commit_identity_mismatch')
                path = safe_workspace_path(workspace_id, record.path)
                with path.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if digest != record.sha256 or path.stat().st_size != record.size_bytes:
                    raise ValueError('commit_payload_mismatch')
                if record.file_id in known and known[record.file_id] != record.as_dict():
                    raise ValueError('commit_record_conflict')
                state = 'already_indexed' if record.file_id in known else 'verified_payload_unindexed'
                if apply:
                    if record.file_id not in known:
                        index.append_file_record(workspace_id, record)
                        known[record.file_id] = record.as_dict()
                    intent.unlink()
                results.append({'file_id': record.file_id, 'filepath': record.path, 'state': state, 'settled': apply})
            except (ValueError, OSError, KeyError, TypeError) as exc:
                results.append({'intent': intent.name, 'state': 'unresolved', 'reason': str(exc)[:160]})
        from storage.artifact_metadata_store import upsert_artifact_record
        artifacts = {r['artifact_id']: r for r in list_artifact_records(workspace_id)}
        for intent in (workspace_root(workspace_id) / 'sys/artifact-commits').glob('*.json'):
            try:
                value = json.loads(intent.read_text(encoding='utf-8'))
                record = value['record']
                aid = record['artifact_id']
                payload = known.get(record['file_id'])
                if value['version'] != 1 or record['workspace_id'] != workspace_id or aid != intent.stem or not payload:
                    raise ValueError('artifact_commit_identity_mismatch')
                path = safe_workspace_path(workspace_id, payload['path'])
                with path.open('rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if digest != record['sha256'] or digest != payload['sha256'] or path.stat().st_size != record['size_bytes']:
                    raise ValueError('artifact_commit_payload_mismatch')
                if aid in artifacts and artifacts[aid] != record:
                    raise ValueError('artifact_commit_record_conflict')
                if apply:
                    upsert_artifact_record(workspace_id, record, add_to_index=True,
                                           settle_references=value.get('settle_references', True))
                    artifacts[aid] = record
                results.append({'artifact_id': aid, 'file_id': payload['file_id'], 'state': 'verified_artifact_commit', 'settled': apply})
            except (ValueError, OSError, KeyError, TypeError) as exc:
                results.append({'intent': intent.name, 'state': 'unresolved', 'reason': str(exc)[:160]})
        from storage.file_mutations import reconcile_mutations
        results.extend(reconcile_mutations(workspace_id, apply=apply))
        restore_intent = workspace_root(workspace_id) / 'sys/file-restore.intent.json'
        if restore_intent.exists():
            try:
                manifest = json.loads(restore_intent.read_text(encoding='utf-8'))['manifest']
                from storage.principal import current_storage_principal, principal_storage_key
                principal = current_storage_principal()
                if manifest['workspace_id'] != workspace_id or manifest['principal_id'] != (principal_storage_key(principal) if principal else ''):
                    raise ValueError('restore_intent_scope_mismatch')
                actual = {r['file_id']: r for r in list_files(workspace_id, lifecycle='')}
                actual_refs = {(r['file_id'], r['owner_type'], r['owner_id'], r['relation']) for r in list_references(workspace_id)}
                from core.context.context_store import get_context_store
                context = get_context_store(workspace_id)
                for record in manifest['files']:
                    if actual.get(record['file_id']) != record:
                        raise ValueError('restore_file_metadata_unsettled:' + record['file_id'])
                    if record['file_id'] not in manifest.get('unavailable_payloads', []):
                        relative = record.get('metadata', {}).get('trash_path') if record.get('lifecycle') == 'soft_deleted' else record['path']
                        with safe_workspace_path(workspace_id, relative).open('rb') as stream:
                            if hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
                                raise ValueError('restore_payload_mismatch:' + record['file_id'])
                for record in manifest['artifacts']:
                    if artifacts.get(record['artifact_id']) != record:
                        raise ValueError('restore_artifact_unsettled:' + record['artifact_id'])
                for ref in manifest['references']:
                    if (ref['file_id'], ref['owner_type'], ref['owner_id'], ref['relation']) not in actual_refs:
                        raise ValueError('restore_reference_unsettled:' + ref['ref_id'])
                for relative, value in manifest.get('owners', {}).items():
                    if json.loads(safe_workspace_path(workspace_id, relative).read_text(encoding='utf-8')) != json.loads(value):
                        raise ValueError('restore_owner_unsettled:' + relative)
                for item in manifest.get('knowledge', []):
                    if context.get(item['item_id']) != item:
                        raise ValueError('restore_knowledge_unsettled:' + item['item_id'])
                if apply:
                    restore_intent.unlink()
                results.append({'intent': restore_intent.name, 'state': 'verified_restored_bundle', 'settled': apply})
            except (ValueError, OSError, KeyError, TypeError) as exc:
                results.append({'intent': restore_intent.name, 'state': 'unresolved', 'reason': str(exc)[:160]})
    return {'applied': apply, 'results': results, 'payload_writes': 0, 'automatic_replay': False}
