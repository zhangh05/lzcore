"""Bind synchronous HTTP turns to the existing durable job lifecycle."""

import threading
from contextlib import contextmanager

from agent.runtime.stream_emitter import StreamEmitter
from core.runtime_engine.models import MainAgentRuntimeControl
from jobs.lifecycle import update_session_turn_stage
from jobs.store import get_job


@contextmanager
def claimed_turn_runtime(workspace_id, session_id, job_id, client_request_id):
    if not job_id:
        yield None
        return

    open_events = threading.Event()
    open_events.set()
    previous = StreamEmitter._get_realtime()

    def current_job():
        record = get_job(workspace_id, job_id)
        active = (record.metadata or {}).get("active_turn", {}) if record else {}
        if active.get("client_request_id") != client_request_id or active.get("status") != "running":
            return None
        return record

    def cancelled():
        record = current_job()
        return record is None or record.cancel_requested or record.status == "cancelled"

    def project(event):
        if not open_events.is_set():
            return
        if event.get("type") not in {"token", "heartbeat"} and current_job():
            update_session_turn_stage(workspace_id, job_id, session_id, event)
        if previous:
            previous(event)

    StreamEmitter.set_realtime_callback(project)
    try:
        yield MainAgentRuntimeControl(cancel_check=cancelled)
    finally:
        open_events.clear()
        if previous:
            StreamEmitter.set_realtime_callback(previous)
        else:
            StreamEmitter.clear_realtime_callback()
