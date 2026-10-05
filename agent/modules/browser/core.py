"""
Browser automation — Playwright-based, 16-operation engine.

Key features:
    - Accessibility snapshot (Playwright MCP-style structural page view)
    - Full base64 screenshot support (saved to workspace)
    - Tab management (list/new/close/switch)
    - Network & console introspection
    - JS evaluation
    - Form filling, typing, scrolling, hovering, key pressing

Architecture:
    Isolated browser instances per principal, workspace and session.
    Each synchronous action delegates to one persistent Playwright event loop.
    Screenshots saved as workspace artifacts rather than returned inline
    (base64 in tool result is truncated to prefix for brevity).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from collections import OrderedDict, deque
from agent.modules.browser.access import current_browser_scope, local_preview_allowed
from typing import Any

_log = logging.getLogger(__name__)

_playwright = None
_pw_instance = None
@dataclass
class _PageObservations:
    console: Any = field(default_factory=lambda: deque(maxlen=200))
    requests: Any = field(default_factory=OrderedDict)
    console_total: int = 0
    request_total: int = 0

    def record_console(self, kind: str, text: str) -> None:
        self.console_total += 1
        self.console.append({"type": kind, "text": text})

    def record_request(self, request) -> None:
        self.request_total += 1
        self.requests[request] = {"url": request.url, "method": request.method,
                                  "resource_type": request.resource_type, "status": "pending"}
        while len(self.requests) > 500:
            self.requests.popitem(last=False)

    def record_response(self, response) -> None:
        item = self.requests.get(response.request)
        if item is not None:
            item["status"] = response.status

    def record_failure(self, request) -> None:
        item = self.requests.get(request)
        if item is not None:
            item.update(status="failed", error=request.failure)


@dataclass
class _BrowserSession:
    browser: Any = None
    context: Any = None
    pages: dict[int, Any] = field(default_factory=dict)
    active_tab: int = 0
    refs: dict[str, str] = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)
    observations: dict[int, _PageObservations] = field(default_factory=dict)


_sessions: dict[Any, _BrowserSession] = {}


def _state() -> _BrowserSession:
    scope = current_browser_scope()
    state = _sessions.get(scope)
    if state is None:
        if len(_sessions) >= 16:
            raise RuntimeError("browser_session_capacity: close an existing session before opening another")
        state = _sessions[scope] = _BrowserSession()
    state.last_used = time.monotonic()
    return state


async def _close_session(state: _BrowserSession) -> None:
    if state.context:
        await state.context.close()
    if state.browser:
        await state.browser.close()
    state.pages.clear()
    state.refs.clear()
    state.observations.clear()


async def _expire_idle_sessions() -> None:
    now = time.monotonic()
    for scope, state in list(_sessions.items()):
        if scope != current_browser_scope() and now - state.last_used > 900:
            await _close_session(state)
            _sessions.pop(scope, None)


_loop: asyncio.AbstractEventLoop | None = None
_loop_thread: threading.Thread | None = None
_loop_lock = threading.Lock()
_browser_call_lock = threading.Lock()

# ── Ref mapping: ref_id → CSS selector ─────────────────────────────
# Snapshot assigns ref=e1, e2, ... to elements. The mapping stores
# the Playwright locator that was used to find each element, so
# click/type/hover can resolve ref → actual selector.


VIEWPORT = {"width": 1280, "height": 800}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT = 30000


def _ensure_playwright():
    global _playwright
    if _playwright is None:
        try:
            from playwright.async_api import async_playwright
            _playwright = async_playwright
        except ImportError:
            raise ImportError(
                "Playwright not installed. Run: pip install playwright && playwright install chromium"
            )


async def _get_page(tab_index: int | None = None) -> Any:
    """Get or create a browser page. Uses tab_index for multi-tab support."""
    global _pw_instance
    await _expire_idle_sessions()
    _ensure_playwright()

    if _state().browser is None:
        if _pw_instance is None:
            _pw_instance = await _playwright().start()
        _state().browser = await _pw_instance.chromium.launch(headless=True)
        _state().context = await _state().browser.new_context(
            viewport=VIEWPORT,
            user_agent=USER_AGENT,
        )
        scope = current_browser_scope()
        async def scoped_route(route):
            await _abort_blocked_browser_request(route, scope=scope)
        await _state().context.route("**/*", scoped_route)
        await _new_page(0)
        _state().active_tab = 0

    idx = tab_index if tab_index is not None else _state().active_tab

    if idx not in _state().pages or _state().pages[idx].is_closed():
        await _new_page(idx)

    _state().active_tab = idx
    return _state().pages[idx]


async def _new_page(index: int):
    state = _state()
    page = await state.context.new_page()
    observations = state.observations[index] = _PageObservations()
    page.on("console", lambda message: observations.record_console(message.type, message.text))
    page.on("pageerror", lambda error: observations.record_console("pageerror", str(error)))
    page.on("request", observations.record_request)
    page.on("response", observations.record_response)
    page.on("requestfailed", observations.record_failure)
    state.pages[index] = page
    return page


def _browser_event_loop() -> asyncio.AbstractEventLoop:
    """Return the one long-lived loop that owns every Playwright object."""
    global _loop, _loop_thread
    with _loop_lock:
        if _loop is not None and _loop.is_running():
            return _loop
        ready = threading.Event()

        def run_loop() -> None:
            global _loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            _loop = loop
            ready.set()
            loop.run_forever()

        _loop_thread = threading.Thread(
            target=run_loop,
            name="agent-browser-loop",
            daemon=True,
        )
        _loop_thread.start()
        ready.wait(timeout=5)
        if _loop is None:
            raise RuntimeError("browser event loop failed to start")
        return _loop


def _run(async_fn):
    """Run a Playwright coroutine on its persistent owning event loop."""
    future = None
    try:
        with _browser_call_lock:
            future = asyncio.run_coroutine_threadsafe(async_fn, _browser_event_loop())
            return future.result(timeout=180)
    except Exception as e:
        if future is not None:
            future.cancel()
        return {"ok": False, "error": str(e)[:300]}


def _browser_private_network_allowed() -> bool:
    import os
    return os.environ.get("LZCORE_BROWSER_ALLOW_PRIVATE_NETWORK", "").strip().lower() in ("true", "1", "yes", "on")


def _blocked_ip(value) -> bool:
    import ipaddress
    ip = value
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    shared_cgnat = ipaddress.ip_network("100.64.0.0/10")
    return bool(
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or ip in shared_cgnat
    )


def _validate_browser_url(url: str, *, scope=None) -> dict | None:
    """Reject non-public browser targets. DNS failure is a block, not a pass."""
    if not url:
        return None
    from urllib.parse import urlparse
    import ipaddress
    import socket

    try:
        parsed = urlparse(url.strip())
    except Exception as exc:
        return {"ok": False, "error": "invalid_url", "message": f"Malformed URL: {exc}"}

    scheme = (parsed.scheme or "").lower()
    if scheme in {"about", "blob", "chrome", "chrome-error"}:
        return None
    if scheme == "data" and _browser_private_network_allowed():
        return None
    if scheme not in ("http", "https"):
        return {
            "ok": False,
            "error": "url_blocked",
            "message": f"URL scheme '{scheme}' is prohibited. Only http and https are allowed in browser navigation.",
        }

    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname:
        return {"ok": False, "error": "invalid_url", "message": "URL has no hostname."}
    if _browser_private_network_allowed() or local_preview_allowed(url, scope):
        return None
    if hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or hostname.endswith(".local") or hostname.endswith(".internal") or hostname.endswith(".localhost"):
        return {
            "ok": False,
            "error": "url_blocked",
            "message": "Access to local/loopback network addresses is prohibited in browser tools.",
        }

    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        ip = None
    if ip is not None:
        if _blocked_ip(ip):
            return {
                "ok": False,
                "error": "url_blocked",
                "message": "Access to private or local network addresses is prohibited in browser tools.",
            }
        return None

    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except Exception:
        return {
            "ok": False,
            "error": "url_blocked",
            "message": f"Could not verify that {hostname} is a public address.",
        }
    if not addr_info:
        return {
            "ok": False,
            "error": "url_blocked",
            "message": f"Could not verify that {hostname} is a public address.",
        }
    for item in addr_info:
        try:
            resolved_ip = ipaddress.ip_address(item[4][0])
        except ValueError:
            return {
                "ok": False,
                "error": "url_blocked",
                "message": f"Could not verify that {hostname} is a public address.",
            }
        if _blocked_ip(resolved_ip):
            return {
                "ok": False,
                "error": "url_blocked",
                "message": f"Access to private or local network ({hostname} resolves to {resolved_ip}) is prohibited.",
            }
    return None


async def _abort_blocked_browser_request(route, *, scope=None) -> None:
    """Re-check the URL Playwright is about to fetch, including redirects."""
    blocked = _validate_browser_url(getattr(route.request, "url", "") or "", scope=scope)
    if blocked is not None:
        await route.abort()
        return
    await route.continue_()


# ──── Core Actions ──────────────────────────────────────────────────


def browser_navigate(url: str, wait_selector: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Navigate to URL. Returns page title, URL, and accessible text."""
    blocked = _validate_browser_url(url)
    if blocked is not None:
        return blocked
    async def _nav():
        page = await _get_page()
        await page.goto(url, timeout=timeout, wait_until="domcontentloaded")
        if wait_selector:
            await page.wait_for_selector(wait_selector, timeout=10000)
        title = await page.title()
        return {
            "ok": True, "url": url, "title": title,
            "status": "navigated",
        }
    return _run(_nav())


