"""Measure whether the edit bar's two button groups actually collide.

Why this exists
---------------
Opening any side panel makes the canvas area narrower, and the edit bar lives
inside it. Reading the stylesheet said why the two groups *could* collide:

  * `.studio-edit-tools` carries `min-width: 0` and `overflow: visible`;
  * `.toolbar-right` carries `flex: 0 0 auto`, so it never gives up width;
  * `flex-wrap: wrap` on `.topology-editbar` existed only inside a
    `@media (max-width: 1180px)` block.

So the left group was the only thing that could shrink, and when it did its
`white-space: nowrap` children simply painted outside its box — over the right
group. Measured before the fix: 19 of 40 width-by-panel cells overlapped, every
one of them in the 1181–1600px band that the media query did not reach, with the
left group squeezed by up to 241px. At 1180px and below the bar was fine, which
is the tell: the rule that would have prevented it was one pixel away.

The fix moves the wrap onto the base rule. This probe is now the guard for that,
and it asserts both halves of it: no two controls may intersect, *and* no control
may escape the bar's own box — the second failure being the one the wrap could
have introduced, since a row can be too narrow for a group that can neither
shrink nor break.

What it measures
----------------
Group bounding rects are not enough: the whole point of the defect is that the
children escape their parent's box, so a shrunken `.studio-edit-tools` rect can
look innocent while its buttons sit on top of `.toolbar-right`'s. The verdict
therefore comes from every *control* rect in the left group tested against every
control rect in the right group, pairwise. `groupsIntersect` is reported too, and
is expected to stay `False` even while the buttons overlap — which is the whole
reason the bug survived a look at the group boxes.

Panels are opened through their real controls, not by editing class names:
the library through its toolbar toggle, the inspector through 更多 → 查看详情,
the agent dock through its own button. Each is a layout switch the user can
actually reach.

A cell is `clean` only when nothing overlaps and nothing escapes; the exit code
follows, so this can be run as a gate.

Usage:
  python editbar_overlap_probe.py                      # widths x panels
  python editbar_overlap_probe.py --tag before         # keep a JSON snapshot
  python editbar_overlap_probe.py --width 1705         # a single width
  python editbar_overlap_probe.py --panels inspector   # a single panel
"""

import argparse
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

# The edit bar only has to survive widths a real window can be. 1705 is the
# width of the screenshot the defect was reported from.
WIDTHS = [1920, 1705, 1600, 1500, 1440, 1366, 1280, 1200, 1180, 1100]

PANELS = ["none", "library", "inspector", "agent"]

MEASURE = r"""
() => {
  const rect = (el) => { const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
  const overlap = (a, c) => {
    const w = Math.min(a.r, c.r) - Math.max(a.x, c.x);
    const h = Math.min(a.b, c.b) - Math.max(a.y, c.y);
    return (w > 0.5 && h > 0.5) ? { w, h, area: w * h } : null;
  };
  const label = (el) => (el.textContent || el.getAttribute('aria-label') || el.className || '?')
    .trim().replace(/\s+/g, ' ').slice(0, 12);

  const bar = document.querySelector('.topology-editbar');
  if (!bar) return { error: 'no .topology-editbar on this page' };
  const left = bar.querySelector('.studio-edit-tools');
  const right = bar.querySelector('.toolbar-right');
  if (!left || !right) return { error: 'edit bar is missing one of its two groups' };

  const leftItems = [...left.children].map(el => ({ label: label(el), rect: rect(el) }));
  const rightItems = [...right.children].map(el => ({ label: label(el), rect: rect(el) }));

  const collisions = [];
  for (const a of leftItems) {
    for (const c of rightItems) {
      const hit = overlap(a.rect, c.rect);
      if (hit) collisions.push({ left: a.label, right: c.label, ...hit });
    }
  }
  collisions.sort((p, q) => q.area - p.area);

  const cs = (el) => {
    const s = getComputedStyle(el);
    return { flex: s.flex, minWidth: s.minWidth, overflow: s.overflow,
             flexWrap: s.flexWrap, justifyContent: s.justifyContent };
  };

  // The second assertion. Wrapping the bar fixes the collision by giving the
  // action group its own row, and a row can itself be too narrow: `.toolbar-right`
  // is `flex: 0 0 auto` with `flex-wrap: nowrap`, so it cannot shrink and cannot
  // break, and anything past the bar's edge would paint over the canvas caption
  // instead of over a sibling button. Cheaper to assert than to notice.
  const barRect = rect(bar);
  const escaped = [];
  for (const el of [...leftItems, ...rightItems]) {
    const r = el.rect;
    const out = Math.max(r.r - barRect.r, r.b - barRect.b, barRect.x - r.x);
    if (out > 0.5) escaped.push({ label: el.label, by: out,
                                  side: r.r - barRect.r > 0.5 ? 'right'
                                      : r.b - barRect.b > 0.5 ? 'bottom' : 'left' });
  }
  escaped.sort((p, q) => q.by - p.by);

  return {
    viewport: { w: innerWidth, h: innerHeight },
    bar: { rect: barRect, style: cs(bar) },
    left: { rect: rect(left), style: cs(left),
            scrollWidth: left.scrollWidth, clientWidth: left.clientWidth,
            items: leftItems },
    right: { rect: rect(right), style: cs(right),
             scrollWidth: right.scrollWidth, clientWidth: right.clientWidth,
             items: rightItems },
    groupsIntersect: overlap(rect(left), rect(right)),
    collisions,
    escaped,
  };
}
"""


