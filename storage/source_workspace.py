"""Real source paths remain paths; organization never invents managed identities."""
from pathlib import Path, PurePosixPath
import shutil
import zipfile
import tarfile
from storage.paths import workspace_root
from storage.project_changes import workspace_files_lock, IGNORED
from storage.workspace_files import is_current_workspace_write_path
from core.tools.path_security import safe_workspace_path


def writable_path(workspace_id, relative):
    lexical = workspace_root(workspace_id)
    for part in PurePosixPath(relative).parts:
        lexical = lexical / part
        if lexical.is_symlink():
            raise ValueError('source_mutation_through_symlink_forbidden')
    target = safe_workspace_path(workspace_id, relative)
    if not is_current_workspace_write_path(workspace_id, target):
        raise ValueError('source_outside_managed_directories')
    from core.tools.project_execution import environment_for
    environment = environment_for(workspace_id)
    if environment is not None and (not target.is_relative_to(environment.project) or environment.source_protected(target)):
        raise ValueError('source_outside_writable_project')
    return target


def source_entries(workspace_id, filepath='files/data', *, offset=0, limit=100):
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError('invalid_source_range')
    root = workspace_root(workspace_id).resolve()
    target = safe_workspace_path(workspace_id, filepath)
    if not is_current_workspace_write_path(workspace_id, target):
        raise ValueError('source_outside_managed_directories')
    if not target.is_dir():
        raise ValueError('source_directory_not_found')
    rows = []
    for child in target.iterdir():
        if child.name in IGNORED or child.name in {'.versions', '.trash'}:
            continue
        # Do not follow links out of the workspace or write through links.
        if child.is_symlink():
            rows.append({'name': child.name, 'filepath': child.relative_to(root).as_posix(), 'type': 'symlink', 'accessible': False})
        else:
            rows.append({'name': child.name, 'filepath': child.relative_to(root).as_posix(), 'type': 'directory' if child.is_dir() else 'file', 'size_bytes': child.stat().st_size if child.is_file() else 0, 'accessible': True})
    rows.sort(key=lambda item: (item['type'] != 'directory', item['name'].casefold(), item['name']))
    end = min(len(rows), offset + limit)
    return {'filepath': target.relative_to(root).as_posix(), 'path_basis': 'workspace_root', 'entries': rows[offset:end], 'total': len(rows), 'next_offset': end if end < len(rows) else None}


def move_source(workspace_id, filepath, destination):
    from storage.file_store import list_files
    from storage import index
    with workspace_files_lock(workspace_id):
        source, target = writable_path(workspace_id, filepath), writable_path(workspace_id, destination)
        from storage.workspace_files import managed_write_roots
        roots = {workspace_root(workspace_id).resolve() / name for name in managed_write_roots()}
        if source in roots or target in roots:
            raise ValueError('source_storage_namespace_move_forbidden')
        if not source.exists():
            raise ValueError('source_not_found')
        if target.exists() or target.is_relative_to(source):
            raise ValueError('destination_conflict')
        # Source directory symlinks cannot relocate writable boundaries.
        if source.is_symlink() or source.is_dir() and any(p.is_symlink() for p in source.rglob('*')):
            raise ValueError('source_symlink_move_forbidden')
        root = workspace_root(workspace_id).resolve()
        affected = [(r, root / r['path']) for r in list_files(workspace_id) if (root / r['path']) == source or (root / r['path']).is_relative_to(source)]
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        changes = []
        for record, old in affected:
            new = target if old == source else target / old.relative_to(source)
            if not index.update_file_record(workspace_id, record['file_id'], {'path': new.relative_to(root).as_posix()}):
                raise RuntimeError('source_moved_file_index_settlement_unknown')
            changes.append({'file_id': record['file_id'], 'from': record['path'], 'path': new.relative_to(root).as_posix()})
        from storage.events import publish
        publish(workspace_id, 'file', 'source_moved', '')
        return {'filepath': target.relative_to(root).as_posix(), 'previous_filepath': filepath,
                'file_changes': changes, 'source_imports_rewritten': False,
                'warning': 'Source imports and build references are not rewritten; verify the project after moving.'}


def pack_source(workspace_id, filepath, destination):
    with workspace_files_lock(workspace_id):
        source, target = writable_path(workspace_id, filepath), writable_path(workspace_id, destination)
        if not source.exists() or target.is_relative_to(source):
            raise ValueError('invalid_archive_source_or_destination')
        items = [source] if source.is_file() else [p for p in source.rglob('*') if p.is_file() and not any(part in IGNORED for part in p.relative_to(source).parts)]
        if any(p.is_symlink() for p in items):
            raise ValueError('archive_source_symlink_forbidden')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in items:
                archive.write(path, path.name if source.is_file() else path.relative_to(source).as_posix())
        return {'filepath': destination, 'members': len(items), 'size_bytes': target.stat().st_size}


def extract_archive(workspace_id, file_id, destination):
    from storage.file_store import get_file_record, resolve_file_path
    from storage.policy import MAX_UPLOAD_BYTES
    with workspace_files_lock(workspace_id):
        record = get_file_record(workspace_id, file_id)
        if not record or record.get('lifecycle', 'active') != 'active':
            raise ValueError('file_unavailable')
        source, target = resolve_file_path(workspace_id, file_id), writable_path(workspace_id, destination)
        if target.exists():
            raise FileExistsError('destination_already_exists')
        def member_path(name):
            relative = PurePosixPath(name)
            if relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name or '\x00' in name:
                raise ValueError('unsafe_archive_member')
            return target.joinpath(*relative.parts)
        if zipfile.is_zipfile(source):
            archive = zipfile.ZipFile(source)
            members = archive.infolist()
            total = sum(m.file_size for m in members)
            if any((m.external_attr >> 16) & 0o170000 == 0o120000 for m in members):
                archive.close(); raise ValueError('archive_links_not_allowed')
            directory = lambda m: m.is_dir()
            reader = lambda m: archive.open(m)
        elif tarfile.is_tarfile(source):
            archive = tarfile.open(source)
            members = archive.getmembers()
            total = sum(m.size for m in members)
            if any(not m.isfile() and not m.isdir() for m in members):
                archive.close(); raise ValueError('archive_links_or_special_members_not_allowed')
            directory = lambda m: m.isdir()
            reader = lambda m: archive.extractfile(m)
        else:
            raise ValueError('archive_processor_unavailable')
        try:
            planned = [(m, member_path(m.filename if isinstance(m, zipfile.ZipInfo) else m.name)) for m in members]
            if total > MAX_UPLOAD_BYTES:
                raise ValueError('archive_extracted_size_exceeds_storage_limit')
            names = [str(p.relative_to(target)).casefold() for _, p in planned]
            if len(names) != len(set(names)):
                raise ValueError('archive_member_name_conflict')
            files = {p.relative_to(target).as_posix().casefold() for m, p in planned if not directory(m)}
            if any(parent.as_posix().casefold() in files for _, p in planned for parent in p.relative_to(target).parents if parent != Path('.')):
                raise ValueError('archive_file_directory_conflict')
            target.mkdir(parents=True, exist_ok=False)
            for member, path in planned:
                if directory(member):
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with reader(member) as src, path.open('xb') as out:
                        shutil.copyfileobj(src, out)
        finally:
            archive.close()
        return {'filepath': destination, 'members': len(members), 'source_file_id': file_id, 'size_bytes': total}
