"""Responsive + QA sweep: 11 pages x light/dark x 1200/1440/1920/900.

Reports four things that a screenshot review misses and a type check never sees:
  1. horizontal overflow of the document, and which element causes it
  2. text whose computed colour is too close to its effective background
  3. interactive elements that render with no box at all (unreachable)
  4. at <=900px, whether the four named areas actually reflow: drawer, the
     runtime/progress rail, the topology inspector, and master-detail stacking

Usage: python qa_matrix.py [width ...]
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

# A sweep that reports "nothing found" is indistinguishable from a sweep that
# looks at nothing. This plants three defects a reviewer would catch by eye and
# asserts the sweep catches them too. Run it after changing the detectors.
SELFTEST = r"""
() => {
  const host = document.body;
  const mk = (css, text) => { const d = document.createElement("div");
    d.setAttribute("style", css); d.textContent = text; host.appendChild(d); return d; };
  const a = mk("color:#ffffff;background:#ffffff;font-size:14px", "should be illegible");
  const b = mk("color:#777777;background:#ffffff;font-size:14px", "should be below AA");
  const c = document.createElement("button");
  c.setAttribute("style", "display:block;width:0;height:0;padding:0;border:0");
  c.textContent = "should be unreachable"; host.appendChild(c);
  const d = document.createElement("button");
  d.setAttribute("style", "display:block;width:44px;height:44px");
  d.textContent = "fine"; host.appendChild(d);
  window.__selftest = [a, b, c, d];
  return "planted";
}
"""
ROUTES = ["/workbench", "/runs", "/capabilities", "/knowledge", "/data", "/memory",
          "/topology", "/diagnostics", "/settings", "/users", "/login"]
WIDTHS = [int(w) for w in sys.argv[1:] if w.lstrip("-").isdigit()] or [1200, 1440, 1920, 900]
THEMES = ["light", "dark"]
HEIGHT = 900

JS = r"""
() => {
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => {
    const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.5) return c;
      n = n.parentElement;
    }
    return [255, 255, 255, 1];
  };
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const ownText = (el) => Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("")
    .replace(/\s+/g, " ").slice(0, 40);

  const out = { overflow: null, illegible: [], belowAA: [], sizeless: [], reflow: {} };
  const de = document.documentElement;
  if (de.scrollWidth > window.innerWidth + 1) {
    let worst = null;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const over = Math.round(r.right - window.innerWidth);
      if (over > 2 && (!worst || over > worst.over)) {
        worst = { over, tag: el.tagName.toLowerCase(),
                  cls: String(el.className || "").slice(0, 50), text: ownText(el) };
      }
    }
    out.overflow = { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, worst };
  }

  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const text = ownText(el);
    if (text) {
      const fg = parse(cs.color);
      if (fg && fg[3] > 0.4) {
        const ratio = contrast(fg, bgOf(el));
        if (ratio < 4.5) {
          const r = el.getBoundingClientRect();
          const rec = { ratio: Math.round(ratio * 100) / 100, text,
            tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 44),
            color: cs.color, size: cs.fontSize, visible: r.width > 0 && r.height > 0 };
          // 3.0 is "unreadable"; WCAG AA wants 4.5 for body text (3.0 for
          // large). The band between is where real complaints live, so it is
          // reported separately rather than hidden under the hard failures.
          (ratio < 3.0 ? out.illegible : out.belowAA).push(rec);
        }
      }
    }
  }

  // "No box" only matters if the element is actually there to be clicked. The
  // mobile drawer is display:none above its breakpoint, so its links measure
  // 0x0 while being perfectly reachable on a phone — flagging them produced 85
  // findings, all false. checkVisibility() walks the ancestor chain the way
  // the compositor does.
  const reachable = (el) =>
    el.checkVisibility
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : el.offsetParent !== null;

  for (const el of document.querySelectorAll("button, a, input, select, textarea, [role='button']")) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (!reachable(el)) continue;
    if (r.width < 1 || r.height < 1) {
      out.sizeless.push({ tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 44), text: ownText(el),
        aria: el.getAttribute("aria-label") || "" });
    }
  }

  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  out.reflow = {
    navToggleVisible: (() => { const e = q(".nav-toggle"); if (!e) return null;
      const c = getComputedStyle(e); return c.display !== "none" && c.visibility !== "hidden"; })(),
    sidebar: box(".app-sidebar"),
    progressRail: box(".task-progress-panel"),
    splitShell: box(".split-shell"),
    inspector: box(".topology-inspector") || box("[class*='inspector']"),
  };
  return out;
}
"""

if "--selftest" in sys.argv:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1200, "height": 900})
        pg.goto(f"{BASE}/settings", wait_until="domcontentloaded")
        pg.wait_for_timeout(1500)
        pg.evaluate(SELFTEST)
        got = pg.evaluate(JS)
        cls = [x["text"] for x in got["illegible"]]
        aa = [(round(x["ratio"], 2), x["text"]) for x in got["belowAA"]]
        sz = [x["text"] for x in got["sizeless"]]
        checks = [
            ("对比度 < 3.0 被抓到", "should be illegible" in cls),
            ("3.0–4.5 区间被抓到", any(t == "should be below AA" for _, t in aa)),
            ("零尺寸按钮被抓到", "should be unreachable" in sz),
            ("正常按钮未被误报", "fine" not in sz),
        ]
        for name, ok in checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        print(f"\n  实测：illegible={len(got['illegible'])} belowAA={len(aa)} sizeless={len(sz)}")
        b.close()
    sys.exit(0 if all(ok for _, ok in checks) else 1)

rows = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width in WIDTHS:
        for theme in THEMES:
            page = browser.new_page(viewport={"width": width, "height": HEIGHT})
            for route in ROUTES:
                try:
                    page.goto(f"{BASE}{route}", wait_until="domcontentloaded")
                    page.wait_for_timeout(1700)
                    page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
                    page.wait_for_timeout(250)
                    got = page.evaluate(JS)
                except Exception as exc:
                    got = {"error": str(exc)[:120]}
                got.update(route=route, width=width, theme=theme)
                rows.append(got)
            page.close()
            print(f"  {width}px/{theme} 完成", file=sys.stderr)
    browser.close()

json.dump(rows, open("/tmp/qa_matrix.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print(f"\n共 {len(rows)} 个组合\n")
print("══ 1. 横向溢出 ══")
n = 0
for r in rows:
    if r.get("overflow"):
        n += 1
        w = r["overflow"]["worst"]
        print(f"  {r['route']:<14} {r['width']}px {r['theme']:<5} 文档 {r['overflow']['scrollWidth']} > 视口 {r['overflow']['innerWidth']}"
              f"  ← {w['tag']}.{w['cls']} 超出 {w['over']}px")
print(f"  合计 {n} 处" if n else "  无")

print("\n══ 2. 文字与底色对比度 < 3.0（几乎不可读）══")
seen = {}
for r in rows:
    for it in r.get("illegible", []):
        if not it["visible"]:
            continue
        key = (r["route"], it["cls"], it["text"][:20], round(it["ratio"], 1))
        seen.setdefault(key, []).append(f"{r['width']}{r['theme'][0]}")
for (route, cls, text, ratio), where in sorted(seen.items(), key=lambda kv: kv[0][3])[:30]:
    print(f"  {ratio:>5}  {route:<14} .{cls:<40} “{text}”  {','.join(sorted(set(where)))}")
print(f"  合计 {len(seen)} 类" if seen else "  无")

print("\n══ 2b. 对比度 3.0–4.5（可读但未达 WCAG AA 正文标准）══")
seen = {}
for r in rows:
    for it in r.get("belowAA", []):
        if not it["visible"]:
            continue
        key = (r["route"], it["cls"], round(it["ratio"], 1), it["size"])
        seen.setdefault(key, []).append((f"{r['width']}{r['theme'][0]}", it["text"][:18]))
for (route, cls, ratio, size), where in sorted(seen.items(), key=lambda kv: kv[0][2])[:40]:
    themes = ",".join(sorted({t for t, _ in where}))
    sample = where[0][1]
    print(f"  {ratio:>5}  {route:<14} .{cls:<34} {size:>7} “{sample}”  {themes}")
print(f"  合计 {len(seen)} 类" if seen else "  无")

print("\n══ 3. 无尺寸的可交互元素（点不到）══")
seen = {}
for r in rows:
    for it in r.get("sizeless", []):
        key = (r["route"], it["cls"], it["text"][:16] or it["aria"][:16])
        seen.setdefault(key, []).append(f"{r['width']}{r['theme'][0]}")
for (route, cls, text), where in list(seen.items())[:20]:
    print(f"  {route:<14} .{cls:<40} “{text}”  {','.join(sorted(set(where)))}")
print(f"  合计 {len(seen)} 类" if seen else "  无")

print("\n══ 4. ≤900px 的关键区域 ══")
for r in rows:
    if r["width"] != 900 or r["theme"] != "light":
        continue
    rf = r.get("reflow", {})
    print(f"  {r['route']:<14} 抽屉按钮={rf.get('navToggleVisible')} 侧栏={rf.get('sidebar')} "
          f"进度轨={rf.get('progressRail')} 主从={rf.get('splitShell')}")
