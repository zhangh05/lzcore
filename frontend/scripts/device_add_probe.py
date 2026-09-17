"""Measure the device-add flow against the eNSP / HCL model.

Why this exists
---------------
Reported as a suggestion rather than a defect: "我觉得一个很好的参照就是华为的
ensp 和华三的HCL，这是真的好用，建议你参考人家的画布实现、设备添加等".

Both of those put a *model* palette down the left side. Adding a device is
"pick the type, click the sheet" — two gestures, no dialog, and the device
appears with a generated name you can change afterwards. This canvas had the
opposite shape: the left panel listed *registered assets*, and a drawing-only
node required the 新建图纸设备 modal, so putting a firewall on the sheet meant
naming it before you could see it.

What it asserts, and how
------------------------
  型号按钮        the six drawing types are offered
  点选            clicking a type arms it, and the canvas says so
  单击放置        the next empty-sheet click puts a node down at that point
  自动命名        the name is generated, and never repeats a number
  拖放            dragging a type onto the sheet also places it
  点设备取消      clicking an object ends the wait instead of placing on it
  Esc 取消        Escape ends the wait

Two disciplines, both learned the hard way on this canvas:

* **Every section starts from a fresh page load.** Placing, undoing and
  reloading leave the view and the undo stack wherever they drifted, and a
  probe that carries that state forward ends up measuring its own history. The
  first version of this file reported "the click placed a device" — the real
  cause was an earlier undo that never landed, so its baseline count was wrong.
* **A click that did not reach the canvas is an error, not a result.** A point
  aimed at a node can land outside the visible strip once the view has moved,
  and the symptom is identical to the feature doing nothing.

The probe is a no-op on the drawing: it ends by deleting anything it created,
through the product's own confirm dialog, and reports the count it restored to.

Usage:
  python device_add_probe.py
  python device_add_probe.py --shot DIR
"""

import argparse
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

OPEN_LIBRARY = """
() => {
  const btn = [...document.querySelectorAll('button')]
    .find(b => (b.getAttribute('title') || '').includes('设备库'));
  if (btn) btn.click();
  return !!btn;
}
"""

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  window.__cy = host._cyreg.cy;
  window.__host = host;
  return true;
}
"""

LABELS = """
() => window.__cy.nodes()
  .filter(n => !n.id().startsWith('group-') && !n.id().startsWith('canvas-'))
  .map(n => n.data('label'))
