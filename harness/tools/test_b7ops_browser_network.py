"""Browser network policy uses fake routes, DNS and browser resources only."""
import asyncio
import json
import socket
from types import SimpleNamespace

import pytest

from agent.modules.browser import core
from agent.modules.browser.access import BrowserScope


class WebSocketRoute:
    def __init__(self, url):
        self.url = url
        self.connected = False
        self.closed = False

    async def close(self, **kwargs):
        assert kwargs["code"] == 1008
        self.closed = True

    def connect_to_server(self):
        self.connected = True


@pytest.fixture(autouse=True)
def public_only(monkeypatch):
    monkeypatch.delenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", raising=False)
    monkeypatch.delenv("LZCORE_BROWSER_LOCAL_PREVIEWS", raising=False)


@pytest.mark.parametrize("scheme", ["ws", "wss"])
@pytest.mark.parametrize("target", ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "192.168.1.2", "169.254.169.254", "100.64.0.1", "localhost", "internal.local"])
def test_private_websockets_are_closed_before_connect(scheme, target):
    route = WebSocketRoute(f"{scheme}://{target}:8765/probe")
    asyncio.run(core._abort_blocked_browser_websocket(route))
    assert route.closed and not route.connected


@pytest.mark.parametrize("addresses", [["8.8.8.8"], ["127.0.0.1"], ["8.8.8.8", "192.168.1.1"], [], None])
@pytest.mark.parametrize("websocket", [False, True])
def test_http_and_websocket_share_public_dns_policy(monkeypatch, addresses, websocket):
    def dns(host, *_):
        assert host == "synthetic.test"
        if addresses is None:
            raise socket.gaierror("synthetic DNS failure")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 0)) for value in addresses]
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    if websocket:
        route = WebSocketRoute("wss://synthetic.test/socket")
        asyncio.run(core._abort_blocked_browser_websocket(route))
        allowed = route.connected
        assert route.closed is not allowed
    else:
        decisions = []
        async def abort():
            decisions.append(False)
        async def continue_():
            decisions.append(True)
        route = SimpleNamespace(request=SimpleNamespace(url="https://synthetic.test/redirected"), abort=abort, continue_=continue_)
        asyncio.run(core._abort_blocked_browser_request(route))
        allowed = decisions == [True]
    assert allowed is (addresses == ["8.8.8.8"])


def test_websocket_preview_grants_remain_bound_to_frozen_scope(monkeypatch):
    monkeypatch.setenv("LZCORE_BROWSER_LOCAL_PREVIEWS", json.dumps({"local/project": ["http://127.0.0.1:18731"]}))
    for workspace, port, allowed in [("project", 18731, True), ("other", 18731, False), ("project", 18732, False)]:
        route = WebSocketRoute(f"ws://127.0.0.1:{port}/hmr")
        asyncio.run(core._abort_blocked_browser_websocket(route, scope=BrowserScope("local", workspace, "one")))
        assert route.connected is allowed


@pytest.mark.parametrize("url", ["http://8.8.8.8/", "file:///tmp/probe", "wss://[bad/socket", ""])
def test_invalid_websocket_urls_fail_closed(url):
    route = WebSocketRoute(url)
    asyncio.run(core._abort_blocked_browser_websocket(route))
    assert route.closed and not route.connected


@pytest.mark.parametrize("ws_support", ["ready", "missing", "failed"])
def test_network_guards_precede_pages_and_setup_failure_cannot_be_reused(monkeypatch, ws_support):
    state = core._BrowserSession()
    events, options, callbacks, launch_options = [], {}, {}, {}
    async def http_route(pattern, callback):
        callbacks["http"] = callback
        events.append("http")
    async def ws_route(pattern, callback):
        if ws_support == "failed":
            raise RuntimeError("synthetic setup failure")
        callbacks["ws"] = callback
        events.append("ws")
    context = SimpleNamespace(route=http_route)
    if ws_support != "missing":
        context.route_web_socket = ws_route
    async def new_context(**kwargs):
        options.update(kwargs)
        return context
    async def close():
        events.append("closed")
    async def launch(**kwargs):
        launch_options.update(kwargs)
        return SimpleNamespace(new_context=new_context, close=close)
    async def new_page(index):
        assert events == ["http", "ws"]
        state.pages[index] = SimpleNamespace(is_closed=lambda: False)
        events.append("page")
    async def expire():
        pass
    monkeypatch.setattr(core, "_state", lambda: state)
    monkeypatch.setattr(core, "_pw_instance", SimpleNamespace(chromium=SimpleNamespace(launch=launch)))
    monkeypatch.setattr(core, "_ensure_playwright", lambda: None)
    monkeypatch.setattr(core, "_expire_idle_sessions", expire)
    monkeypatch.setattr(core, "_new_page", new_page)
    if ws_support == "ready":
        asyncio.run(core._get_page())
        route = WebSocketRoute("ws://127.0.0.1:8765/probe")
        asyncio.run(callbacks["ws"](route))
        assert route.closed and not route.connected
        assert events == ["http", "ws", "page"]
        assert state.context is context
    else:
        with pytest.raises((AttributeError, RuntimeError)):
            asyncio.run(core._get_page())
        assert events == ["http", "closed"]
        assert state.browser is None and state.context is None and not state.pages
    assert options["service_workers"] == "block"
    assert "--disable-quic" in launch_options["args"]
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in launch_options["args"]
