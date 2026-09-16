"""Structural layout probe.

Run against a live frontend (default http://127.0.0.1:5273):
    python frontend/scripts/layout_probe.py /tmp/before.json
    # make a CSS change, rebuild
    python frontend/scripts/layout_probe.py /tmp/after.json
    python frontend/scripts/layout_diff.py /tmp/before.json /tmp/after.json

A pure cascade refactor must report 0 layout differences; an intentional change
must be explainable one line at a time. This is what caught the layer split
moving 207 boxes, and what proved the single-layer configuration was
behaviour-preserving.

A pure CSS-cascade refactor must not move a single box. This records the real
geometry and the computed cascade-sensitive properties of key elements on every
route, so before/after can be diffed numerically instead of by eye.

Usage: python layout_probe.py <output.json>
"""

import json
import sys

from playwright.sync_api import sync_playwright

ROUTES = [
    ("workbench", "/workbench"),
    ("runs", "/runs"),
    ("data", "/data"),
    ("knowledge", "/knowledge"),
    ("memory", "/memory"),
    ("capabilities", "/capabilities"),
    ("diagnostics", "/diagnostics"),
    ("settings", "/settings"),
    ("users", "/users"),
    ("login", "/login"),
]

# selector -> the properties that decide whether the cascade still resolves the
# same way. Geometry is rounded so sub-pixel noise does not create false diffs.
PROBE_JS = """
() => {
  const selectors = [
    ".app-shell", ".app-header", ".app-nav", ".app-sidebar", ".app-main",
    ".page", ".page-header", ".page-body",
    ".wb-shell", ".wb-header", ".wb-input-bar", ".task-progress-panel",
    ".login-panel", ".login-page",
    ".split-shell", ".split-detail", ".card", ".stat-grid", ".btn", ".input",
    ".empty", ".hero", ".data-table", ".segmented",
  ];
  const round = (n) => Math.round(n * 2) / 2;
  const props = ["display", "gridTemplateRows", "gridTemplateColumns", "fontSize",
                 "fontWeight", "backgroundColor", "color", "borderRadius", "height", "width"];
  const out = {};
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 4);
    if (!nodes.length) continue;
    out[selector] = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const computed = getComputedStyle(node);
      const entry = { box: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)] };
      for (const prop of props) entry[prop] = computed[prop];
      return entry;
    });
  }
  return out;
}
"""

result = {}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    for name, path in ROUTES:
        try:
            page.goto(f"http://127.0.0.1:5273{path}", wait_until="domcontentloaded")
            page.wait_for_timeout(2500)
            result[name] = page.evaluate(PROBE_JS)
        except Exception as exc:  # a route that fails to render is itself a finding
            result[name] = {"__error__": str(exc)}
    browser.close()

result["__pageerrors__"] = errors[:10]
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=1, sort_keys=True)
print("probed", len(result) - 1, "routes ->", sys.argv[1])
