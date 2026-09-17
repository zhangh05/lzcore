"""Assert the interface labels survive everything the canvas does on its own.

Why this exists
---------------
Reported as "接口显示有问题": 接口标签 is ticked, the port names are on the link,
and then — with nobody touching anything — they are not. Idling on the page,
they vanished after 6.4 seconds and never came back.

The chain, all of it measured rather than read off the source:

  1. a 10s status poll sets `topologyState`;
  2. `nodeStatus` is a memo over it, so it recomputes;
  3. `dimmedNodeIds` is a memo over `nodeStatus`, and returned a *fresh* `[]`
     when nothing was filtered, so its identity changed too;
  4. the canvas reconciles whenever `dimmedNodeIds` changes identity;
  5. reconciliation wrote `srcPort`, `tgtPort` and `label` back as empty
     strings, because the element spec claimed to own them;
  6. the effect that owns them only re-runs when `topology.links` changes
     identity — and it had not.

So the labels were blanked by a component that had no business writing them,
and only a zoom could bring them back.

What this asserts
-----------------
That the port labels are *stable*, not merely present. Presence at page load is
the easy half; the defect lived entirely in what happened afterwards. Four
triggers, each of which used to blank them or could:

  idle     20 seconds, covering at least two status polls
  drag     a real device drag, which commits and reloads
  zoom     a zoom step (the one thing that used to restore them)
  filter   toggling the canvas filter, which legitimately rewrites dimming

Plus one separate assertion for node labels: `labelOpacity` is owned by the
level-of-detail effect, so a reconciliation must not put node labels back on
while the view is zoomed too far out to read them.

Exit code is the verdict, so this can be run as a gate.

Usage:
  python interface_label_probe.py
"""

import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

READ = """
() => {
  const cy = document.querySelector('.netops-cytoscape')._cyreg.cy;
  const e = cy.edges()[0];
  const nodes = cy.$('node').filter(n => !n.id().startsWith('group-'));
  return {
    src: e.data('srcPort'), tgt: e.data('tgtPort'),
    styleSrc: e.style('source-label'), styleTgt: e.style('target-label'),
    zoom: +cy.zoom().toFixed(3),
    labelOpacity: nodes.length ? nodes[0].data('labelOpacity') : null,
    shown: nodes.length ? nodes[0].style('text-opacity') : null,
  };
}
"""

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  window.__cy = cy; window.__host = host;
  window.__target = cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-'))[0];
  cy.center(window.__target);
  return { srcPort: cy.edges()[0].data('srcPort') };
}
"""

WHERE = """
() => {
  const r = window.__host.getBoundingClientRect();
  const rp = window.__target.renderedPosition();
  return { x: r.x + rp.x, y: r.y + rp.y };
}
"""


def label_state(page):
    """The two facts that matter: what the data says, and what is painted."""
    got = page.evaluate(READ)
    ok = bool(got["src"]) and bool(got["tgt"])
    return ok, got


def main() -> int:
    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(f"{BASE}/topology", wait_until="networkidle")
        page.wait_for_timeout(3200)
        page.evaluate(SETUP)
        page.wait_for_timeout(300)

        def check(name, note=""):
            ok, got = label_state(page)
            rows.append((name, ok, got))
            print(f"  {'OK  ' if ok else 'FAIL'}  {name:<28} "
                  f"src={got['src']!r} tgt={got['tgt']!r} "
                  f"painted={got['styleSrc']!r} zoom={got['zoom']} {note}")
            return ok

        print("接口标注在四类触发下的稳定性")
        check("载入后")

        # 1. idle, long enough for two status polls
        page.wait_for_timeout(20000)
        check("静置 20 秒（跨两次状态轮询）")

        # 2. a real drag: commit + reload
        start = page.evaluate(WHERE)
        page.mouse.move(start["x"], start["y"])
        page.wait_for_timeout(120)
        page.mouse.down()
        page.wait_for_timeout(150)
        for i in range(1, 9):
            page.mouse.move(start["x"] + 9 * i, start["y"] + 5 * i, steps=1)
            page.wait_for_timeout(28)
        page.mouse.up()
        page.wait_for_timeout(2600)
        check("拖动设备之后")

        # 3. zoom, which used to be the only thing that brought them back
        page.evaluate("() => { const cy = window.__cy; cy.zoom(cy.zoom() * 1.2); }")
        page.wait_for_timeout(600)
        check("缩放之后")

        # 4. filter toggle: legitimately rewrites dimming
        page.evaluate("() => { const cy = window.__cy; cy.elements().unselect(); }")
        # 过滤 is a <details><summary>, not a button, and its own menu contains a
        # 清除过滤 button — so match the summary inside the filter panel.
        panel = page.locator("details", has=page.locator("summary", has_text="过滤"))
        panel.locator("summary").click()
        page.wait_for_timeout(300)
        panel.locator("input[type=checkbox]").first.click()
        page.wait_for_timeout(500)
        check("勾选过滤条件之后")

        # 5. node labels must stay hidden when zoomed too far out to read them.
        # The filter panel is left open on purpose — closing and reopening a
        # <details> by clicking its summary is a coin flip, and a hidden button
        # then reads as a missing one.
        #
        # Clear the filter first: `.filtered-out` also sets text-opacity, and
        # leaving it on would make the two sources indistinguishable — the
        # assertion is about `labelOpacity`, which the LOD effect owns.
        panel.locator("button", has_text="清除过滤").click()
        page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.evaluate("() => { const cy = window.__cy; cy.zoom(0.2); }")
        page.wait_for_timeout(600)
        _, before = label_state(page)
        page.wait_for_timeout(20000)
        _, after = label_state(page)
        hidden_ok = (before["labelOpacity"] == 0 and after["labelOpacity"] == 0
                     and before["shown"] in ("0", 0) and after["shown"] in ("0", 0))
        rows.append(("远缩后节点标签保持隐藏", hidden_ok, after))
        print(f"  {'OK  ' if hidden_ok else 'FAIL'}  远缩后节点标签保持隐藏（跨轮询）  "
              f"labelOpacity {before['labelOpacity']} → {after['labelOpacity']}  "
              f"text-opacity {before['shown']} → {after['shown']}")

        browser.close()

    bad = [r for r in rows if not r[1]]
    print(f"\n{len(rows)} 项断言，{len(bad)} 项失败")
    for name, _, got in bad:
        print(f"  失败：{name}  {got}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