"""

ARMED = """
() => ({
  armed: [...document.querySelectorAll('.palette-type-item')]
    .filter(b => b.classList.contains('is-armed'))
    .map(b => b.getAttribute('data-testid')),
  hint: !!document.querySelector('.netops-placing-hint'),
  cursor: getComputedStyle(document.querySelector('.netops-cytoscape')).cursor,
})
"""

# A point over the canvas that is not over any node: a click there is a click
# on empty sheet. Node bodies are `size * zoom` around their rendered centre,
# and labels are excluded exactly as the canvas's own hit test excludes them.
EMPTY_POINT = """
() => {
  const host = window.__host, cy = window.__cy;
  const r = host.getBoundingClientRect();
  const pan = cy.pan(), zoom = cy.zoom();
  const boxes = cy.$('node').filter(n => !n.id().startsWith('group-')).map(n => {
    const p = n.position();
    return {
      cx: r.left + pan.x + p.x * zoom, cy: r.top + pan.y + p.y * zoom,
      hw: (n.width() * zoom) / 2 + 26, hh: (n.height() * zoom) / 2 + 26,
    };
  });
  for (let fx = 0.16; fx <= 0.85; fx += 0.07) {
    for (let fy = 0.16; fy <= 0.85; fy += 0.07) {
      const c = { x: r.left + r.width * fx, y: r.top + r.height * fy };
      if (c.x < r.left + 4 || c.x > r.right - 4 || c.y < r.top + 4 || c.y > r.bottom - 4) continue;
      const el = document.elementFromPoint(c.x, c.y);
      if (!el || !host.contains(el)) continue;
      if (boxes.every(b => Math.abs(c.x - b.cx) > b.hw || Math.abs(c.y - b.cy) > b.hh)) return c;
    }
  }
  return null;
}
"""

HIT = """
(pt) => {
  const host = window.__host;
  const el = document.elementFromPoint(pt.x, pt.y);
  return {
    onCanvas: !!el && host.contains(el),
    tag: el ? el.tagName : null,
    cls: el && el.className && el.className.toString ? el.className.toString().slice(0, 48) : null,
  };
}
"""

FIRST_NODE_POINT = """
() => {
  const host = window.__host, cy = window.__cy;
  const r = host.getBoundingClientRect();
  const n = cy.nodes().filter(x =>
    !x.id().startsWith('group-') && !x.id().startsWith('canvas-'))[0];
  const q = n.renderedPosition();
  return { x: r.x + q.x, y: r.y + q.y, id: n.id() };
}
"""

REFIT = """
() => {
  const cy = window.__cy;
  cy.fit(cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-')), 150);
  return true;
}
"""

# Listen alongside the app's own handler, never instead of it. This is what
# turns "the click did nothing" into a statement about the click rather than a
# guess about the feature.
WATCH_TAP = """
() => {
  window.__tap = null;
  window.__cy.on('tap', e => {
    window.__tap = {
      id: e.target.id ? e.target.id() : null,
      isNode: e.target.isNode ? e.target.isNode() : false,
    };
  });
  return true;
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", default=None, help="目录：关键步骤截图")
    args = ap.parse_args()

    rows = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        def fresh():
            """A clean page: view, undo stack and selection all reset."""
            page.goto(f"{BASE}/topology", wait_until="networkidle")
            page.wait_for_timeout(3200)
            page.evaluate(OPEN_LIBRARY)
            page.wait_for_timeout(650)
            page.evaluate(SETUP)

        def labels():
            return page.evaluate(LABELS)

        def armed():
            return page.evaluate(ARMED)

        def report(name, ok, note=""):
            rows.append((name, ok))
            print(f"  {'OK  ' if ok else 'FAIL'}  {name:<32} {note}")
            return ok

        def arm(type_value):
            page.click(f'[data-testid="palette-type-{type_value}"]')
            page.wait_for_timeout(280)

        def aim(pt, what):
            hit = page.evaluate(HIT, pt)
            if not hit["onCanvas"]:
                raise AssertionError(
                    f"探针自身失效：{what} 的落点 ({pt['x']:.0f},{pt['y']:.0f}) "
                    f"命中的是 {hit['tag']}.{hit['cls']}，不是画布")
            return pt

        def click_empty(what):
            pt = page.evaluate(EMPTY_POINT)
            if not pt:
                raise AssertionError(f"探针自身失效：找不到空白落点（{what}）")
            aim(pt, what)
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(2500)

        fresh()
        baseline = labels()
        buttons = page.locator(".palette-type-item").count()
        print(f"画布基线 {len(baseline)} 台设备：{baseline}")

        try:
            # 1. the palette offers the drawing types
            report("型号按钮齐全", buttons == 6, f"{buttons} 个（期望 6）")

            # 2. picking a type arms the canvas, and says so
            arm("firewall")
            got = armed()
            if args.shot:
                page.screenshot(path=f"{args.shot}/01_已选中防火墙.png")
            report("点选后进入待放置",
                   got["armed"] == ["palette-type-firewall"] and got["hint"] and got["cursor"] == "copy",
                   f"armed={got['armed']} 提示={got['hint']} 光标={got['cursor']}")

            # 3. clicking an object ends the wait instead of placing on top of
            #    it. This runs here, on a sheet that still holds only what the
            #    user put there, and not after the placement steps below.
            #
            #    Why it has to: with five or more devices on the sheet the
            #    renderer's hit test and `renderedPosition()` come apart —
            #    measured, the node answered clicks about 40px above the point
            #    `renderedPosition()` reports, so a click aimed at it lands on
            #    the background and *places a device*, which reads exactly like
            #    the disarm being broken. Neither `cy.fit()` nor the canvas's
            #    own 适配 button avoided it; only the smaller drawing does. The
            #    tap is checked either way, so a miss is reported as a probe
            #    failure rather than a product one.
            count_before = len(labels())
            arm("switch")
            page.click('button[aria-label="适配画布"]')
            page.wait_for_timeout(900)
            tap = None
            for attempt in range(3):
                page.evaluate(WATCH_TAP)
                target = page.evaluate(FIRST_NODE_POINT)
                aim(target, "单击已有设备")
                page.mouse.click(target["x"], target["y"])
                page.wait_for_timeout(1200)
                tap = page.evaluate("() => window.__tap")
                if tap and tap["id"] == target["id"]:
                    break
                if len(labels()) > count_before:
                    page.keyboard.press("Meta+z")
                    page.wait_for_timeout(1500)
            if not tap or tap["id"] != target["id"]:
                raise AssertionError(
                    f"探针自身失效：点击没能落在 {target['id']} 上，最后一次 tap={tap}")
            got = armed()
            report("点已有设备只取消待放置",
                   len(labels()) == count_before and not got["armed"] and not got["hint"],
                   f"tap={tap['id'][-12:]} 节点 {count_before} → {len(labels())}，armed={got['armed']}")

            # 4. Escape ends the wait
            arm("server")
            page.keyboard.press("Escape")
            page.wait_for_timeout(420)
            got = armed()
            report("Esc 取消待放置", not got["armed"] and not got["hint"],
                   f"armed={got['armed']} 提示={got['hint']}")

            # 5. the next empty-sheet click places a device
            fresh()
            count_before = len(labels())
            arm("firewall")
            click_empty("空白处单击")
            after = labels()
            report("空白处单击即放置",
                   len(after) == count_before + 1 and any(n.startswith("防火墙") for n in after),
                   f"{count_before} → {len(after)} 台，新增={[n for n in after if n not in baseline]}")
            got = armed()
            report("放置后解除待放置", not got["armed"] and not got["hint"])
            if args.shot:
                page.screenshot(path=f"{args.shot}/02_已放置.png")

            # 6. a second device of the same type gets its own name
            fresh()
            before = labels()
            arm("firewall")
            click_empty("第一次放置")
            arm("firewall")
            click_empty("第二次放置")
            after = labels()
            added = [n for n in after if n not in before]
            firewalls = sorted(n for n in after if n.startswith("防火墙"))
            report("同型号不重名",
                   len(after) == len(before) + 2
                   and len(added) == 2 and len(set(added)) == 2
                   and len(firewalls) == len(set(firewalls)),
                   f"新增={added}  画布上的防火墙={firewalls}")

            # 7. dragging a type onto the sheet places it too
            fresh()
            before = labels()
            page.drag_and_drop('[data-testid="palette-type-router"]', ".netops-cytoscape")
            page.wait_for_timeout(2600)
            dragged = labels()
            routers = sorted(n for n in dragged if n.startswith("路由器"))
            report("拖拽型号到画布",
                   len(dragged) == len(before) + 1 and len(routers) == 1,
                   f"{len(before)} → {len(dragged)} 台，名称={routers}")
        finally:
            # Leave the drawing as it was found. Anything whose label was not
            # there at the start is the probe's, and goes back through the
            # product's own confirm dialog rather than a direct write.
            page.goto(f"{BASE}/topology", wait_until="networkidle")
            page.wait_for_timeout(3200)
            page.evaluate(SETUP)
            leftovers = [n for n in labels() if n not in baseline]
            if leftovers:
                page.evaluate(
                    """(keep) => {
                         const cy = window.__cy;
                         cy.elements().unselect();
                         cy.nodes()
                           .filter(n => !n.id().startsWith('group-') && !n.id().startsWith('canvas-'))
                           .filter(n => !keep.includes(n.data('label')))
                           .select();
                       }""",
                    baseline,
                )
                page.wait_for_timeout(600)
                page.keyboard.press("Delete")
                page.wait_for_timeout(900)
                confirm = page.locator("button", has_text="移除")
                if confirm.count():
                    confirm.last.click()
                    page.wait_for_timeout(3200)
            final = labels()
            print(f"  ----  {'收尾':<32} 清理 {len(leftovers)} 台，剩余 {len(final)} 台（基线 {len(baseline)}）")
            if len(final) != len(baseline):
                rows.append(("收尾回到基线", False))
                print("  FAIL  收尾回到基线 —— 探针改动了画布")

        browser.close()

    bad = [r for r in rows if not r[1]]
    print(f"\n{len(rows)} 项断言，{len(bad)} 项失败")
    for name, _ in bad:
        print(f"  失败：{name}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
