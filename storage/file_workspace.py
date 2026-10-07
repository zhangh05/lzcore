"""Shared user/agent file discovery, resolution and working-material contracts."""
from pathlib import Path, PurePosixPath
import base64
import json
import shutil

from storage.paths import workspace_root
from storage.file_store import get_file_record, resolve_file_path, import_user_upload
from storage.file_types import classify_file, file_capabilities
from storage.data_management import managed_data_files
from storage.project_changes import workspace_files_lock


def location(value: str) -> str:
    path = PurePosixPath(str(value or ''))
    if path.is_absolute() or '..' in path.parts or '\\' in str(value) or '\x00' in str(value):
        raise ValueError('invalid_file_location')
    return '' if str(path) == '.' else path.as_posix()


def matches_view(row, *, view='files', folder=None):
    meta = row.get('metadata') or {}
    evidence = row.get('source') in {'runtime_tool_evidence', 'image_evidence', 'document_page_render', 'document_image_extract'} or row.get('logical_type') in {'knowledge_normalized', 'message_large_content'} or any(a.get('artifact_type') == 'tool_evidence' for a in row['artifacts'])
    history = bool(meta.get('historical_version'))
    if view == 'files' and (evidence or history):
        return False
    if view == 'evidence' and not evidence or view == 'history' and not history:
        return False
    if view == 'deliverables' and (evidence or history or not row['artifacts'] or row.get('logical_type') not in {'artifact_output', 'report', 'working_file'}):
        return False
    if folder is not None and location(str(meta.get('folder') or '')) != location(folder):
        return False
    return True


def files_page(workspace_id: str, *, query='', lifecycle='active', folder=None,
               view='files', limit=100, cursor='', logical_type='', sort='created') -> dict:
    if sort not in {'created', 'name', 'size'} or not 1 <= int(limit) <= 200 or view not in {'files', 'all', 'evidence', 'history', 'deliverables'}:
        raise ValueError('invalid_file_query')
    rows = managed_data_files(workspace_id, lifecycle=lifecycle, logical_type=logical_type)
    selected = []
    folders = sorted({str((r.get('metadata') or {}).get('folder') or '') for r in rows})
    key = lambda row: (str(row['size_bytes']).zfill(20) if sort == 'size' else row['original_name'].casefold() if sort == 'name' else row['created_at'], row['file_id'])
    reverse = sort != 'name'
    for row in rows:
        if not matches_view(row, view=view, folder=folder):
            continue
        meta = row.get('metadata') or {}
        if query and str(query).casefold() not in (str(meta.get('folder') or '') + ' ' + ' '.join(str(row.get(k) or '') for k in ('original_name', 'file_id', 'path', 'source', 'run_id'))).casefold():
            continue
        row['reference'] = {'kind': 'managed_file', 'file_id': row['file_id']}
        selected.append(row)
    selected.sort(key=key, reverse=reverse)
    total = len(selected)
    import hashlib
    scope = hashlib.sha256(json.dumps([str(workspace_root(workspace_id)), query, lifecycle, folder, view, logical_type, sort]).encode()).hexdigest()
    if cursor:
        try:
            decoded = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if not isinstance(decoded, dict) or decoded.get('scope') != scope:
                raise ValueError()
            boundary = decoded.get('key')
            if not isinstance(boundary, list) or len(boundary) != 2 or not all(isinstance(v, str) for v in boundary):
                raise ValueError()
        except (ValueError, UnicodeError, TypeError) as exc:
            raise ValueError('invalid_file_cursor') from exc
        selected = [r for r in selected if (key(r) < tuple(boundary) if reverse else key(r) > tuple(boundary))]
    page = selected[:int(limit)]
    more = len(selected) > len(page)
    next_cursor = base64.urlsafe_b64encode(json.dumps({'scope': scope, 'key': list(key(page[-1]))}).encode()).decode() if more and page else ''
    return {'files': page, 'count': len(page), 'total': total, 'next_cursor': next_cursor,
            'folders': folders, 'sort': sort, 'path_basis': 'workspace_root', 'workspace_id': workspace_id}


def resolve_reference(workspace_id: str, *, file_id='', artifact_id='', filepath='') -> dict:
    if sum(bool(value) for value in (file_id, artifact_id, filepath)) != 1:
        raise ValueError('exactly_one_file_reference_required')
    if artifact_id:
        from artifacts.store import get_artifact
        artifact = get_artifact(workspace_id, artifact_id)
        if not artifact or artifact.lifecycle in {'deleted', 'quarantined'}:
            raise ValueError('artifact_unavailable')
        if artifact.sensitivity == 'secret':
            raise ValueError('secret_artifact_not_readable')
        file_id = artifact.file_id
        if not file_id:
            raise ValueError('artifact_has_no_managed_payload')
    if file_id:
        record = get_file_record(workspace_id, file_id)
        if not record:
            raise ValueError('file_not_found')
        return {**record, 'reference': {'kind': 'managed_file', 'file_id': file_id},
                'artifact_id': artifact_id, 'capabilities': file_capabilities(record), 'path_basis': 'workspace_root'}
    from core.tools.path_security import safe_workspace_path
    path = safe_workspace_path(workspace_id, filepath)
    if not path.is_file():
        raise ValueError('file_not_found')
    normalized = path.relative_to(workspace_root(workspace_id).resolve()).as_posix()
    classification = classify_file(path.name)
    return {'reference': {'kind': 'workspace_path', 'filepath': normalized}, 'path': normalized,
            'original_name': path.name, 'size_bytes': path.stat().st_size, 'lifecycle': 'active',
            **classification, 'capabilities': file_capabilities(classification), 'path_basis': 'workspace_root'}