def browser_snapshot(selector: str = "body", compact: bool = True, max_elements: int = 50) -> dict:
    """Return a semantic DOM snapshot with ref-based element targeting.

    Each element gets a ref ID (e1, e2, ...). Use these ref IDs in
    click/type/hover/select_option.fill_form for precise targeting.
    """

    async def _snap():
        page = await _get_page()
        _state().refs.clear()
        title = await page.title()
        url = page.url
        limit = max(1, min(int(max_elements), 500))
        snapshot = await page.locator(selector or "body").evaluate(
            r"""(root, options) => {
              const roleByTag = {
                A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox',
                SELECT: 'combobox', IMG: 'img', NAV: 'navigation', MAIN: 'main',
                UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table',
                TR: 'row', TD: 'cell', TH: 'columnheader'
              };
              const semanticTags = new Set([
                'A','BUTTON','INPUT','TEXTAREA','SELECT','IMG','NAV','MAIN',
                'H1','H2','H3','H4','H5','H6','UL','OL','LI','TABLE','TR','TD','TH'
              ]);
              const cssPath = (element) => {
                if (element.id) return `#${CSS.escape(element.id)}`;
                const parts = [];
                let current = element;
                while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
                  const tag = current.tagName.toLowerCase();
                  const siblings = current.parentElement
                    ? Array.from(current.parentElement.children).filter(item => item.tagName === current.tagName)
                    : [];
                  const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
                  parts.unshift(tag + suffix);
                  current = current.parentElement;
                }
                return `body > ${parts.join(' > ')}`;
              };
              const nodes = [root, ...root.querySelectorAll('*')];
              const rows = [];
              for (const element of nodes) {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue;
                let role = (element.getAttribute('role') || roleByTag[element.tagName] || '').toLowerCase();
                if (/^H[1-6]$/.test(element.tagName)) role = 'heading';
                if (element.tagName === 'INPUT') {
                  const type = (element.getAttribute('type') || 'text').toLowerCase();
                  if (type === 'checkbox') role = 'checkbox';
                  else if (type === 'radio') role = 'radio';
                  else if (['button','submit','reset'].includes(type)) role = 'button';
                }
                const name = (
                  element.getAttribute('aria-label') || element.getAttribute('alt') ||
                  element.getAttribute('title') || element.getAttribute('placeholder') ||
                  element.innerText || element.textContent || ''
                ).replace(/\s+/g, ' ').trim().slice(0, 120);
                const actionable = Boolean(role) || semanticTags.has(element.tagName) || element.tabIndex >= 0;
                if (options.compact ? !actionable : (!actionable && !name)) continue;
                const row = { role: role || 'text', name, selector: cssPath(element) };
                if (['button','link','textbox','searchbox','combobox','listbox','checkbox','radio','switch','menuitem','option','tab','gridcell','treeitem'].includes(role)) {
                  row.disabled = element.matches(':disabled') || Boolean(element.closest('[aria-disabled="true"]'));
                  row.readonly = Boolean(element.readOnly) || element.getAttribute('aria-readonly') === 'true';
                }
                if ('value' in element && element.value) row.value = String(element.value).slice(0, 100);
                if (role === 'checkbox' || role === 'radio') row.checked = Boolean(element.checked);
                rows.push(row);
              }
              return { total: rows.length, elements: rows.slice(0, options.limit) };
            }""",
            {"compact": bool(compact), "limit": limit},
        )
        raw_elements = list((snapshot or {}).get("elements") or [])
        elements = []
        for item in raw_elements:
            ref = f"e{len(elements) + 1}"
            css_selector = str(item.pop("selector", "") or "")
            _state().refs[ref] = f"css:{css_selector}" if css_selector else ""
            elements.append({"ref": ref, **item})
        total = int((snapshot or {}).get("total") or len(elements))
        truncated = total > len(elements)

        return {
            "ok": True,
            "url": url,
            "title": title,
            "elements": elements,
            "count": len(elements),
            "total": total,
            "truncated": truncated,
            "compact": compact,
        }
    return _run(_snap())


