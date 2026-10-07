"""Unified managed-file metadata and event APIs."""

from __future__ import annotations

from flask import Response, jsonify, request, send_file, stream_with_context

from storage.ids import validate_workspace_id


def register_storage_routes(app) -> None:
    @app.route("/api/storage/overview")
    def api_storage_overview():
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
        from storage.data_management import data_overview
        return jsonify({"ok": True, "overview": data_overview(workspace_id)})

    @app.route("/api/storage/files")
    def api_storage_files():
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
        lifecycle = request.args.get("lifecycle", "active").strip()
        from storage.file_workspace import files_page
        try:
            page = files_page(workspace_id, lifecycle=lifecycle, query=request.args.get('q', ''),
                view=request.args.get('view', 'files'), folder=request.args.get('folder'),
                sort=request.args.get('sort', 'created'), logical_type=request.args.get('logical_type', ''), cursor=request.args.get('cursor', ''), limit=int(request.args.get('limit', 100)))
            return jsonify({'ok': True, **page})
        except ValueError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400

    @app.route('/api/storage/search')
    def api_storage_content_search():
        try:
            from storage.file_search import search_content
            from storage.data_management import managed_data_files
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            from storage.file_workspace import matches_view
            view = request.args.get('view', 'files')
            if view not in {'files', 'all', 'history', 'evidence', 'deliverables'}:
                raise ValueError('invalid_file_view')
            files = {r['file_id']: r for r in managed_data_files(ws) if matches_view(r, view=view, folder=request.args.get('folder'))}
            result = search_content(ws, request.args.get('q', ''), limit=int(request.args.get('limit', 50)), cursor=request.args.get('cursor', ''), file_ids=set(files))
            result['files'] = [{**files[h['file_id']], 'search_hit': h} for h in result['hits'] if h['file_id'] in files]
            return jsonify({'ok': True, **result})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/search/rebuild', methods=['POST'])
    def api_storage_search_rebuild():
        from storage.file_search import synchronize
        data = request.get_json(silent=True) or {}
        try:
            ws = validate_workspace_id(data.get('workspace_id', ''))
            return jsonify({'ok': True, **synchronize(ws, documents=True, rebuild=True)})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/files/<file_id>/inspect')
    def api_storage_file_inspect(file_id):
        try:
            from storage.file_formats import inspect_file
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            return jsonify({'ok': True, **inspect_file(ws, file_id, offset=int(request.args.get('offset', 0)), limit=int(request.args.get('limit', 50)))})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/files/<file_id>/page', methods=['POST'])
    def api_storage_file_page(file_id):
        try:
            from storage.file_formats import render_pdf_page
            data = request.get_json(silent=True) or {}
            ws = validate_workspace_id(data.get('workspace_id', ''))
            return jsonify({'ok': True, **render_pdf_page(ws, file_id, page=int(data.get('page', 1)), ocr=data.get('ocr') is True)})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route("/api/storage/files/<file_id>/relations")
    def api_storage_file_relations(file_id):
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
        from storage.data_management import file_relations
        relations = file_relations(workspace_id, file_id)
        if relations is None:
            return jsonify({"ok": False, "error": "file_not_found"}), 404
        return jsonify({"ok": True, "relations": relations})

    @app.route("/api/storage/files/<file_id>/content")
    def api_storage_file_content(file_id):
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
        from storage.data_management import text_file_content
        try:
            content = text_file_content(workspace_id, file_id,
                offset=int(request.args.get('offset', 0)),
                max_chars=min(100_000, int(request.args.get('limit', 100_000))))
        except (OSError, ValueError) as exc:
            return jsonify({"ok": False, "error": str(exc)[:160]}), 400
        if content is None:
            return jsonify({"ok": False, "error": "file_not_found"}), 404
        return jsonify({"ok": True, **content})

    @app.route("/api/storage/files/<file_id>/preview")
    def api_storage_file_preview(file_id):
        """Serve an in-workspace image for chat attachment rendering."""
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
            from storage.file_store import get_file_record, resolve_file_path
            record = get_file_record(workspace_id, file_id)
            mime_type = str((record or {}).get("mime_type") or "").lower()
            if not record or record.get("lifecycle", "active") != "active" or not (mime_type.startswith(('image/', 'audio/', 'video/')) or mime_type == 'application/pdf'):
                return jsonify({"ok": False, "error": "image_not_found"}), 404
            response = send_file(resolve_file_path(workspace_id, file_id), mimetype=mime_type, conditional=True, max_age=0)
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
            return response
        except (OSError, ValueError):
            return jsonify({"ok": False, "error": "image_not_found"}), 404

    @app.route("/api/storage/files/<file_id>", methods=["DELETE"])
    def api_storage_file_delete(file_id):
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400
        confirmed = request.args.get("confirm", "").lower() == "true"
        if not confirmed:
            return jsonify({"ok": False, "error": "confirm_required"}), 400
        force = request.args.get("force", "").lower() == "true"
        from storage.data_management import delete_unreferenced_file
        result = delete_unreferenced_file(workspace_id, file_id, force=force,
            permanent=request.args.get('permanent', '').lower() == 'true')
        if result.get("ok"):
            return jsonify(result)
        status = 409 if result.get("error") == "file_in_use" else 404 if result.get("error") == "file_not_found" else 400
        return jsonify(result), status

    @app.route('/api/storage/files/<file_id>/restore', methods=['POST'])
    def api_storage_file_restore(file_id):
        data = request.get_json(silent=True) or {}
        try:
            workspace_id = validate_workspace_id(data.get('workspace_id', ''))
            from storage.file_store import restore_file
            result = restore_file(workspace_id, file_id)
            return jsonify(result), 200 if result.get('ok') else 409
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/files/<file_id>', methods=['GET', 'PATCH'])
    def api_storage_file_metadata(file_id):
        try:
            data = request.get_json(silent=True) or {} if request.method == 'PATCH' else request.args
            workspace_id = validate_workspace_id(data.get('workspace_id', ''))
            from storage.file_workspace import organize_file, resolve_reference
            record = organize_file(workspace_id, file_id, name=data.get('name'), folder=data.get('folder')) if request.method == 'PATCH' else resolve_reference(workspace_id, file_id=file_id)
            return jsonify({'ok': True, 'file': record})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/files/<file_id>/download')
    def api_storage_file_download(file_id):
        try:
            workspace_id = validate_workspace_id(request.args.get('workspace_id', ''))
            from storage.file_store import get_file_record, resolve_file_path
            record = get_file_record(workspace_id, file_id)
            if not record or record.get('lifecycle', 'active') != 'active':
                return jsonify({'ok': False, 'error': 'file_unavailable'}), 404
            return send_file(resolve_file_path(workspace_id, file_id), as_attachment=True,
                download_name=record.get('original_name') or file_id,
                mimetype=record.get('mime_type') or 'application/octet-stream', conditional=True)
        except (ValueError, OSError):
            return jsonify({'ok': False, 'error': 'file_unavailable'}), 404

    @app.route('/api/storage/reconcile', methods=['POST'])
    def api_storage_reconcile_file_commits():
        data = request.get_json(silent=True) or {}
        try:
            from storage.file_audit import reconcile_file_commits
            ws = validate_workspace_id(data.get('workspace_id', ''))
            return jsonify({'ok': True, **reconcile_file_commits(ws, apply=data.get('apply') is True)})
        except ValueError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        except (OSError, RuntimeError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160], 'error_code': 'EXECUTION_UNKNOWN', 'automatic_retry_allowed': False}), 409

    @app.route('/api/storage/sources/content')
    def api_storage_source_content():
        try:
            from core.tools.path_security import safe_workspace_path
            from storage.workspace_files import is_current_workspace_write_path
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            target = safe_workspace_path(ws, request.args.get('filepath', ''))
            if not is_current_workspace_write_path(ws, target) or not target.is_file():
                raise ValueError('source_file_unavailable')
            with target.open(encoding='utf-8') as stream:
                content = stream.read(100_001)
            if '\x00' in content:
                raise ValueError('binary_source_requires_a_format_processor')
            return jsonify({'ok': True, 'content': content[:100_000], 'truncated': len(content) > 100_000, 'path_basis': 'workspace_root'})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/health')
    def api_file_workspace_health():
        try:
            from storage.file_audit import file_health
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            return jsonify({'ok': True, 'health': file_health(ws, hashes=request.args.get('hashes') == 'true')})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/migration', methods=['POST'])
    def api_storage_migration():
        data = request.get_json(silent=True) or {}
        try:
            from storage.file_audit import migrate_references
            ws = validate_workspace_id(data.get('workspace_id', ''))
            return jsonify({'ok': True, **migrate_references(ws, apply=data.get('apply') is True)})
        except ValueError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        except (OSError, RuntimeError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160], 'error_code': 'EXECUTION_UNKNOWN', 'automatic_retry_allowed': False}), 409

    @app.route('/api/storage/backup')
    def api_storage_backup():
        try:
            import tempfile
            from storage.file_bundle import export_bundle
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            output = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
            try:
                export_bundle(ws, output=output); output.seek(0)
                return send_file(output, mimetype='application/zip', as_attachment=True, download_name=f'{ws}-files-backup.zip')
            except Exception:
                output.close(); raise
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/restore', methods=['POST'])
    def api_storage_restore_bundle():
        try:
            import zipfile
            from storage.file_bundle import restore_bundle
            ws = validate_workspace_id(request.form.get('workspace_id', ''))
            upload = request.files.get('file')
            if upload is None:
                raise ValueError('backup_file_required')
            result = restore_bundle(ws, upload.stream, preview=request.form.get('apply') != 'true')
            return jsonify(result), 200 if result.get('ok') else 409
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400
        except (OSError, RuntimeError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160], 'error_code': 'EXECUTION_UNKNOWN', 'automatic_retry_allowed': False}), 409

    @app.route('/api/storage/sources')
    def api_storage_sources():
        try:
            from storage.source_workspace import source_entries
            ws = validate_workspace_id(request.args.get('workspace_id', ''))
            return jsonify({'ok': True, **source_entries(ws, request.args.get('filepath', 'files/data'), offset=int(request.args.get('offset', 0)), limit=int(request.args.get('limit', 100)))})
        except (ValueError, OSError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160]}), 400

    @app.route('/api/storage/sources/move', methods=['POST'])
    def api_storage_source_move():
        try:
            from storage.source_workspace import move_source
            data = request.get_json(silent=True) or {}
            ws = validate_workspace_id(data.get('workspace_id', ''))
            return jsonify({'ok': True, **move_source(ws, data.get('filepath', ''), data.get('destination', ''))})
        except ValueError as exc:
            return jsonify({'ok': False, 'error': str(exc)}), 400
        except (OSError, RuntimeError) as exc:
            return jsonify({'ok': False, 'error': str(exc)[:160], 'error_code': 'EXECUTION_UNKNOWN', 'automatic_retry_allowed': False}), 409

    @app.route("/api/storage/events")
    def api_storage_events():
        try:
            workspace_id = validate_workspace_id(request.args.get("workspace_id", ""))
        except ValueError:
            return jsonify({"ok": False, "error": "invalid_workspace_id"}), 400

        def generate():
            import queue
            from storage.events import subscribe
            with subscribe(workspace_id) as subscriber:
                yield "event: connected\ndata: {}\n\n"
                while True:
                    try:
                        yield f"event: storage_changed\ndata: {subscriber.get(timeout=25)}\n\n"
                    except queue.Empty:
                        yield ": keepalive\n\n"

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "X-Accel-Buffering": "no",
            },
        )
