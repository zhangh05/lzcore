"""Prepare real provider-compatible image evidence; preserve original files."""
import hashlib
import io
from storage.file_store import list_files, import_user_upload
from storage.project_changes import workspace_files_lock


def image_for_evidence(workspace_id, path, *, run_id='', session_id=''):
    from PIL import Image
    from storage.paths import workspace_root
    from storage.reference_index import add_reference
    canonical = path.relative_to(workspace_root(workspace_id).resolve()).as_posix()
    with workspace_files_lock(workspace_id):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        records = list_files(workspace_id)
        originals = [r for r in records if r.get('path') == canonical]
        if len(originals) > 1:
            raise ValueError('managed_file_index_ambiguous')
        with Image.open(path) as image:
            dimensions = [image.width, image.height]
            native = image.format in {'PNG', 'JPEG', 'GIF', 'WEBP'}
            if originals and native:
                return originals[0]['file_id'], dimensions
            cached = [r for r in records if r.get('metadata', {}).get('evidence_source_path') == canonical and r.get('metadata', {}).get('source_sha256') == digest]
            if cached:
                return cached[0]['file_id'], dimensions
            if native:
                raw, name = path.read_bytes(), path.name
            else:
                stream = io.BytesIO(); image.convert('RGBA').save(stream, format='PNG')
                raw, name = stream.getvalue(), path.stem + '.png'
        record = import_user_upload(workspace_id, io.BytesIO(raw), name, source='image_evidence', logical_type='tmp',
            run_id=run_id, session_id=session_id, metadata={'evidence_source_path': canonical, 'source_sha256': digest})
        if originals:
            add_reference(workspace_id, record.file_id, 'file', originals[0]['file_id'], 'visual_derivative')
        return record.file_id, dimensions