def _parse_snapshot(node: dict, page: Any | None = None, depth: int = 0) -> list[dict]:
    """Recursively parse accessibility snapshot into flat elements with ref IDs.

    Also builds CSS selector via Playwright's ARIA locator for ref resolution.
    """
    if not node or depth > 15:
        return []
    elements: list[dict] = []
    role = (node.get("role") or "").lower()
    name = (node.get("name") or "").strip()
    value = (node.get("value") or "").strip()

    actionable = {"button", "link", "textbox", "searchbox", "combobox",
                  "listbox", "checkbox", "radio", "switch", "menuitem",
                  "option", "tab", "heading", "img", "navigation", "list",
                  "listitem", "gridcell", "row", "cell", "main", "region"}

    if role in actionable or name:
        ref = f"e{len(_state().refs) + 1}"

        # Validate the role locator before recording a semantic reference.
        if page and role and name:
            try:
                page.get_by_role(role, name=name)
                _state().refs[ref] = f"role:{role}:{name}"
            except Exception:
                _state().refs[ref] = ""

        elem = {
            "ref": ref,
            "role": role,
            "name": name[:120],
        }

        if role in ("textbox", "searchbox"):
            placeholder = (node.get("placeholder") or "").strip()
            if placeholder:
                elem["placeholder"] = placeholder[:100]
            if value:
                elem["value"] = value[:100]

        if role in ("combobox", "listbox"):
            if value:
                elem["value"] = value[:100]

        if node.get("checked") is not None:
            elem["checked"] = node.get("checked")

        elements.append(elem)

    for child in node.get("children", []):
        elements.extend(_parse_snapshot(child, page, depth + 1))

    return elements


