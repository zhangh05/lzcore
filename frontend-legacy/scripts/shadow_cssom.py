"""Find declarations a later rule silently kills, using the browser's CSSOM.

Parsing CSS by hand lost the @media nesting and produced garbage. The CSSOM
already knows the exact order, the exact selector, and whether a rule sits
inside a media query — and media queries add no specificity, which is the whole
reason a responsive override can be dead without anyone noticing.

Usage: python shadow_cssom.py [route]
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
ROUTE = sys.argv[1] if len(sys.argv) > 1 else "/workbench"

JS = r"""
() => {
  const out = [];
  let order = 0;
  for (const sheet of document.styleSheets) {
    let rs; try { rs = sheet.cssRules; } catch { continue; }
    const walk = (list, media) => {
      for (const r of list) {
        if (r.constructor.name === "CSSLayerBlockRule") { walk(r.cssRules, media); continue; }
        if (r.constructor.name === "CSSLayerStatementRule") continue;
        if (r.constructor.name === "CSSMediaRule") {
          walk(r.cssRules, r.conditionText || r.media.mediaText); continue;
        }
        if (r.constructor.name === "CSSSupportsRule") { walk(r.cssRules, media); continue; }
        if (r.constructor.name === "CSSKeyframesRule") continue;
        if (r.constructor.name !== "CSSStyleRule") continue;
        const decls = {};
        for (const p of r.style) decls[p] = r.style.getPropertyValue(p);
        out.push({ order: order++, sel: r.selectorText, media, decls,
                   text: r.cssText.slice(0, 160) });
      }
    };
    walk(rs, null);
  }
  return out;
}
"""

SPEC_JS = r"""
(sel) => {
  const s = sel.split(",")[0];
  const clean = s.replace(/:where\([^)]*\)/g, "")
                 .replace(/::[a-z-]+(\([^)]*\))?/g, "");
  const ids = (clean.match(/#[\w-]+/g) || []).length;
  const cls = (clean.match(/\.[\w-]+/g) || []).length
            + (clean.match(/\[[^\]]+\]/g) || []).length
            + (clean.match(/:(?!:)(?:not|is|has|where)\b/g) || []).length;
  const els = (clean.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, cls, els];
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 900})
    pg.goto(f"{BASE}{ROUTE}", wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)
    rules = pg.evaluate(JS)
    spec = {}
    for r in rules:
        if r["sel"] not in spec:
            spec[r["sel"]] = pg.evaluate(SPEC_JS, r["sel"])
    b.close()

json.dump(rules, open("/tmp/cssom_rules.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print(f"共 {len(rules)} 条规则（含媒体查询内的）\n")
print("══ 被后置规则压掉的声明 ══\n")

# group by selector
groups = {}
for r in rules:
    groups.setdefault(r["sel"], []).append(r)

rows = []
for sel, hits in groups.items():
    if len(hits) < 2:
        continue
    for i, a in enumerate(hits):
        for bb in hits[i + 1:]:
            if spec[sel] != spec[sel]:
                continue
            common = sorted(set(a["decls"]) & set(bb["decls"]))
            if not common:
                continue
            # only report when the later rule wins outright:
            #   - later in order,
            #   - same or higher specificity (same selector => equal),
            #   - and either unconditional, or its media is a superset
            if bb["media"] and bb["media"] != a["media"]:
                continue  # narrower/later media: not a blanket kill
            rows.append((sel, a, bb, common))

# Only cross-"position" ones are interesting; within the same file the last
# block is often a deliberate responsive section, so flag media mismatch loudest.
dead_media = [r for r in rows if r[1]["media"] and not r[2]["media"]]
print(f"【响应式覆盖被无条件后置规则压掉】{len(dead_media)} 处\n")
for sel, a, bb, common in dead_media[:40]:
    print(f"  {sel[:64]}")
    print(f"    死 (条件 {a['media']}): {', '.join(common)[:66]}")
    print(f"    活 (无条件, 顺序 #{bb['order']}): {bb['text'][:96]}")
    print()

plain = [r for r in rows if not r[1]["media"] and not r[2]["media"]]
print(f"\n【同特异性、无条件：前置规则为死代码】{len(plain)} 处\n")
for sel, a, bb, common in plain[:40]:
    print(f"  {sel[:64]}  →  死 #{a['order']} / 活 #{bb['order']}   {', '.join(common)[:66]}")
