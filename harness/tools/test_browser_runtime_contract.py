"""Real sequential browser actions must share one healthy Playwright loop."""

import pytest
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from agent.modules.browser import core
from agent.modules.browser.access import browser_scope


@pytest.mark.parametrize("operation", ["click", "type", "hover", "select_option"])
def test_snapshot_ref_never_resolves_on_another_page_or_replacement(monkeypatch, operation):
    state = core._BrowserSession()
    original, other = object(), object()
    state.ref_page = original
    state.refs["old"] = object()
    monkeypatch.setattr(core, "_state", lambda: state)
    async def page():
        return other
    monkeypatch.setattr(core, "_get_page", page)
    monkeypatch.setattr(core, "_run", asyncio.run)
    handler = getattr(core, "browser_" + operation)
    args = {"type": {"text": "secret"}, "select_option": {"value": "other"}}.get(operation, {})
    result = handler(ref="old", selector="#same-path", **args)
    assert not result["ok"]


def test_detached_ref_cannot_click_replacement_at_same_selector(monkeypatch):
    state = core._BrowserSession()
    page = object()
    state.ref_page = page
    class Detached:
        async def evaluate(self, script):
            return False
        async def click(self, **kwargs):
            pytest.fail("detached ref clicked")
    state.refs["old"] = Detached()
    async def get_page():
        return page
    monkeypatch.setattr(core, "_state", lambda: state)
    monkeypatch.setattr(core, "_get_page", get_page)
    monkeypatch.setattr(core, "_run", asyncio.run)
    result = core.browser_click(ref="old")
    assert not result["ok"] and result["interaction_sent"] is False


@pytest.mark.parametrize("change", ["switch", "new", "navigate", "back"])
def test_page_changes_require_a_new_snapshot_and_refs_never_alias(monkeypatch, change):
    state = core._BrowserSession()
    handles = []
    class Locator:
        async def evaluate(self, script, options):
            return {"total": 1, "elements": [{"role": "button", "selector": "#same", "name": "Submit"}]}
        async def element_handle(self):
            handle = object()
            handles.append(handle)
            return handle
    class Page:
        url = "https://public.test/"
        def is_closed(self):
            return False
        async def title(self):
            return "Page"
        def locator(self, selector):
            return Locator()
        async def goto(self, *a, **kw):
            pass
        async def go_back(self):
            return object()
    state.pages = {0: Page(), 1: Page()}
    async def get_page():
        return state.pages[state.active_tab]
    async def new_page(index):
        state.pages[index] = Page()
    monkeypatch.setattr(core, "_get_page", get_page)
    monkeypatch.setattr(core, "_new_page", new_page)
    monkeypatch.setattr(core, "_state", lambda: state)
    monkeypatch.setattr(core, "_run", asyncio.run)
    monkeypatch.setattr(core, "_validate_browser_url", lambda *a, **k: None)
    old = core.browser_snapshot()["elements"][0]["ref"]
    if change in {"switch", "new"}:
        assert core.browser_tabs(action=change, tab_index=1)["ok"]
    elif change == "navigate":
        assert core.browser_navigate("https://other.test/")["ok"]
    else:
        assert core.browser_navigate_back()["ok"]
    assert old not in state.refs
    fresh = core.browser_snapshot()["elements"][0]["ref"]
    assert fresh != old and core._locator_for_ref(state.pages[state.active_tab], fresh) is handles[-1]
    assert core._locator_for_ref(state.pages[state.active_tab], old) is None


def test_evaluate_rejects_oversized_result_without_partial_json(monkeypatch):
    monkeypatch.setenv("LZCORE_BROWSER_EVALUATE_ENABLED", "true")
    async def evaluate(script):
        return {"long": "a" * 50000}
    async def get_page():
        return SimpleNamespace(evaluate=evaluate)
    monkeypatch.setattr(core, "_get_page", get_page)
    monkeypatch.setattr(core, "_run", asyncio.run)
    result = core.browser_evaluate("query")
    assert not result["ok"] and "result" not in result
    assert result["result_length"] > result["max_result_length"]


def test_wait_rejects_excess_budget_before_opening_browser(monkeypatch):
    monkeypatch.setattr(core, "_run", lambda _: pytest.fail("over-budget wait started"))
    assert not core.browser_wait(wait_ms=180000)["ok"]


def test_context_explicitly_disables_downloads(monkeypatch):
    state = core._BrowserSession()
    options = {}
    async def route(*args):
        pass
    async def new_context(**kwargs):
        options.update(kwargs)
        return SimpleNamespace(route=route, route_web_socket=route)
    async def launch(**kwargs):
        return SimpleNamespace(new_context=new_context)
    async def new_page(idx):
        state.pages[idx] = SimpleNamespace(is_closed=lambda: False)
    async def expire():
        pass
    monkeypatch.setattr(core, "_pw_instance", SimpleNamespace(chromium=SimpleNamespace(launch=launch)))
    monkeypatch.setattr(core, "_ensure_playwright", lambda: None)
    monkeypatch.setattr(core, "_state", lambda: state)
    monkeypatch.setattr(core, "_new_page", new_page)
    monkeypatch.setattr(core, "_expire_idle_sessions", expire)
    asyncio.run(core._get_page())
    assert options["accept_downloads"] is False