def browser_screenshot(
    url: str = "",
    full_page: bool = False,
    as_file: bool = True,
    workspace_id: str = "",
) -> dict:
    """Take a screenshot. Saves to workspace file, returns file path.

    Args:
        url: Navigate to this URL first (optional if already on page).
        full_page: Capture entire scrollable page.
        as_file: Save to workspace as PNG file (True) or return base64 (False).
        workspace_id: Workspace ID for file storage.
    """
    if url:
        blocked = _validate_browser_url(url)
        if blocked is not None:
            return blocked
    async def _shot():
        page = await _get_page()
        if url:
            await page.goto(url, timeout=DEFAULT_TIMEOUT, wait_until="domcontentloaded")
        data = await page.screenshot(full_page=full_page, type="png")
        title = await page.title()
        current_url = page.url
        return data, title, current_url

    try:
        shot_result = _run(_shot())
        if isinstance(shot_result, dict) and shot_result.get("ok") is False:
            return shot_result
        img_bytes, title, current_url = shot_result
        b64 = base64.b64encode(img_bytes).decode()
        file_size = len(img_bytes)

        result = {
            "ok": True,
            "url": current_url,
            "title": title,
            "file_size_bytes": file_size,
            "format": "png",
            "full_page": full_page,
        }

        if as_file and workspace_id:
            filename = f"screenshot_{int(time.time())}.png"
            from storage.file_store import write_agent_output
            record = write_agent_output(
                workspace_id=workspace_id,
                content=img_bytes,
                logical_type="artifact_output",
                file_kind="image",
                title=filename.removesuffix(".png"),
                ext="png",
                source="browser_screenshot",
            )
            result["file_id"] = record.file_id
            result["saved_to"] = record.path
            result["filename"] = filename
            result["base64_preview"] = b64[:200]
        else:
            result.update({"file_id": "", "saved_to": "", "filename": ""})
            result["screenshot_base64"] = b64

        return result
    except Exception as e:
        return {"ok": False, "error": f"Screenshot failed: {str(e)[:200]}"}


