"""Same as cascade_conflicts.py but walks *every* element in the document.

The selective version only found one flip, yet the probe still reported sub-pixel
height changes on five routes. Those must come from elements the probe does not
measure, so this version inverts the lookup: one querySelectorAll per rule, then
resolve every property for every element and report the winner flips.
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

JS = r"""
() => {
  // The layer order under test. Edit this to try a different order; the tool
  // resolves every property against it, so an order can be evaluated without
  // rebuilding anything.
  const LAYER_RANK = { base: 0, shell: 1, console: 2, workbench: 3, typography: 4, runtime: 5, rhythm: 6 };
  const spec = (sel) => {
    const first = sel.split(",")[0];
    const ids = (first.match(/#[\w-]+/g) || []).length;
    const cls = (first.match(/\.[\w-]+/g) || []).length
              + (first.match(/\[[^\]]+\]/g) || []).length
              + (first.match(/(?<!:):(?!:)[\w-]+/g) || []).length;
    let els = (first.replace(/\.[\w-]+|#[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, " ")
                    .match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    els += (first.match(/::[\w-]+/g) || []).length;
    return [ids, cls, els];
  };

  const rules = [];
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    const walk = (rs, layer) => {
      for (const rule of rs) {
        const kind = rule.constructor.name;
        if (kind === "CSSLayerBlockRule") { walk(rule.cssRules, (layer ? layer + "." : "") + rule.name); continue; }
        if (kind === "CSSLayerStatementRule") continue;
        if (kind === "CSSMediaRule") {
          try { if (!window.matchMedia(rule.conditionText).matches) continue; } catch { continue; }
          walk(rule.cssRules, layer); continue;
        }
        if (kind === "CSSSupportsRule") { walk(rule.cssRules, layer); continue; }
        if (kind !== "CSSStyleRule") continue;
        rules.push({ sel: rule.selectorText, css: rule.style.cssText, layer: layer || null, order: rules.length });
      }
    };
    walk(list, null);
  }
  for (const r of rules) r.spec = spec(r.sel);

  // element -> rule indices
  const owners = new Map();
  rules.forEach((r, ri) => {
    let nodes; try { nodes = document.querySelectorAll(r.sel); } catch { return; }
    for (const n of nodes) {
      let arr = owners.get(n); if (!arr) owners.set(n, arr = []);
      arr.push(ri);
    }
  });

  const out = [];
  const cmp = (a, b, kf) => { const ka = kf(a), kb = kf(b);
    for (let d = 0; d < ka.length; d++) if (ka[d] !== kb[d]) return ka[d] - kb[d]; return 0; };
  const oldKey = (r) => [r.spec[0], r.spec[1], r.spec[2], r.order];
  const newKey = (r) => [LAYER_RANK[r.layer] ?? -1, r.spec[0], r.spec[1], r.spec[2], r.order];

  for (const [el, idxs] of owners) {
    if (idxs.length < 2) continue;
    const cand = {};
    for (const ri of idxs) {
      const r = rules[ri];
      for (const decl of r.css.split(";")) {
        const i = decl.indexOf(":");
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        const value = decl.slice(i + 1).trim();
        if (!prop || prop.startsWith("--")) continue;
        (cand[prop] = cand[prop] || []).push({ ri, value });
      }
    }
    for (const prop of Object.keys(cand)) {
      const list = cand[prop];
      if (list.length < 2) continue;
      let bestOld = list[0], bestNew = list[0];
      for (const c of list) {
        const r = rules[c.ri];
        if (cmp(r, rules[bestOld.ri], oldKey) > 0) bestOld = c;
        if (cmp(r, rules[bestNew.ri], newKey) > 0) bestNew = c;
      }
      if (bestOld.ri === bestNew.ri) continue;
      const a = rules[bestOld.ri], b = rules[bestNew.ri];
      // Resolve both declarations to real values: an inline declaration outranks
      // every layer, so setting it temporarily gives the value each side means.
      const cs = getComputedStyle(el);
      const resolvedNew = cs[prop];
      const previousInline = el.style.getPropertyValue(prop);
      const previousPriority = el.style.getPropertyPriority(prop);
      let resolvedOld;
      try {
        el.style.setProperty(prop, bestOld.value, previousPriority);
        resolvedOld = getComputedStyle(el)[prop];
      } catch { resolvedOld = bestOld.value; }
      if (previousInline) el.style.setProperty(prop, previousInline, previousPriority);
      else el.style.removeProperty(prop);
      if (resolvedOld === resolvedNew && bestOld.value !== bestNew.value) continue;  // same pixels, different spelling
      out.push({
        prop, classes: (el.className || "").toString().slice(0, 70),
        tag: el.tagName, oldValue: bestOld.value, newSel: b.sel, newLayer: b.layer,
        resolvedOld, resolvedNew, oldSel: a.sel, oldLayer: a.layer,
        path: (() => { const p = []; let n = el;
          while (n && n !== document.body && p.length < 4) { p.unshift(n.tagName.toLowerCase() + (n.className ? "." + String(n.className).split(" ")[0] : "")); n = n.parentElement; }
          return p.join(" > "); })(),
      });
    }
  }
  return out;
}
"""

routes = sys.argv[1:] or ["/workbench", "/runs", "/data", "/knowledge", "/memory",
                          "/capabilities", "/diagnostics", "/settings", "/users", "/login"]
rows = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    for route in routes:
        page.goto(f"{BASE}{route}", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        got = page.evaluate(JS)
        for r in got:
            r["route"] = route
        rows.extend(got)
        print(f"{route}: {len(got)} flips", file=sys.stderr)
    browser.close()

clusters = {}
for r in rows:
    key = (r["prop"], r["oldSel"], r["newSel"], r["oldLayer"], r["newLayer"], r["oldValue"], r["resolvedNew"])
    clusters.setdefault(key, []).append(r)

print(f"\n总翻转 {len(rows)} 处，聚类后 {len(clusters)} 类\n")
for key, hits in sorted(clusters.items(), key=lambda kv: -len(kv[1])):
    prop, oldSel, newSel, oldLayer, newLayer, oldValue, newValue = key
    print(f"[{len(hits)}x] {prop}:  {hits[0]['resolvedOld']}  ->  {hits[0]['resolvedNew']}")
    print(f"      OLD ({oldLayer}): {oldValue}   <- {oldSel[:95]}")
    print(f"      NEW ({newLayer}): {newValue}   <- {newSel[:95]}")
    seen = set()
    for h in hits:
        tag = f"{h['route']} {h['path']}"
        if tag in seen:
            continue
        seen.add(tag)
        print(f"         {tag}")
        if len(seen) >= 4:
            break
    print()
json.dump(rows, open("/tmp/conflicts_all.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