def organize_file(workspace_id: str, file_id: str, *, name=None, folder=None) -> dict:
    from storage import index
    with workspace_files_lock(workspace_id):
        record = get_file_record(workspace_id, file_id)
        if not record or record.get('lifecycle', 'active') != 'active':
            raise ValueError('file_unavailable')
        updates = {}
        if name is not None:
            if not isinstance(name, str) or not name.strip() or '/' in name or '\\' in name or '\x00' in name:
                raise ValueError('invalid_file_name')
            updates['original_name'] = name.strip()
        if folder is not None:
            updates['metadata'] = {**record.get('metadata', {}), 'folder': location(folder)}
        if not index.update_file_record(workspace_id, file_id, updates):
            raise RuntimeError('file_metadata_commit_failed')
        from storage.events import publish
        publish(workspace_id, 'file', 'updated', file_id)
        return resolve_reference(workspace_id, file_id=file_id)


def working_material(workspace_id: str, *, file_id='', artifact_id='', filepath='', destination: str) -> dict:
    from core.tools.path_security import safe_workspace_path
    from storage.workspace_files import is_current_workspace_write_path
    with workspace_files_lock(workspace_id):
        record = resolve_reference(workspace_id, file_id=file_id, artifact_id=artifact_id, filepath=filepath)
        if record.get('lifecycle') != 'active':
            raise ValueError('file_unavailable')
        source = resolve_file_path(workspace_id, record['file_id']) if record.get('file_id') else safe_workspace_path(workspace_id, record['path'])
        target = safe_workspace_path(workspace_id, destination)
        if not is_current_workspace_write_path(workspace_id, target):
            raise ValueError('working_material_outside_managed_directories')
        from core.tools.project_execution import environment_for
        environment = environment_for(workspace_id)
        if environment is not None and (not target.is_relative_to(environment.project) or environment.source_protected(target)):
            raise ValueError('working_material_outside_writable_project')
        target.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents materialization from overwriting a source.
        with source.open('rb') as src, target.open('xb') as out:
            shutil.copyfileobj(src, out)
        relative = target.relative_to(workspace_root(workspace_id).resolve()).as_posix()
        execution_path = '/workspace/' + relative if environment is not None else relative
        return {'reference': record['reference'], 'filepath': relative, 'path_basis': 'workspace_root',
                'execution_path': execution_path, 'execution_path_basis': 'container' if environment is not None else 'workspace_root',
                'size_bytes': target.stat().st_size, 'original_preserved': True}


def publish_file(workspace_id: str, filepath: str, *, title='', run_id='', session_id='',
                 source_file_ids=None, artifact_type='agent_file') -> dict:
    from core.tools.path_security import safe_workspace_path
    from storage.workspace_files import is_current_workspace_write_path
    from storage.artifact_metadata_store import create_artifact_metadata
    with workspace_files_lock(workspace_id):
        source = safe_workspace_path(workspace_id, filepath)
        if not source.is_file() or not is_current_workspace_write_path(workspace_id, source):
            raise ValueError('publish_source_outside_managed_files')
        from core.tools.project_execution import environment_for
        environment = environment_for(workspace_id)
        if environment is not None and not source.is_relative_to(environment.project):
            raise ValueError('publish_source_outside_assigned_project')
        inputs = [resolve_reference(workspace_id, file_id=fid) for fid in (source_file_ids or [])]
        levels = {'public': 0, 'internal': 1, 'confidential': 2, 'sensitive': 2, 'restricted': 3, 'secret': 3}
        sensitivity = max((r.get('sensitivity', 'internal') for r in inputs), key=lambda v: levels.get(v, 1), default='internal')
        artifact_sensitivity = {'confidential': 'sensitive', 'restricted': 'secret'}.get(sensitivity, sensitivity)
        classification = classify_file(source.name)
        if not classification['binary']:
            from artifacts.store import save_artifact
            artifact = save_artifact(workspace_id=workspace_id, content=source.read_text(encoding='utf-8'),
                title=title or source.name, artifact_type=artifact_type, run_id=run_id,
                source='workspace_publish', sensitivity=artifact_sensitivity,
                metadata={'source_file_ids': [r['file_id'] for r in inputs], 'session_id': session_id})
            if artifact is None:
                raise ValueError('artifact_publication_blocked')
            result = resolve_reference(workspace_id, file_id=artifact.file_id)
            aid = artifact.artifact_id
        else:
            record = import_user_upload(workspace_id, source, source.name, logical_type='artifact_output',
                source='workspace_publish', run_id=run_id, session_id=session_id, sensitivity=sensitivity,
                metadata={'source_file_ids': [r['file_id'] for r in inputs], 'title': title or source.name})
            artifact = create_artifact_metadata(workspace_id=workspace_id, file_record=record,
                title=title or source.name, artifact_type=artifact_type, run_id=run_id, session_id=session_id,
                source='workspace_publish', sensitivity=artifact_sensitivity,
                metadata={'source_file_ids': [r['file_id'] for r in inputs]})
            aid = artifact['artifact_id']
            result = resolve_reference(workspace_id, file_id=record.file_id)
        from storage.events import publish
        publish(workspace_id, 'artifact', 'created', aid)
        return {**result, 'artifact_id': aid, 'artifact_ids': [aid], 'filepath': result['path'],
                'download_url': f'/api/storage/files/{result["file_id"]}/download?workspace_id={workspace_id}'}