def _locator_for_ref(page: Any, ref: str):
    """Resolve a current snapshot target without silently changing identity."""
    mapping = _state().refs.get(ref, "")
    if mapping.startswith("css:") and mapping[4:]:
        return page.locator(mapping[4:])
    if mapping and mapping.startswith("role:"):
        parts = mapping.split(":", 2)
        role = parts[1]
        name = parts[2] if len(parts) > 2 else ""
        return page.get_by_role(role, name=name, exact=True) if name else page.get_by_role(role)
    return None


def browser_click(selector: str = "", ref: str = "") -> dict:
    """Click an element. Prefer ref (from snapshot) over selector."""
    async def _click():
        page = await _get_page()
        target = _locator_for_ref(page, ref) if ref else page.locator(selector) if selector else None
        identity = {"target_ref": ref} if ref else {"target_selector": selector}
        def unavailable(code, message):
            return {"ok": False, "error_code": code, "error": message,
                    "interaction_sent": False, **identity}
        if target is None:
            return unavailable("target_not_found", "selector or a current snapshot ref is required; take a fresh snapshot")
        count = await target.count()
        if count != 1:
            return unavailable("target_not_unique" if count else "target_not_found",
                               f"target matches {count} elements; take a fresh snapshot and select one target")
        if not await target.is_visible():
            return unavailable("target_hidden", "target is hidden; take a fresh snapshot before acting")
        if not await target.is_enabled():
            return unavailable("target_disabled", "target is disabled; no click was sent; inspect current page state")
        await target.click(timeout=5000)
        return {"ok": True, **({"clicked_ref": ref} if ref else {"clicked": selector}),
                "title": await page.title(), "url": page.url}
    return _run(_click())


def browser_type(text: str, selector: str = "", ref: str = "", clear_first: bool = True) -> dict:
    """Type text into an element. Prefer ref (from snapshot) over selector."""
    async def _type():
        page = await _get_page()
        target = None
        target_label = ""

        if ref:
            mapping = _state().refs.get(ref, "")
            if mapping.startswith("css:") and mapping[4:]:
                target = page.locator(mapping[4:])
                target_label = f"ref:{ref}"
            elif mapping and mapping.startswith("role:"):
                parts = mapping.split(":", 2)
                role = parts[1]
                name = parts[2] if len(parts) > 2 else ""
                if name:
                    target = page.get_by_role(role, name=name)
                else:
                    target = page.get_by_role(role).first
                target_label = f"ref:{ref}"

        if target is None and selector:
            if clear_first:
                await page.fill(selector, "")
            await page.type(selector, text, delay=50)
            target_label = selector
        elif target is not None:
            if clear_first:
                await target.fill("")
            await target.type(text, delay=50)
        else:
            # A stale snapshot ref must never fall through to the focused
            # element: that can silently write into a different form field.
            return {"ok": False, "error": "selector or a valid snapshot ref is required"}

        return {"ok": True, "typed": text[:200], "target": target_label}
    return _run(_type())