def set_panel(page, panel):
    """Open `panel` through the control the user would reach for."""
    if panel == "none":
        return True
    if panel == "library":
        btn = page.query_selector('button[aria-label="设备库与拓扑列表"]')
        if btn is None:
            return False
        btn.click()
    elif panel == "agent":
        btn = page.query_selector('button:has-text("Agent 协作")')
        if btn is None:
            return False
        btn.click()
    elif panel == "inspector":
        more = page.query_selector(".studio-more > summary")
        if more is None:
            return False
        more.click()
        page.wait_for_timeout(250)
        item = page.query_selector('.studio-more button:has-text("详情")')
        if item is None:
            return False
        item.click()
    else:
        return False
    page.wait_for_timeout(700)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--panels", default=",".join(PANELS))
    ap.add_argument("--shot", default="", help="also write a PNG of the bar per cell to this directory")
    args = ap.parse_args()

    widths = [args.width] if args.width else WIDTHS
    panels = [p for p in args.panels.split(",") if p]
    snapshot = {}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        bad = 0
        for w in widths:
            for panel in panels:
                # A fresh page per cell: panels are sticky, and reusing a page
                # would mean un-opening one before opening the next.
                page = browser.new_page(viewport={"width": w, "height": 900})
                page.goto(f"{BASE}/topology", wait_until="networkidle")
                page.wait_for_timeout(2500)

                if not set_panel(page, panel):
                    print(f"\n=== {w} / {panel}: control not found")
                    page.close()
                    continue
                m = page.evaluate(MEASURE)

                # Rectangles settle a verdict; a picture is what a person checks
                # it against. Taken before the page closes, cropped to the bar.
                if args.shot and "error" not in m:
                    os.makedirs(args.shot, exist_ok=True)
                    page.screenshot(
                        path=os.path.join(args.shot, f"{w}_{panel}.png"),
                        clip={"x": 0, "y": max(0, m["bar"]["rect"]["y"] - 4),
                              "width": w, "height": m["bar"]["rect"]["h"] + 8})
                page.close()

                key = f"{w}|{panel}"
                snapshot[key] = m
                if "error" in m:
                    print(f"\n=== {w} / {panel}: {m['error']}")
                    continue

                left, right = m["left"], m["right"]
                squeeze = left["scrollWidth"] - left["clientWidth"]
                n = len(m["collisions"])
                e = len(m["escaped"])
                bad += 1 if (n or e) else 0
                print(f"\n=== {w} / {panel}")
                print(f"    bar  h={m['bar']['rect']['h']:5.1f}  wrap={m['bar']['style']['flexWrap']}")
                print(f"    left  group x={left['rect']['x']:7.1f} w={left['rect']['w']:6.1f}  "
                      f"content={left['scrollWidth']:4d}  squeezed={squeeze:4d}px")
                print(f"    right group x={right['rect']['x']:7.1f} w={right['rect']['w']:6.1f}")
                print(f"    group rects intersect: {bool(m['groupsIntersect'])}")
                if n:
                    worst = m["collisions"][0]
                    print(f"    CONTROL PAIRS OVERLAPPING: {n}  worst: "
                          f"「{worst['left']}」 x 「{worst['right']}」 "
                          f"{worst['w']:.1f}x{worst['h']:.1f}px")
                else:
                    print("    control pairs overlapping: 0")
                if e:
                    worst = m["escaped"][0]
                    print(f"    CONTROLS OUTSIDE THE BAR: {e}  worst: "
                          f"「{worst['label']}」 past the {worst['side']} edge by "
                          f"{worst['by']:.1f}px")
                else:
                    print("    controls outside the bar: 0")
                print(f"    VERDICT: {'OVERLAP' if n else ('ESCAPED' if e else 'clean')}")

        browser.close()

    if args.tag:
        out = f"/tmp/editbar_overlap_{args.tag}.json"
        json.dump(snapshot, open(out, "w"), ensure_ascii=False, indent=2)
        print(f"\nwrote {out}")

    total = len(widths) * len(panels)
    print(f"\n{total} 个 宽度×面板 组合中 {bad} 个存在按钮重叠")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
