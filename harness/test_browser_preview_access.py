"""Preview access and browser state belong to an invocation's owner/scope."""
import json
import asyncio
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent.modules.browser.access import BrowserScope, browser_scope
from agent.modules.browser.core import _validate_browser_url
from core.tools.client import ToolRuntimeClient
from core.tools.context import ToolRuntimeContext
from core.tools.registry import ToolRegistry
from core.tools.canonical_registry import to_tool_specs


def test_preview_grant_is_exact_owner_workspace_origin(monkeypatch):
    monkeypatch.delenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", raising=False)
    monkeypatch.setenv("LZCORE_BROWSER_LOCAL_PREVIEWS", json.dumps({
        "local/project": ["http://127.0.0.1:18731"],
    }))
    with browser_scope("project", "one"):
        assert _validate_browser_url("http://127.0.0.1:18731/src/index.html") is None
        for url in ["http://127.0.0.1:18732/", "http://localhost:18731/",
                    "http://192.168.1.1:18731/", "http://user@127.0.0.1:18731/",
                    "https://127.0.0.1:18731/", "file:///tmp/index.html"]:
            assert _validate_browser_url(url) is not None
    with browser_scope("other", "one"):
        assert _validate_browser_url("http://127.0.0.1:18731/") is not None
    assert _validate_browser_url("http://127.0.0.1:18731/", scope=BrowserScope("other_user", "project", "one")) is not None


@pytest.mark.parametrize("setting", ["not-json", "[]", '{"local/project":"http://127.0.0.1:18731"}',
    '{"local/project":["http://127.0.0.1:18731/private"]}', '{"local/project":["http://127.0.0.1:bad"]}'])
def test_malformed_preview_grants_fail_closed(monkeypatch, setting):
    monkeypatch.delenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", raising=False)
    monkeypatch.setenv("LZCORE_BROWSER_LOCAL_PREVIEWS", setting)
    with browser_scope("project"):
        assert _validate_browser_url("http://127.0.0.1:18731/") is not None


def test_browser_lifecycle_expires_other_idle_sessions_and_enforces_capacity(monkeypatch):
    from agent.modules.browser import core
    closed = []
    class Resource:
        async def close(self):
            closed.append(self)

    old = core._BrowserSession(context=Resource(), browser=Resource(), last_used=0)
    old.refs["e1"] = "private-selector"
    active = core._BrowserSession(last_used=1000)
    monkeypatch.setattr(core, "_sessions", {
        BrowserScope("local", "old", "one"): old,
        BrowserScope("local", "current", "one"): active,
    })
    monkeypatch.setattr(core.time, "monotonic", lambda: 1000)
    with browser_scope("current", "one"):
        asyncio.run(core._expire_idle_sessions())
        assert core._state() is active
    assert len(closed) == 2 and not old.refs
    assert len(core._sessions) == 1
    monkeypatch.setattr(core, "_sessions", {
        BrowserScope("local", "project", str(i)): core._BrowserSession() for i in range(16)
    })
    with browser_scope("project", "new"):
        with pytest.raises(RuntimeError, match="browser_session_capacity"):
            core._state()
    with browser_scope("project", "0"):
        assert core._state() is core._sessions[BrowserScope("local", "project", "0")]


def test_browser_observation_buffers_are_bounded_and_keep_failure_evidence():
    from agent.modules.browser.core import _PageObservations
    from types import SimpleNamespace
    data = _PageObservations()
    class Request:
        url = "http://example.com/test"
        method = "GET"
        resource_type = "fetch"
        failure = "net::ERR_FAILED"
    for i in range(510):
        data.record_console("log", str(i))
        request = Request()
        data.record_request(request)
    assert data.console_total == 510 and len(data.console) == 200
    assert data.request_total == 510 and len(data.requests) == 500
    data.record_response(SimpleNamespace(request=request, status=503))
    assert data.requests[request]["status"] == 503
    data.record_failure(request)
    assert data.requests[request]["status"] == "failed"
    assert "ERR_FAILED" in data.requests[request]["error"]


def test_governed_browser_preview_and_sessions_are_isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", raising=False)
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(b'<title>Preview</title><main><button>Click</button><button disabled>Unavailable</button><p>Hello</p></main><script>console.error("observed console error");throw new Error("observed page error")</script>')
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("LZCORE_BROWSER_LOCAL_PREVIEWS", json.dumps({"local/project": [origin]}))
    registry = ToolRegistry()
    for spec, handler in to_tool_specs():
        if spec.tool_id == "browser.manage": registry.register_tool(spec, handler)
    client = ToolRuntimeClient(registry)
    def invoke(action, session="one", **args):
        return client.invoke("browser.manage", {"action": action, **args}, context=ToolRuntimeContext(
            workspace_id="project", session_id=session, requested_by="turn_runner"))
    try:
        result = invoke("navigate", url=origin)
        assert result.status == "succeeded", result.summary
        messages = str(invoke("console").output)
        assert "observed console error" in messages
        assert "observed page error" in messages
        assert "200" in str(invoke("network").output)
        snapshot = invoke("snapshot")
        assert "Hello" in str(snapshot.output)
        disabled = next(item for item in snapshot.output["elements"] if item["name"] == "Unavailable")
        assert disabled["disabled"] is True
        started = time.monotonic()
        rejected = invoke("click", ref=disabled["ref"])
        assert rejected.output["error_code"] == "target_disabled"
        assert rejected.output["interaction_sent"] is False
        assert time.monotonic() - started < 1
        # Another session cannot see the first session's DOM, history or refs.
        other = invoke("snapshot", session="two")
        assert "Hello" not in str(other.output)
        assert "observed console error" not in str(invoke("console", session="two").output)
        assert invoke("click", session="two", ref="e1").status != "succeeded"
        invoke("close", session="two")
        assert "Hello" in str(invoke("snapshot").output)
    finally:
        invoke("close"); invoke("close", session="two")
        server.shutdown(); server.server_close(); thread.join(timeout=2)
