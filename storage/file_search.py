"""Rebuildable workspace-scoped content index; FileRecord remains authoritative."""
import sqlite3
from contextlib import closing
from storage.paths import workspace_root
from storage.file_store import list_files
from core.tools.path_security import safe_workspace_path
from storage.project_changes import workspace_files_lock


def _database(workspace_id):
    path = workspace_root(workspace_id) / 'index/file-search.sqlite'
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute('CREATE TABLE IF NOT EXISTS documents (file_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, content TEXT NOT NULL, coverage TEXT NOT NULL)')
    return db


def synchronize(workspace_id, *, documents=False, rebuild=False):
    """Refresh changed records; explicit documents=True includes parsed Office/PDF."""
    import json
    with workspace_files_lock(workspace_id), closing(_database(workspace_id)) as db:
        if rebuild:
            db.execute('DELETE FROM documents')
        rows = list_files(workspace_id)
        current = {r['file_id']: r for r in rows}
        indexed = dict(db.execute('SELECT file_id, sha256 FROM documents'))
        db.executemany('DELETE FROM documents WHERE file_id=?', [(fid,) for fid in indexed if fid not in current or indexed[fid] != current[fid]['sha256']])
        failures = []
        updated = 0
        for record in rows:
            if not rebuild and indexed.get(record['file_id']) == record['sha256']:
                continue
            try:
                if not record.get('binary'):
                    content = safe_workspace_path(workspace_id, record['path']).read_text(encoding='utf-8', errors='replace')
                    coverage = {'kind': 'text', 'lines': content.count('\n') + 1, 'complete': True}
                elif documents and record['file_kind'] in {'docx', 'xlsx', 'pptx', 'pdf'}:
                    from agent.modules.knowledge.parsers.base import parse_document
                    document = parse_document(safe_workspace_path(workspace_id, record['path']).read_bytes(), fmt=record['file_kind'], title=record['original_name'])
                    content = document.normalized_markdown
                    coverage = {'kind': 'parsed_text', 'layout': False, 'warnings': document.warnings, 'complete': False}
                else:
                    continue
                db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?,?)', (record['file_id'], record['sha256'], content, json.dumps(coverage)))
                updated += 1
            except (ValueError, OSError) as exc:
                failures.append({'file_id': record['file_id'], 'error': str(exc)[:160]})
        db.commit()
        return {'updated': updated, 'indexed': db.execute('SELECT COUNT(*) FROM documents').fetchone()[0], 'failures': failures,
                'rebuildable': True, 'embedding_requests': 0}


def search_content(workspace_id, query, *, limit=50, cursor='', file_ids=None):
    import json
    if not isinstance(query, str) or not query.strip() or not 1 <= limit <= 200:
        raise ValueError('invalid_content_search')
    synchronize(workspace_id)
    # Escaping prevents SQL wildcard characters from changing literal search semantics.
    pattern = '%' + query.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
    with closing(_database(workspace_id)) as db:
        db.execute('CREATE TEMP TABLE eligible (file_id TEXT PRIMARY KEY)')
        if file_ids is None:
            db.execute('INSERT INTO eligible SELECT file_id FROM documents')
        else:
            db.executemany('INSERT INTO eligible VALUES (?)', [(fid,) for fid in file_ids])
        total = db.execute("SELECT COUNT(*) FROM documents JOIN eligible USING(file_id) WHERE content LIKE ? ESCAPE '\\'", (pattern,)).fetchone()[0]
        rows = db.execute("SELECT file_id, sha256, content, coverage FROM documents JOIN eligible USING(file_id) WHERE content LIKE ? ESCAPE '\\' AND file_id > ? ORDER BY file_id LIMIT ?", (pattern, cursor, limit + 1)).fetchall()
    hits = []
    for fid, digest, content, coverage in rows[:limit]:
        position = content.casefold().find(query.strip().casefold())
        hits.append({'file_id': fid, 'source_sha256': digest, 'line': content[:position].count('\n') + 1,
                     'character_offset': position, 'snippet': content[max(0, position - 80):position + len(query) + 160], 'coverage': json.loads(coverage)})
    return {'hits': hits, 'total': total, 'next_cursor': hits[-1]['file_id'] if len(rows) > limit else '', 'scope': 'managed_files',
            'coverage': 'Active text files and explicitly indexed parsed documents; no model or embedding request.'}
