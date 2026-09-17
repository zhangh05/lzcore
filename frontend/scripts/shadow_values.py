"""Print the value on each side of a shadowed responsive override.

shadow_cssom.py names the property that died; this prints what the responsive
rule wanted and what the later unconditional rule actually imposed, so each case
can be judged on its numbers instead of its selector.

Two things it does that a naive comparison does not:

  * It splits selector lists. A rule written as
        .chat-bubble, .chat-bubble.user, .chat-result-inline { width: ... }
    compared as one string never matches the later `.chat-result-inline { ... }`,
    so a dead declaration hides inside a grouped rule. Comparing selector by
    selector finds it — and also shows that such a declaration is only
    *partially* dead, which is why the fix has to split the rule.

  * It reports the media condition per case, because "dead at <=900" and "dead at
    <=640" are different repairs.

Matching on identical selector text also guarantees identical specificity, which
is the assumption the whole check rests on.

Usage: python shadow_values.py [route]
"""

import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
ROUTE = sys.argv[1] if len(sys.argv) > 1 else "/workbench"

JS = r"""
() => {
  const rules = [];
  let order = 0;
  for (const sheet of document.styleSheets) {
    let rs; try { rs = sheet.cssRules; } catch { continue; }
    const walk = (list, media, layer) => {
      for (const r of list) {
        const name = r.constructor.name;
        if (name === "CSSLayerBlockRule") { walk(r.cssRules, media, (layer ? layer + "." : "") + r.name); continue; }
        if (name === "CSSLayerStatementRule") continue;
        if (name === "CSSMediaRule") { walk(r.cssRules, r.conditionText || r.media.mediaText, layer); continue; }
        if (name === "CSSSupportsRule") { walk(r.cssRules, media, layer); continue; }
        if (name !== "CSSStyleRule") continue;
        const decls = {};
        for (const p of r.style) decls[p] = r.style.getPropertyValue(p);
        // Split the selector list: each part competes on its own.
        const sels = r.selectorText.split(",").map((s) => s.trim()).filter(Boolean);
        rules.push({ order: order++, sels, media, layer, decls, raw: r.selectorText });
      }
    };
    walk(rs, null, null);
  }

  const out = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r.media) continue;
    for (const sel of r.sels) {
      for (const prop of Object.keys(r.decls)) {
        for (let j = i + 1; j < rules.length; j++) {
          const s = rules[j];
          if (s.media) continue;
          if (!s.sels.includes(sel)) continue;
          if (!(prop in s.decls)) continue;
          if (s.decls[prop] === r.decls[prop]) break;   // same value: nothing visible is lost
          out.push({
            sel, media: r.media, prop,
            wanted: r.decls[prop], got: s.decls[prop],
            deadOrder: r.order, liveOrder: s.order, layer: s.layer,
            grouped: r.sels.length > 1 ? r.raw : null,
          });
          break;
        }
      }
    }
  }
  return out;
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    pg.goto(BASE + ROUTE, wait_until="domcontentloaded")
    pg.wait_for_timeout(3500)
    rows = pg.evaluate(JS)
    b.close()

groups = {}
for r in rows:
    groups.setdefault((r["sel"], r["media"]), []).append(r)

print(f"共 {len(rows)} 条被压掉的响应式声明，分属 {len(groups)} 个块\n")
grouped = 0
for (sel, media), items in sorted(groups.items(), key=lambda kv: kv[1][0]["deadOrder"]):
    tag = ""
    if items[0]["grouped"]:
        tag = f"   【分组规则：{items[0]['grouped']}】"
        grouped += 1
    print(f"── {sel}   条件 {media}   被 #{items[0]['liveOrder']} 压掉{tag}")
    for it in items:
        print(f"     {it['prop']:<22} 想给 {it['wanted']:<30} 实际 {it['got']}")
print(f"\n其中 {grouped} 个块位于分组选择器内（需拆分规则才能修）")
