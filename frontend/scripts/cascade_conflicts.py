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

Specificity is computed per element, over every selector in a rule's list that
matches — see the comment on `spec`. Reading only the first selector of a list
under-scores rules like `.page-header, .page-header.ui-page-header`, and an
under-scored rule turns a real flip into a false "no flip".

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
  // Split a selector list on its *top-level* commas. `:is(pre, table)` holds a
  // comma that is not a list separator, so a plain `split(",")` invents two
  // selectors that do not exist.
  const splitList = (sel) => {
    const out = []; let depth = 0, cur = "";
    for (const ch of sel) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };
  // Same idea for a value: whitespace inside `var(...)`/`calc(...)` is not a
  // separator, so `calc(1px + 2px) 0` is two components, not four.
  const splitWords = (v) => {
    const out = []; let depth = 0, cur = "";
    for (const ch of v) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  // A shorthand and a longhand compete, but the loop below compares property
  // *names* — so `padding` in one rule and `padding-top` in another looked like
  // two unrelated properties and the flip went unreported.
  // `.capability-center .page-body { padding-top: var(--space-4) }` (0,2,0) lost
  // to typography's `padding: …` (0,1,0) once the sheets were layered, and the
  // only thing that noticed was the layout probe, as a 4px shift on one route.
  // Expanding the common shorthands puts both in the same bucket.
  const box4 = (v) => {
    const p = splitWords(v);
    if (p.length === 1) return [p[0], p[0], p[0], p[0]];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 3) return [p[0], p[1], p[2], p[1]];
    return [p[0], p[1], p[2], p[3]];
  };
  const boxPair = (v) => { const p = splitWords(v); return [p[0], p.length > 1 ? p[1] : p[0]]; };
  const SIDES = ["top", "right", "bottom", "left"];
  const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];
  const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
  const BORDER_WIDTHS = /^(thin|medium|thick|[\d.]+[a-z%]*)$/;
  const SHORTHANDS = {
    padding: (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[`padding-${s}`] = q[i]; }); return o; },
    margin: (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[`margin-${s}`] = q[i]; }); return o; },
    "border-radius": (v) => { const q = box4(v); const o = {};
      CORNERS.forEach((c, i) => { o[`border-${c}-radius`] = q[i]; }); return o; },
    inset: (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[s] = q[i]; }); return o; },
    gap: (v) => { const [a, b] = boxPair(v); return { "row-gap": a, "column-gap": b }; },
    overflow: (v) => { const [a, b] = boxPair(v); return { "overflow-x": a, "overflow-y": b }; },
    border: (v) => {
      let w = "medium", s = "none", c = "currentcolor";
      for (const t of splitWords(v)) {
        if (BORDER_WIDTHS.test(t)) w = t;
        else if (BORDER_STYLES.test(t)) s = t;
        else c = t;
      }
      const o = {};
      for (const side of SIDES) {
        o[`border-${side}-width`] = w;
        o[`border-${side}-style`] = s;
        o[`border-${side}-color`] = c;
      }
      return o;
    },
    "border-width": (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[`border-${s}-width`] = q[i]; }); return o; },
    "border-style": (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[`border-${s}-style`] = q[i]; }); return o; },
    "border-color": (v) => { const q = box4(v); const o = {};
      SIDES.forEach((s, i) => { o[`border-${s}-color`] = q[i]; }); return o; },
  };
  const expandDecl = (prop, value) => {
    const fn = SHORTHANDS[prop];
    if (!fn) return null;
    try { return fn(value); } catch { return null; }
  };
  const maxSpec = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? a : b;
    return a;
  };
  // Specificity of one complex selector.
  //
  // The version this replaces read `sel.split(",")[0]` and counted `:is(...)` as
  // a plain class. Both are wrong in a way that produces false *agreement*: a
  // rule written `.page-header, .page-header.ui-page-header` is (0,2,0) for an
  // element carrying both classes, but scored (0,1,0) here — so the tool saw
  // typography.css's `.page-header` (0,1,0, later) as the pre-split winner when
  // console-system.css's copy had actually been winning all along, and reported
  // "no flip" while the layout probe measured the header growing 4px on five
  // routes. A rule that looks weaker than it is hides exactly the conflicts this
  // tool exists to find.
  const specCache = new Map();
  const spec = (sel) => {
    const hit = specCache.get(sel);
    if (hit) return hit;
    let ids = 0, cls = 0, els = 0, i = 0;
    const n = sel.length;
    while (i < n) {
      const ch = sel[i];
      if (ch === ":") {
        if (sel[i + 1] === ":") { els += 1; i += 2; continue; }
        let j = i + 1, name = "";
        while (j < n && /[\w-]/.test(sel[j])) { name += sel[j]; j++; }
        let args = null;
        if (sel[j] === "(") {
          let depth = 1, k = j + 1, buf = "";
          while (k < n && depth > 0) {
            if (sel[k] === "(") depth++;
            else if (sel[k] === ")") { depth--; if (depth === 0) break; }
            buf += sel[k]; k++;
          }
          args = buf; j = k + 1;
        }
        const lower = name.toLowerCase();
        if (lower === "where") {
          // `:where()` is deliberately specificity-free.
        } else if (args !== null &&
                   ["is", "matches", "not", "any", "has"].includes(lower)) {
          let best = [0, 0, 0];
          for (const part of splitList(args)) best = maxSpec(best, spec(part));
          ids += best[0]; cls += best[1]; els += best[2];
        } else {
          cls += 1;
        }
        i = j; continue;
      }
      if (ch === ".") { cls += 1; i++; while (i < n && /[\w-]/.test(sel[i])) i++; continue; }
      if (ch === "#") { ids += 1; i++; while (i < n && /[\w-]/.test(sel[i])) i++; continue; }
      if (ch === "[") { cls += 1; while (i < n && sel[i] !== "]") i++; i++; continue; }
      if (/[a-zA-Z]/.test(ch)) {
        const prev = i === 0 ? "" : sel[i - 1];
        if (i === 0 || /[\s>+~,(]/.test(prev)) els += 1;
        i++; while (i < n && /[\w-]/.test(sel[i])) i++; continue;
      }
      i++;
    }
    const out = [ids, cls, els];
    specCache.set(sel, out);
    return out;
  };
  // A rule applies through *every* selector in its list that matches, so its
  // effective weight is the strongest of them, not the first.
  const specFor = (el, parts) => {
    let best = [0, 0, 0], found = false;
    for (const part of parts) {
      let m = false;
      try { m = el.matches(part); } catch { m = false; }
      if (!m) continue;
      found = true;
      best = maxSpec(best, spec(part));
    }
    return found ? best : spec(parts[0]);
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
  // element -> [{ ri, spec }]
  const owners = new Map();
  rules.forEach((r, ri) => {
    let nodes; try { nodes = document.querySelectorAll(r.sel); } catch { return; }
    const parts = splitList(r.sel);
    for (const n of nodes) {
      let arr = owners.get(n); if (!arr) owners.set(n, arr = []);
      arr.push({ ri, spec: specFor(n, parts) });
    }
  });

  const out = [];
  const cmp = (a, b, kf) => { const ka = kf(a), kb = kf(b);
    for (let d = 0; d < ka.length; d++) if (ka[d] !== kb[d]) return ka[d] - kb[d]; return 0; };
  const oldKey = (c) => [c.spec[0], c.spec[1], c.spec[2], rules[c.ri].order];
  const newKey = (c) => [rankOf(rules[c.ri].layer), c.spec[0], c.spec[1], c.spec[2],
                         rules[c.ri].order];

  for (const [el, entries] of owners) {
    if (entries.length < 2) continue;
    const cand = {};
    for (const e of entries) {
      const r = rules[e.ri];
      for (const decl of r.css.split(";")) {
        const i = decl.indexOf(":");
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        const value = decl.slice(i + 1).trim();
        if (!prop || prop.startsWith("--")) continue;
        (cand[prop] = cand[prop] || []).push({ ri: e.ri, value, spec: e.spec });
        const expanded = expandDecl(prop, value);
        if (expanded) {
          for (const longhand of Object.keys(expanded)) {
            (cand[longhand] = cand[longhand] || []).push({
              ri: e.ri, value: expanded[longhand], spec: e.spec, via: prop });
          }
        }
      }
    }
    for (const prop of Object.keys(cand)) {
      const list = cand[prop];
      if (list.length < 2) continue;
      let bestOld = list[0], bestNew = list[0];
      for (const c of list) {
        if (cmp(c, bestOld, oldKey) > 0) bestOld = c;
        if (cmp(c, bestNew, newKey) > 0) bestNew = c;
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
        oldVia: bestOld.via || null, newVia: bestNew.via || null,
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
