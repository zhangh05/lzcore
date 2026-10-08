# backend/api/memory.py
"""Governed memory API: lifecycle, retrieval, review, and deletion."""
from flask import request, jsonify


def _validated_ws_id(raw: str) -> str:
    """Validate and return workspace_id. Empty → 400."""
    if not raw or not raw.strip():
        return ""
    from storage.ids import validate_workspace_id
    return validate_workspace_id(raw.strip())


def _read_ws_id(raw: str):
    try:
        ws_id = _validated_ws_id(raw)
    except Exception:
        return "", "invalid_workspace_id"
    if not ws_id:
        return "", "workspace_id is required"
    return ws_id, ""


def handle_memory_status():
    """Return memory system status for the given workspace."""
    ws_id = request.args.get("workspace_id", "")
    ws_id, err = _read_ws_id(ws_id)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    try:
        from storage.memory_governance import MemoryStore, is_auto_memory_enabled
        store = MemoryStore()
        records = store.list_retrievable(ws_id)
        all_records = store.list_all(ws_id)
        status_counts: dict[str, int] = {}
        for record in all_records:
            status_counts[record.status] = status_counts.get(record.status, 0) + 1
        return jsonify({
            "ok": True,
            "enabled": is_auto_memory_enabled(ws_id),
            "backend": "canonical_memory_records",
            "workspace_id": ws_id,
            "records": len(records),
            "policy": "evidence_governed",
            "status_counts": status_counts,
            "scope_counts": {scope: sum(r.scope == scope for r in all_records) for scope in ("global", "workspace", "session", "task")},
            "load_errors": store.load_errors(),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_write():
    """Write a memory record through MemoryWriteGate (governed)."""
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'ok': False, 'error': 'object_required'}), 400
    title = data.get("title", "")
    content = data.get("content", "")
    if not isinstance(title, str) or not isinstance(content, str):
        return jsonify({'ok': False, 'error': 'text_required'}), 400
    if not title.strip() and not content.strip():
        return jsonify({"ok": False, "error": "title or content required"}), 400

    workspace_id = data.get("workspace_id", "")
    ws_id, err = _read_ws_id(workspace_id)
    if err:
        return jsonify({"ok": False, "error": err}), 400

    source = data.get("source", "agent")
    try:
        confidence = max(0.0, min(float(data.get("confidence", 0.5)), 1.0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "invalid_confidence"}), 400
    user_confirmed = data.get("user_confirmed") is True
    is_subagent = bool(data.get("is_subagent", False))

    try:
        from storage.memory_governance import MemoryRecord, MemoryWriteGate
        gate = MemoryWriteGate()

        # Build MemoryRecord for governance
        record_id = {'memory_id': str(data['memory_id'])} if data.get('memory_id') else {}
        rec = MemoryRecord(
            **record_id,
            workspace_id=ws_id,
            session_id=data.get("session_id", ""),
            task_id=data.get("task_id", ""),
            scope=data.get("scope", "workspace"),
            memory_type=data.get("memory_type", "knowledge_note"),
            status="active" if user_confirmed else "pending",
            source="user" if user_confirmed else ("subagent" if is_subagent else "agent_suggestion"),
            content=content,
            summary=title,
            confidence=confidence,
            citations=data.get("citations", []),
            created_by="user" if user_confirmed else source,
            redacted=True,
            metadata={
                'memory_key': str(data.get('memory_key') or ''),
                'supersedes_memory_id': str(data.get('supersedes_memory_id') or ''),
            },
        )
        result = gate.write(rec)
        return jsonify(result), 200 if result.get('ok') else 400
    except OSError:
        return jsonify({'ok': False, 'status': 'execution_unknown', 'memory_id': rec.memory_id,
                        'error': 'memory_write_unknown_readback_required'}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_search():
    """Search memory records through MemoryStore (governed)."""
    data = request.get_json(silent=True) or {}
    query = data.get("query", "")
    workspace_id = data.get("workspace_id", "")
    ws_id, err = _read_ws_id(workspace_id)
    if err:
        return jsonify({"ok": False, "error": err}), 400

    try:
        limit = max(1, min(int(data.get("limit", 10)), 100))
    except (ValueError, TypeError):
        return jsonify({"ok": False, "error": "invalid_limit"}), 400

    try:
        from storage.memory_governance import MemoryStore
        store = MemoryStore()
        offset = max(0, int(data.get('offset', 0)))
        records = store.search(ws_id, query, limit=0,
                               scope_filter=str(data.get('scope') or ''),
                               type_filter=str(data.get('memory_type') or ''),
                               status_filter=str(data.get('status') or ''))
        from storage.memory_governance import MemoryRecord
        all_records = store.list_all(ws_id)
        replaced = store.superseded_records(all_records)
        if data.get('include_deleted') is False:
            records = [rec for rec in records if rec['status'] not in {'rejected', 'expired'} and rec['memory_id'] not in replaced]
        page = [_record_view(MemoryRecord.from_dict(rec), replaced) for rec in records[offset:offset + limit]]
        return jsonify({'ok': True, 'results': page, 'count': len(page), 'total': len(records),
                        'next_offset': offset + len(page) if offset + len(page) < len(records) else None,
                        'load_errors': store.load_errors()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_confirm():
    """Confirm a pending memory record."""
    data = request.get_json(silent=True) or {}
    ws_id, err = _read_ws_id(data.get("workspace_id", ""))
    memory_id = data.get("memory_id", "")
    if err:
        return jsonify({"ok": False, "error": err}), 400
    if not memory_id:
        return jsonify({"ok": False, "error": "memory_id required"}), 400

    try:
        from storage.memory_governance import confirm_memory
        result = confirm_memory(ws_id, memory_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_reject():
    """Reject a pending memory record."""
    data = request.get_json(silent=True) or {}
    ws_id, err = _read_ws_id(data.get("workspace_id", ""))
    memory_id = data.get("memory_id", "")
    if err:
        return jsonify({"ok": False, "error": err}), 400
    if not memory_id:
        return jsonify({"ok": False, "error": "memory_id required"}), 400

    try:
        from storage.memory_governance import reject_memory
        result = reject_memory(ws_id, memory_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_delete(memory_id):
    """Hard-delete a memory record — physically remove file and ContextStore index."""
    if request.args.get("confirm", "").lower() != "true":
        return jsonify({"ok": False, "error": "confirm_required"}), 400
    ws_id, err = _read_ws_id(request.args.get("workspace_id", ""))
    if err:
        return jsonify({"ok": False, "error": err}), 400
    try:
        from storage.memory_governance import MemoryStore
        store = MemoryStore()
        ok = store.delete_file(ws_id, memory_id)
        if not ok:
            return jsonify({"ok": False, "error": "memory_not_found"}), 404
        return jsonify({"ok": True, "deleted_count": 1})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]}), 500


def handle_memory_batch_delete():
    """Hard-delete multiple memory records."""
    data = request.get_json(silent=True) or {}
    if data.get("confirm") is not True:
        return jsonify({"ok": False, "error": "confirm_required"}), 400
    ws_id, err = _read_ws_id(data.get("workspace_id", ""))
    if err:
        return jsonify({"ok": False, "error": err}), 400
    ids = data.get("memory_ids") or []
    if not ids or not isinstance(ids, list):
        return jsonify({"ok": False, "error": "memory_ids required (list)"}), 400

    from storage.memory_governance import MemoryStore
    store = MemoryStore()
    deleted = 0
    for mid in ids:
        if store.delete_file(ws_id, mid):
            deleted += 1
    return jsonify({"ok": True, "deleted_count": deleted, "requested": len(ids)})


def _record_view(record, replaced):
    payload = record.to_dict()
    payload['superseded_by'] = replaced.get(record.memory_id) or record.metadata.get('superseded_by', '')
    payload['retrievable'] = record.is_retrievable() and not payload['superseded_by']
    return payload


def handle_memory_get(memory_id):
    ws_id, err = _read_ws_id(request.args.get('workspace_id', ''))
    if err:
        return jsonify({'ok': False, 'error': err}), 400
    from storage.memory_governance import MemoryStore
    store = MemoryStore()
    with store.mutation_lock(ws_id):
        record = store.get(ws_id, memory_id)
        if record is None:
            return jsonify({'ok': False, 'error': 'memory_unavailable' if store.load_errors() else 'memory_not_found',
                            'load_errors': store.load_errors()}), 404
        replaced = store.superseded_records(store.list_all(ws_id))
        return jsonify({'ok': True, 'record': _record_view(record, replaced)})


def handle_memory_list():
    """Filter before paging, with an explicit cursor and canonical diagnostics."""
    ws_id, err = _read_ws_id(request.args.get('workspace_id', ''))
    if err:
        return jsonify({'ok': False, 'error': err}), 400
    try:
        offset = int(request.args.get('offset', 0))
        limit = int(request.args.get('limit', 100))
        if offset < 0 or not 1 <= limit <= 500:
            raise ValueError()
    except (ValueError, TypeError):
        return jsonify({'ok': False, 'error': 'invalid_page_range'}), 400
    from storage.memory_governance import MemoryStore
    store = MemoryStore()
    all_records = store.list_all(ws_id)
    replaced = store.superseded_records(all_records)
    include_deleted = request.args.get('include_deleted', '').lower() in {'true', '1', 'yes'}
    filters = {field: request.args.get(field, '').strip() for field in ('status', 'scope', 'memory_type', 'session_id')}
    records = [_record_view(rec, replaced) for rec in all_records
               if all(not value or getattr(rec, field) == value for field, value in filters.items())
               and (include_deleted or rec.status not in {'rejected', 'expired'} and rec.memory_id not in replaced)]
    page = records[offset:offset + limit]
    return jsonify({'ok': True, 'records': page, 'count': len(page), 'total': len(records),
                    'offset': offset, 'next_offset': offset + len(page) if offset + len(page) < len(records) else None,
                    'load_errors': store.load_errors()})
