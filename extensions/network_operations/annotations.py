"""Versioned whiteboard annotations, separate from topology geometry."""
import json
import math
import re
from extensions.network_operations.topology_service import _store, _drawing_transaction
from storage.time_utils import now_iso


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e7:
        raise ValueError('annotation_coordinate_invalid')
    return value


def _validate(payload):
    if len(json.dumps(payload, ensure_ascii=False).encode()) > 4 * 1024 * 1024:
        raise ValueError('annotations_too_large')
    strokes, notes = payload.get('strokes', []), payload.get('notes', [])
    if not isinstance(strokes, list) or not isinstance(notes, list) or len(strokes) > 5000 or len(notes) > 1000:
        raise ValueError('annotations_invalid')
    seen = set()
    for item in [*strokes, *notes]:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not 0 < len(item['id']) <= 128 or item['id'] in seen or not re.fullmatch(r'#[0-9a-fA-F]{6}', str(item.get('color', ''))):
            raise ValueError('annotation_invalid')
        seen.add(item['id'])
    for stroke in strokes:
        if stroke.get('tool') not in {'pen', 'highlighter', 'arrow', 'rect'} or not 1 <= _number(stroke.get('size')) <= 100:
            raise ValueError('annotation_stroke_invalid')
        points = stroke.get('points')
        if not isinstance(points, list) or len(points) > 50000:
            raise ValueError('annotation_points_invalid')
        for point in points:
            if not isinstance(point, dict):
                raise ValueError('annotation_point_invalid')
            _number(point.get('x')); _number(point.get('y'))
    for note in notes:
        _number(note.get('x')); _number(note.get('y'))
        if not isinstance(note.get('text'), str) or len(note['text']) > 10000:
            raise ValueError('annotation_note_invalid')
    return {'strokes': strokes, 'notes': notes}


def get_annotations(workspace_id, topology_id):
    store = _store(workspace_id)
    if not store.get('topologies', topology_id):
        raise ValueError('topology_not_found')
    return store.get('annotations', topology_id) or {'version': 0, 'strokes': [], 'notes': []}


@_drawing_transaction
def save_annotations(workspace_id, topology_id, payload):
    old = get_annotations(workspace_id, topology_id)
    version = payload.get('version')
    if type(version) is not int or version != old['version']:
        raise ValueError('annotations_version_conflict')
    value = _validate(payload)
    return _store(workspace_id).save('annotations', topology_id, {**value, 'version': version + 1, 'updated_at': now_iso()})
