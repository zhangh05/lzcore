"""Enumerate the rules whose winner changes when the shared sheets are layered.

For every element and every property, resolve the winning declaration twice:
once by the *original* cascade (specificity first, document order as the
tie-break) and once by the *layered* cascade (layer order first). Where the two
disagree, the layer split would move that property — which is the whole
question the split has to answer before it can be applied.

Walks every element in the document. The selective version, which only looked
at a handful of selectors, found one flip while the layout probe was already
reporting sub-pixel height changes on five routes; those had to be coming from
elements the shortlist did not measure.

The layer order is read from the CSS actually loaded rather than hardcoded —
see the comment on LAYER_RANK. A hardcoded order that has drifted from the
declaration measures a cascade nobody uses, and reports a clean result while
doing it.

Output: a clustered report on stdout, and the raw rows in
`/tmp/conflicts_all.json` for further analysis.

Requires the split to be applied first (otherwise every rule is in one layer
and there is nothing to compare). Use `apply_layer_split.py --apply`.
"""

import json
import sys

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from apply_layer_split import LAYERS

BASE = "http://127.0.0.1:5273"

# The layers this tool exists to evaluate. Taken from the script that applies the
# split rather than written out again here, so the two cannot drift apart — and
# so "the split is not applied" is detectable instead of silently reading as
# "no conflicts".
EXPECTED_LAYERS = sorted({layer for _, layer in LAYERS})

JS = r"""
() => {
  const EXPECTED_LAYERS = __EXPECTED_LAYERS__;
  // The order is read from the CSS that is actually loaded, not hardcoded. A
  // hardcoded rank that disagrees with reality silently measures a *different*
  // cascade: it reports conflicts that do not exist and misses the ones that
  // do, while looking perfectly healthy. That is how a stale `{typography: 4}`
  // (typography last) once contradicted a declaration that put typography
  // first, and every number the tool printed was about an order nobody used.
  //
  // Ranked by the order each layer's block first appears. The `@layer a, b, c;`
  // statement would be the more direct source, but the bundler splits it across
  // chunks — measured, only `@layer extension;` survived in one — so the
  // statement alone under-reports the order. First appearance is what the
  // browser falls back to, and it matches the declared order here.
  const LAYER_RANK = {};
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    const collect = (rs) => {
      for (const rule of rs) {
        const kind = rule.constructor.name;
        if (kind === "CSSLayerBlockRule") {
          if (!(rule.name in LAYER_RANK)) LAYER_RANK[rule.name] = Object.keys(LAYER_RANK).length;
          collect(rule.cssRules);
        } else if (kind === "CSSMediaRule" || kind === "CSSSupportsRule") {
          collect(rule.cssRules);
        }
      }
    };
    collect(list);
  }
  const rankOf = (layer) => {
    if (layer === null) return -1;
    const rank = LAYER_RANK[layer];
    if (rank === undefined) {
      // An unknown layer name means the map and the CSS have drifted apart.
      // Returning -1 would quietly treat it as "unlayered" and bury the
      // disagreement; the whole point of this tool is to not do that.
      throw new Error("layer `" + layer + "` 不在已加载的层里：" + Object.keys(LAYER_RANK).join(", "));
    }
    return rank;
  };
  // If the shared sheets are all still in one layer, there is nothing to
  // compare: every property resolves the same both ways, so the tool would
  // report "0 flips", which reads exactly like a clean bill of health. It is
  // not — it means the question was never asked. Refuse instead of returning a
  // reassuring zero. (Counting layers is not enough to detect this: the
  // `product`, `extension` and `responsive` layers are always present, so a
  // single-layer state still has three.)
  const missing = EXPECTED_LAYERS.filter((name) => !(name in LAYER_RANK));
  if (missing.length) {
    throw new Error("共享样式表还没拆层：缺少 " + missing.join(", ") +
                    "（当前只有 " + Object.keys(LAYER_RANK).join(", ") +
                    "）。先跑 apply_layer_split.py --apply。");
  }
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
  const newKey = (r) => [rankOf(r.layer), r.spec[0], r.spec[1], r.spec[2], r.order];

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
        try:
            got = page.evaluate(
                JS.replace("__EXPECTED_LAYERS__", json.dumps(EXPECTED_LAYERS)))
        except PlaywrightError as exc:
            # The page-side guard refused to measure. Report its reason rather
            # than a Playwright stack trace, because the reason is the useful
            # part and a traceback buries it.
            print(f"\n无法测量：{exc.message.splitlines()[0]}")
            browser.close()
            sys.exit(2)
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