def browser_hover(selector: str = "", ref: str = "") -> dict:
    """Hover over an element. Prefer ref over selector."""
    async def _hover():
        page = await _get_page()
        if ref:
            mapping = _state().refs.get(ref, "")
            if mapping.startswith("css:") and mapping[4:]:
                await page.locator(mapping[4:]).hover(timeout=5000)
                return {"ok": True, "hovered_ref": ref}
            if mapping and mapping.startswith("role:"):
                parts = mapping.split(":", 2)
                role = parts[1]
                name = parts[2] if len(parts) > 2 else ""
                if name:
                    await page.get_by_role(role, name=name).hover(timeout=5000)
                else:
                    await page.get_by_role(role).first.hover(timeout=5000)
                return {"ok": True, "hovered_ref": ref}
        if selector:
            await page.hover(selector, timeout=5000)
            return {"ok": True, "hovered": selector}
        return {"ok": False, "error": "selector or ref is required"}
    return _run(_hover())


def browser_select_option(value: str, selector: str = "", ref: str = "") -> dict:
    """Select an option. Prefer ref over selector."""
    async def _select():
        page = await _get_page()
        target_label = ""
        if ref:
            mapping = _state().refs.get(ref, "")
            if mapping.startswith("css:") and mapping[4:]:
                await page.locator(mapping[4:]).select_option(value)
                target_label = f"ref:{ref}"
            elif mapping and mapping.startswith("role:"):
                parts = mapping.split(":", 2)
                role = parts[1]
                name = parts[2] if len(parts) > 2 else ""
                locator = page.get_by_role(role, name=name) if name else page.get_by_role(role).first
                await locator.select_option(value)
                target_label = f"ref:{ref}"
        elif selector:
            await page.select_option(selector, value)
            target_label = selector
        else:
            return {"ok": False, "error": "selector or ref is required"}
        if not target_label:
            return {"ok": False, "error": f"ref {ref} not found"}
        return {"ok": True, "target": target_label, "selected": value}
    return _run(_select())


def browser_extract(url: str, selector: str = "body") -> dict:
    """Extract text content from a page element."""
    if url:
        blocked = _validate_browser_url(url)
        if blocked is not None:
            return blocked
    async def _extract():
        page = await _get_page()
        if url:
            await page.goto(url, timeout=DEFAULT_TIMEOUT, wait_until="domcontentloaded")
        text = await page.inner_text(selector)
        return {
            "ok": True, "url": page.url, "selector": selector,
            "text": text[:50000],
            "text_length": len(text),
        }
    return _run(_extract())


def browser_scroll(direction: str = "down", amount: int = 500) -> dict:
    """Scroll the page in one of the four declared directions."""
    async def _scroll():
        page = await _get_page()
        direction_normalized = str(direction or "down").lower()
        dx = amount if direction_normalized == "right" else -amount if direction_normalized == "left" else 0
        dy = amount if direction_normalized == "down" else -amount if direction_normalized == "up" else 0
        await page.evaluate("([x, y]) => window.scrollBy(x, y)", [dx, dy])
        scroll_y = await page.evaluate("window.scrollY")
        scroll_x = await page.evaluate("window.scrollX")
        return {
            "ok": True, "scrolled": direction_normalized, "amount": amount,
            "scroll_x": scroll_x, "scroll_y": scroll_y,
        }
    return _run(_scroll())


def browser_press_key(key: str) -> dict:
    """Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)."""
    async def _press():
        page = await _get_page()
        await page.keyboard.press(key)
        return {"ok": True, "pressed": key}
    return _run(_press())


def browser_evaluate(script: str) -> dict:
    """Execute JavaScript in the page context. Returns evaluated result."""
    import os
    if os.environ.get("LZCORE_BROWSER_EVALUATE_ENABLED", "").strip().lower() not in ("true", "1", "yes", "on"):
        return {
            "ok": False,
            "error": "browser_evaluate_disabled",
            "message": "browser_evaluate is disabled by default for security. Set LZCORE_BROWSER_EVALUATE_ENABLED=true to enable.",
        }
    async def _eval():
        page = await _get_page()
        result = await page.evaluate(script)
        # Serialize result safely
        try:
            result_str = json.dumps(result, default=str)
        except Exception:
            result_str = str(result)
        return {
            "ok": True, "script": script[:200],
            "result": result_str[:50000],
            "result_type": type(result).__name__,
        }
    return _run(_eval())


