# observability/store.py
"""Trace store — write/read trace records to workspace runs directory."""

from typing import Optional

from storage.records import list_json_records, read_json_record, mutate_json_record


def write_trace(trace, ws_id: str = "default") -> str:
    """Write a trace record to workspace runs directory. Returns trace_id."""
    from storage.ids import validate_workspace_id
    ws_id = validate_workspace_id(ws_id)

    trace_id = trace.trace_id
    run_id = trace.run_id

    # Redact before writing
    from observability.redaction import redact_trace
    data = redact_trace(trace.as_dict())

    from storage.run_record_store import save_trace_record
    save_trace_record(ws_id, run_id, data)

    try:
        from observability.exporters import export_configured_trace
        export_configured_trace(data)
    except Exception:
        import logging
        logging.getLogger(__name__).warning("OTLP trace export failed", exc_info=True)

    return trace_id


def get_trace(run_id: str, ws_id: str = "default") -> Optional[dict]:
    """Get a trace record by run_id."""
    from storage.ids import validate_workspace_id
    ws_id = validate_workspace_id(ws_id)
    return read_json_record(ws_id, ("runs", f"{run_id}.trace.json"))


def list_traces(ws_id: str = "default", limit: int = 50) -> list:
    """List trace records for a workspace."""
    from storage.ids import validate_workspace_id
    ws_id = validate_workspace_id(ws_id)
    traces = []
    for trace in list_json_records(ws_id, ("runs",), limit=limit, suffix=".trace.json"):
        try:
            traces.append({
                "trace_id": trace.get("trace_id", ""),
                "run_id": trace.get("run_id", ""),
                "workspace_id": trace.get("workspace_id", ""),
                "status": trace.get("status", ""),
                "total_duration_ms": trace.get("total_duration_ms", 0),
                "node_count": trace.get("node_count", 0),
                "event_count": len(trace.get("events", [])),
            })
            if len(traces) >= limit:
                break
        except Exception:
            pass
    return traces


def append_event(trace_id: str, event, ws_id: str = "default"):
    """Append under one transaction; a missing trace is not created implicitly."""
    from storage.ids import validate_workspace_id
    from storage.run_record_store import run_record_guard
    from observability.redaction import redact_trace_event

    ws_id = validate_workspace_id(ws_id)
    event_data = event.as_dict() if hasattr(event, "as_dict") else dict(event)
    run_id = str(event_data.get("run_id") or "")
    if not run_id:
        for trace in list_json_records(ws_id, ("runs",), limit=None, suffix=".trace.json"):
            if trace.get("trace_id") == trace_id:
                run_id = str(trace.get("run_id") or "")
                break
    if not run_id:
        return
    # Avoid creating an empty record when tools emit events before a trace exists.
    candidate = read_json_record(ws_id, ("runs", f"{run_id}.trace.json"), strict=True)
    if candidate is None or candidate.get("trace_id") != trace_id:
        return

    def append(current):
        if current is None or current.get("trace_id") != trace_id:
            raise ValueError("trace disappeared or identity changed")
        events = list(current.get("events") or [])
        events.append(redact_trace_event(event_data))
        current["events"] = events
        return current, None

    session_id = str(candidate.get("session_id") or (event_data.get("metadata") or {}).get("session_id") or "")
    with run_record_guard(ws_id, run_id, session_id):
        mutate_json_record(ws_id, ("runs", f"{run_id}.trace.json"), append)
