"""Measure what the narrow-width cases actually render, per route and width.

Why this exists
---------------
`shadow_cssom.py` finds a declaration that a later rule kills, and
`shadow_values.py` prints the two values. Neither answers the question that
matters, which is whether the *rendered* result is wrong.

`.app-nav { display: none }` at <=900px is dead in global.css, and reading that
alone looks like a visible bug — the page nav staying on screen at tablet width
while the drawer also offers it. It is not a bug: product-shell.css carries its
own `@media (max-width: 900px) { .app-nav { display: none } }`, which matches at
the same width and is later, so the nav is hidden either way. The first copy is
redundant, not missing. "Different value" is not "different outcome".

So this probe asks the browser instead of the rule list. It records the computed
value of each watched property at each width, and the diff between two runs is
the only thing worth acting on: a case whose value does not move needs no
repair, whatever the cascade says about it.

Usage:
  python responsive_probe.py before.json
  python responsive_probe.py after.json
  python responsive_probe.py --diff before.json after.json
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

ROUTES = ["/workbench", "/runs", "/data", "/users", "/capabilities",
          "/knowledge", "/settings", "/topology", "/diagnostics", "/memory", "/login"]

WIDTHS = [1200, 1180, 900, 768, 760, 640, 620]

# selector -> properties whose narrow-width value we care about
WATCH = {
    ".app-nav": ["display"],
    ".app-nav-item": ["padding-left", "padding-right"],
    ".brand": ["min-width", "padding-left"],
    ".brand-text small": ["display"],
    ".brand-text > span": ["font-size"],
    ".app-header": ["padding"],
    ".app-sidebar": ["border-right-color"],
    ".page-header": ["min-height", "padding"],
    ".page-body": ["padding"],
    ".split-shell > aside": ["border-right-color"],
    ".message-row": ["column-gap", "row-gap"],
    ".message-stack": ["max-width"],
    ".chat-result-inline": ["width", "max-width"],
    ".wb-header": ["padding"],
    ".wb-input-bar": ["padding"],
    ".ui-filter-bar": ["padding"],
    ".ui-detail-panel": ["padding"],
    ".stat-grid": ["column-gap", "row-gap", "padding"],
    ".stat-value": ["font-size"],
    ".data-overview": ["padding"],
    ".data-center > .data-lifecycle-grid": ["padding"],
    ".data-center > .data-relations-grid": ["padding"],
    ".data-split": ["grid-template-columns"],
    ".user-access-list": ["border-right-color"],
    ".user-access-editor": ["padding"],
}

JS = r"""
(spec) => {
  const out = {};
  for (const [sel, props] of Object.entries(spec)) {
    let el = null;
    try { el = document.querySelector(sel); } catch { continue; }
    if (!el) continue;
    const cs = getComputedStyle(el);
    const rec = {};
    for (const p of props) rec[p] = cs.getPropertyValue(p);
    rec["__rect"] = (() => { const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })();
    rec["__visible"] = el.checkVisibility();
    out[sel] = rec;
  }
  return out;
}
"""


def capture(path):
    data = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for w in WIDTHS:
            for route in ROUTES:
                pg = b.new_page(viewport={"width": w, "height": 800})
                try:
                    pg.goto(BASE + route, wait_until="domcontentloaded")
                    pg.wait_for_timeout(2200)
                    got = pg.evaluate(JS, WATCH)
                except Exception as exc:  # a route that will not load is not a finding
                    got = {"__error": str(exc)}
                data[f"{w}|{route}"] = got
                pg.close()
        b.close()
    with open(path, "w") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    print(f"已写入 {path}（{len(data)} 个 宽度×路由 组合）")


def diff(a_path, b_path):
    a = json.load(open(a_path))
    b = json.load(open(b_path))
    keys = sorted(set(a) | set(b))
    changed = []
    for k in keys:
        ra, rb = a.get(k, {}), b.get(k, {})
        for sel in sorted(set(ra) | set(rb)):
            if sel == "__error":
                continue
            va, vb = ra.get(sel, {}), rb.get(sel, {})
            for prop in sorted(set(va) | set(vb)):
                if prop.startswith("__"):
                    continue
                if va.get(prop) != vb.get(prop):
                    changed.append((k, sel, prop, va.get(prop), vb.get(prop)))
    print(f"共 {len(changed)} 处计算值变化\n")
    last = None
    for k, sel, prop, va, vb in changed:
        if k != last:
            print(f"── {k}")
            last = k
        print(f"     {sel:<40} {prop:<20} {va}  ->  {vb}")
    return changed


if __name__ == "__main__":
    if sys.argv[1] == "--diff":
        diff(sys.argv[2], sys.argv[3])
    else:
        capture(sys.argv[1])
