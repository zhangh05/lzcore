"""Snapshot the computed typography of every heading on every route.

Used to prove that deleting a rule changes nothing: take one snapshot before
and one after, diff. Colour/weight/line-height are included because a heading
can look identical in size while quietly changing in all three.

Usage: python heading_probe.py <out.json> [route ...]
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
ROUTES = sys.argv[2:] or ["/workbench", "/runs", "/capabilities", "/knowledge", "/data",
                          "/memory", "/topology", "/diagnostics", "/settings", "/users"]

JS = r"""
() => {
  const props = ["fontSize", "fontWeight", "lineHeight", "color", "fontFamily", "letterSpacing"];
  const path = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      const c = String(n.className || "").trim().split(/\s+/)[0];
      if (c) s += "." + c;
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(">");
  };
  const out = [];
  for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const cs = getComputedStyle(el);
    const rec = { tag: el.tagName.toLowerCase(), path: path(el) };
    for (const p of props) rec[p] = cs[p];
    rec.text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 24);
    out.push(rec);
  }
  return out;
}
"""

result = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 900})
    for route in ROUTES:
        pg.goto(f"{BASE}{route}", wait_until="domcontentloaded")
        pg.wait_for_timeout(1800)
        result[route] = pg.evaluate(JS)
        print(f"  {route}: {len(result[route])} 个标题", file=sys.stderr)
    b.close()

json.dump(result, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"快照完成 -> {sys.argv[1]}  共 {sum(len(v) for v in result.values())} 个标题")