def test_parallel_scopes_initialize_playwright_only_once(monkeypatch):
    starts = []
    class Page:
        def on(self, *args):
            pass
        def is_closed(self):
            return False
    class Context:
        async def new_page(self):
            return Page()
        async def route(self, *args):
            pass
        async def route_web_socket(self, *args):
            pass
    class Browser:
        async def new_context(self, **kwargs):
            return Context()
    async def launch(**kwargs):
        return Browser()
    async def start():
        starts.append(True)
        await asyncio.sleep(0)
        return SimpleNamespace(chromium=SimpleNamespace(launch=launch))
    monkeypatch.setattr(core, "_sessions", {})
    monkeypatch.setattr(core, "_pw_instance", None)
    monkeypatch.setattr(core, "_pw_init_lock", None)
    monkeypatch.setattr(core, "_playwright", lambda: SimpleNamespace(start=start))
    monkeypatch.setattr(core, "_ensure_playwright", lambda: None)
    async def scoped(session):
        with browser_scope("test_ws", session):
            return await core._get_page()
    async def run():
        return await asyncio.gather(scoped("one"), scoped("two"))
    pages = asyncio.run(run())
    assert len(starts) == 1 and pages[0] is not pages[1]


def test_other_scope_and_close_bypass_running_browser_action(monkeypatch):
    started, cancelled = threading.Event(), threading.Event()
    async def long_action():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    def first():
        with browser_scope("test_ws", "busy"):
            return core._run(long_action())
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(first)
        assert started.wait(2)
        try:
            with browser_scope("other_ws", "idle"):
                assert core._run(asyncio.sleep(0, result={"ok": True}))["ok"]
            with browser_scope("test_ws", "busy"):
                assert core.browser_close()["ok"]
            assert cancelled.wait(2)
            cancelled_result = pending.result(timeout=2)
            assert not cancelled_result["ok"] and cancelled_result["execution_may_continue"]
        finally:
            with browser_scope("test_ws", "busy"):
                core.browser_close()


def test_browser_lock_wait_counts_toward_same_deadline(monkeypatch):
    started = threading.Event()
    async def long_action():
        started.set()
        await asyncio.Event().wait()
    def first():
        with browser_scope("test_ws", "deadline"):
            return core._run(long_action())
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(first)
        assert started.wait(2)
        monkeypatch.setattr(core, "BROWSER_CALL_TIMEOUT", .05)
        executed = []
        async def queued():
            executed.append(True)
            return {"ok": True}
        try:
            with browser_scope("test_ws", "deadline"):
                assert not core._run(queued())["ok"]
            assert not executed
        finally:
            with browser_scope("test_ws", "deadline"):
                core.browser_close()
            pending.result(timeout=2)


def test_browser_runtime_cancellation_stops_scope_and_marks_uncertain_effects():
    from core.tools.context import bind_runtime_cancel_check, reset_runtime_cancel_check
    cancel, started, stopped = threading.Event(), threading.Event(), threading.Event()
    async def action():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    def invoke():
        token = bind_runtime_cancel_check(cancel.is_set)
        try:
            with browser_scope("test_ws", "cancel"):
                return core._run(action())
        finally:
            reset_runtime_cancel_check(token)
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(invoke)
        assert started.wait(2)
        cancel.set()
        cancelled = result.result(timeout=2)
    assert stopped.wait(2)
    assert not cancelled["ok"] and cancelled["cancelled"]
    assert cancelled["execution_may_continue"] and not cancelled["automatic_retry_allowed"]
    with browser_scope("test_ws", "cancel"):
        assert core._run(asyncio.sleep(0, result={"ok": True}))["ok"]


def test_cancelled_browser_request_does_not_start():
    from core.tools.context import bind_runtime_cancel_check, reset_runtime_cancel_check
    called = []
    async def action():
        called.append(True)
    token = bind_runtime_cancel_check(lambda: True)
    try:
        result = core._run(action())
    finally:
        reset_runtime_cancel_check(token)
    assert result["cancelled"] and not result["execution_may_continue"] and not called

from agent.modules.browser.core import (
    browser_click,
    browser_close,
    browser_navigate,
    browser_snapshot,
    browser_select_option,
    browser_type,
    browser_tabs,
)


def test_navigate_snapshot_and_ref_click_share_one_browser_session(monkeypatch):
    monkeypatch.setenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", "true")
    try:
        navigated = browser_navigate(
            'data:text/html,<main><h1>Hello</h1><button id="go">Go</button><input aria-label="Name"></main>'
        )
        if navigated.get("ok") is False and _browser_runtime_unavailable(navigated):
            pytest.skip(navigated.get("error") or "browser runtime unavailable")
        assert navigated["ok"] is True

        snapshot = browser_snapshot(selector="main", compact=True, max_elements=10)
        assert snapshot["ok"] is True
        assert snapshot["count"] >= 3
        button = next(item for item in snapshot["elements"] if item["role"] == "button")
        textbox = next(item for item in snapshot["elements"] if item["role"] == "textbox")
        assert "checked" not in textbox

        clicked = browser_click(ref=button["ref"])
        assert clicked["ok"] is True
        assert browser_type("unsafe", ref="e999999")["ok"] is False
        assert browser_select_option("missing", ref="e999999")["ok"] is False
    finally:
        browser_close()


def test_public_switch_tab_action_is_implemented_by_browser_runtime(monkeypatch):
    monkeypatch.setenv("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", "true")
    try:
        created = browser_tabs(action="new", url="data:text/html,<title>Second</title>")
        if created.get("ok") is False and _browser_runtime_unavailable(created):
            pytest.skip(created.get("error") or "browser runtime unavailable")
        assert created["ok"] is True
        switched = browser_tabs(action="switch", tab_index=created["tab_index"])
        assert switched["ok"] is True
        assert switched["selected_tab"] == created["tab_index"]
    finally:
        browser_close()


def _browser_runtime_unavailable(result: dict) -> bool:
    error = str(result.get("error") or "").lower()
    return any(
        marker in error
        for marker in (
            "playwright not installed",
            "executable doesn't exist",
            "playwright install",
            "host system is missing dependencies",
        )
    )
