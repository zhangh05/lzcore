"""Dump the geometry of every element on a route, keyed by a stable path.

Two dumps taken before and after a change can be diffed element by element, so a
shift anywhere on the page is visible — not only on the 25 selectors the layout
probe samples.

Usage: python dump_boxes.py <output.json> [route ...]
"""

import json
import sys

from playwright.sync_api import sync_playwright

ROUTES = ["/workbench", "/runs", "/data", "/knowledge", "/memory",
          "/capabilities", "/diagnostics", "/settings", "/users", "/login"]

JS = """
() => {
  const out = {};
  const path = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement && parts.length < 8) {
      let idx = 0, sib = n;
      while (sib.previousElementSibling) { sib = sib.previousElementSibling; idx++; }
      parts.unshift(n.tagName.toLowerCase() + (n.className ? "." + String(n.className).trim().split(/\\s+/).join(".") : "") + "[" + idx + "]");
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cs = getComputedStyle(el);
    out[path(el)] = [
      Math.round(r.x * 2) / 2, Math.round(r.y * 2) / 2,
      Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2,
      cs.fontSize, cs.lineHeight, cs.padding, cs.gap, cs.fontFamily.slice(0, 24),
    ];
  }
  return out;
}
"""

out_path = sys.argv[1]
routes = sys.argv[2:] or ROUTES
result = {}
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    for route in routes:
        page.goto(f"http://127.0.0.1:5273{route}", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        result[route] = page.evaluate(JS)
        print(f"  {route}: {len(result[route])} 个元素", file=sys.stderr)
    browser.close()
json.dump(result, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("dumped ->", out_path)