def browser_wait(wait_ms: int = 0, wait_text: str = "", timeout: int = 10000) -> dict:
    """Wait for a condition: time or text appearing on page."""
    async def _wait():
        page = await _get_page()
        if wait_text:
            await page.wait_for_selector(f"text={wait_text}", timeout=timeout)
            return {"ok": True, "waited_for": "text", "text": wait_text}
        else:
            ms = wait_ms or 1000
            await asyncio.sleep(ms / 1000.0)
            return {"ok": True, "waited_for": "time", "ms": ms}
    return _run(_wait())


# ──── Tab Management ────────────────────────────────────────────────


def browser_tabs(action: str = "list", tab_index: int = 0, url: str = "") -> dict:
    """Manage browser tabs.

    Args:
        action: list | new | close | switch
        tab_index: Target tab index.
        url: URL for new tabs.
    """
    if url:
        blocked = _validate_browser_url(url)
        if blocked is not None:
            return blocked
    async def _tabs():
        # tabs is a public entry point and must work before navigate/snapshot.
        # Initialize the shared browser context instead of dereferencing None.
        await _get_page()

        if action == "list":
            tabs = []
            for idx, page in list(_state().pages.items()):
                if not page.is_closed():
                    tabs.append({
                        "index": idx,
                        "url": page.url,
                        "title": await page.title(),
                        "active": idx == _state().active_tab,
                    })
            return {"ok": True, "tabs": tabs, "count": len(tabs)}

        elif action == "new":
            new_idx = max(_state().pages.keys()) + 1 if _state().pages else 0
            await _new_page(new_idx)
            if url:
                await _state().pages[new_idx].goto(url, timeout=DEFAULT_TIMEOUT)
            _state().active_tab = new_idx
            return {"ok": True, "tab_index": new_idx, "action": "created"}

        elif action == "close":
            if tab_index in _state().pages and not _state().pages[tab_index].is_closed():
                await _state().pages[tab_index].close()
                del _state().pages[tab_index]
                _state().observations.pop(tab_index, None)
                if _state().active_tab == tab_index:
                    _state().active_tab = next(iter(_state().pages.keys()), 0)
                return {"ok": True, "closed_tab": tab_index, "active_tab": _state().active_tab}
            return {"ok": False, "error": f"tab {tab_index} not found"}

        elif action == "switch":
            if tab_index in _state().pages and not _state().pages[tab_index].is_closed():
                _state().active_tab = tab_index
                page = _state().pages[tab_index]
                return {
                    "ok": True, "selected_tab": tab_index,
                    "url": page.url, "title": await page.title(),
                }
            return {"ok": False, "error": f"tab {tab_index} not found"}

        return {"ok": False, "error": f"unknown tab action: {action}"}

    return _run(_tabs())


# ──── Network & Console ──────────────────────────────────────────────


def browser_network() -> dict:
    """Return bounded actual request/response/failure observations for this tab."""
    async def _net():
        await _get_page()
        observations = _state().observations[_state().active_tab]
        requests = list(observations.requests.values())
        return {"ok": True, "requests": requests[-50:], "count": len(requests),
                "total": observations.request_total,
                "truncated": observations.request_total > 50}
    return _run(_net())


def browser_console() -> dict:
    """Return real console and uncaught-page-error events for this tab."""
    async def _con():
        await _get_page()
        observations = _state().observations[_state().active_tab]
        messages = list(observations.console)
        return {"ok": True, "messages": messages[-50:], "count": len(messages),
                "total": observations.console_total,
                "truncated": observations.console_total > 50}
    return _run(_con())


def browser_navigate_back() -> dict:
    """Go back in browser history."""
    async def _back():
        page = await _get_page()
        response = await page.go_back()
        if response is None:
            return {"ok": False, "error": "no browser history entry to navigate back to"}
        return {"ok": True, "url": page.url, "title": await page.title()}
    return _run(_back())


def browser_close() -> dict:
    """Close the browser and all tabs."""
    async def _close():
        state = _sessions.get(current_browser_scope())
        if state is not None:
            await _close_session(state)
            _sessions.pop(current_browser_scope(), None)
        return {"ok": True, "closed": True}
    return _run(_close())
