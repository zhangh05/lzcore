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
  落点准确        it lands where the click was, in model units — for both the
                  click path and the drag-and-drop path
  自动命名        the name is generated, and never repeats a number
  拖放            dragging a type onto the sheet also places it
  点设备取消      clicking an object ends the wait instead of placing on it
  Esc 取消        Escape ends the wait

The position checks exist because the canvas converts a pointer position
through the rect/client ratio before subtracting pan and dividing by zoom, and
skipping that ratio is a mistake this codebase has already shipped once (it put
every drop up to 38px from where it was aimed). Nothing else here would notice.

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
import math
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
#
# Everything here stays in the container's LAYOUT pixels. The sheet sits under
# `zoom: 0.95` on <body>, so `getBoundingClientRect()` is in visual pixels while
# `renderedPosition()` is in layout pixels; comparing the two without the ratio
# puts every point ~rp * 0.05 away from where it was meant to be (measured 38px
# near the bottom of the sheet). Only the final conversion to a client point
# multiplies by the scale.
EMPTY_POINT = """
() => {
  const host = window.__host, cy = window.__cy;
  const r = host.getBoundingClientRect();
  const scale = { x: r.width / host.clientWidth, y: r.height / host.clientHeight };
  const pan = cy.pan(), zoom = cy.zoom();
  const boxes = cy.$('node').filter(n => !n.id().startsWith('group-')).map(n => {
    const p = n.position();
    return {
      cx: pan.x + p.x * zoom, cy: pan.y + p.y * zoom,
      hw: (n.width() * zoom) / 2 + 26, hh: (n.height() * zoom) / 2 + 26,
    };
  });
  for (let ly = 90; ly < host.clientHeight - 120; ly += 40) {
    for (let lx = 90; lx < host.clientWidth - 260; lx += 40) {
      if (boxes.some(b => Math.abs(lx - b.cx) <= b.hw && Math.abs(ly - b.cy) <= b.hh)) continue;
      const c = { x: r.left + lx * scale.x, y: r.top + ly * scale.y };
      const el = document.elementFromPoint(c.x, c.y);
      if (!el || !host.contains(el)) continue;
      return c;
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

POSITION_OF = """
(label) => {
  const n = window.__cy.nodes().filter(x => x.data('label') === label)[0];
  if (!n) return null;
  const p = n.position();
  return { x: p.x, y: p.y };
}
"""

# The conversion inputs must be read BEFORE the click that uses them. Placing a
# device opens the inspector, which reflows the canvas - measured, `rect.top`
# moves ~37px - so reading them afterwards describes a different layout.
CONVERSION_CONTEXT = """
() => {
  const h = window.__host, cy = window.__cy, r = h.getBoundingClientRect();
  return { left: r.left, top: r.top,
           sx: r.width / h.clientWidth, sy: r.height / h.clientHeight,
           pan: cy.pan(), zoom: cy.zoom() };
}
"""


# The grid state is a class on the canvas wrapper, so it can be read rather
# than inferred. Inferring it from "is the position a multiple of 32" misfires:
# a real multiple looks identical to a snapped one, which silently loosens the
# tolerance on the very check that is supposed to be strict.
GRID_ON = "() => !!document.querySelector('.netops-canvas-wrap.grid-on')"


def expected_model(context, point):
    """Where a drop at `point` should land, in model units.

    Mirrors the canvas's own conversion: visual client px -> container layout
    px (divide by the rect/client ratio) -> model px (subtract pan, divide by
    zoom). Getting this wrong is the whole reason this check exists.
    """
    lx = (point["x"] - context["left"]) / context["sx"]
    ly = (point["y"] - context["top"]) / context["sy"]
    return {"x": (lx - context["pan"]["x"]) / context["zoom"],
            "y": (ly - context["pan"]["y"]) / context["zoom"]}


def js_round(value):
    """`Math.round` semantics: halves go up, not to even."""
    return math.floor(value + 0.5)


def position_error(actual, wanted, snapping):
    """How far the node landed from where it was asked to be.

    With the grid on, the product snaps, so the expectation is snapped too and
    held to 2px. Comparing against the raw point instead would force the
    tolerance to absorb half a cell (16px), and a check that loose cannot see a
    small regression — it would only catch the gross one it was written for.

    Returns (error, tolerance, the expectation actually compared against), so
    the report can print the number that was really used rather than one that
    looks inconsistent with the error beside it.
    """
    if snapping:
        wanted = {"x": js_round(wanted["x"] / 32) * 32, "y": js_round(wanted["y"] / 32) * 32}
        tol = 2
    else:
        tol = 3
    dx, dy = abs(actual["x"] - wanted["x"]), abs(actual["y"] - wanted["y"])
    return max(dx, dy), tol, wanted


FIRST_NODE_POINT = """
() => {
  const host = window.__host, cy = window.__cy;
  const r = host.getBoundingClientRect();
  // `renderedPosition()` is layout px, the rect is visual px - see EMPTY_POINT.
  const scale = { x: r.width / host.clientWidth, y: r.height / host.clientHeight };
  const n = cy.nodes().filter(x =>
    !x.id().startsWith('group-') && !x.id().startsWith('canvas-'))[0];
  const q = n.renderedPosition();
  return { x: r.x + q.x * scale.x, y: r.y + q.y * scale.y, id: n.id() };
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
    ap.add_argument("--expect-nodes", type=int, default=2,
                    help="进场时画布应有的设备数（默认 2：AR1 + CE1）")
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
            """Click an empty point and return it, with the layout it was aimed in.

            The context is captured before the click on purpose: placing a
            device opens the inspector, which reflows the canvas, so reading the
            conversion inputs afterwards describes a different layout and makes
            the position check meaningless.
            """
            pt = page.evaluate(EMPTY_POINT)
            if not pt:
                raise AssertionError(f"探针自身失效：找不到空白落点（{what}）")
            aim(pt, what)
            context = page.evaluate(CONVERSION_CONTEXT)
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(2500)
            return pt, context

        def placed_position(before_labels, what):
            """The node this step created, and where it actually landed."""
            after = labels()
            added = [name for name in after if name not in before_labels]
            if len(added) != 1:
                raise AssertionError(f"探针自身失效：{what} 之后新增了 {added}，期望正好 1 台")
            return added[0], page.evaluate(POSITION_OF, added[0])

        fresh()
        baseline = labels()
        buttons = page.locator(".palette-type-item").count()
        print(f"画布基线 {len(baseline)} 台设备：{baseline}")

        # Refuse to run on a canvas that is not the one the numbers below were
        # calibrated against. Debris from a killed run is the usual cause, and
        # it is not cosmetic: an inflated drawing spreads the nodes out, which
        # is exactly the state that amplified the hit-test defect this probe
        # was written to catch — so leftovers produce failures that look like
        # product defects. Better to stop than to report a lie.
        if len(baseline) != args.expect_nodes:
            print(f"  FAIL  进场前置检查：画布有 {len(baseline)} 台设备，期望 {args.expect_nodes} 台。")
            print("       多半是某次探针被中断留下的残骸。先跑 canvas_cleanup.py 清理，"
                  "或确认这是你要的状态后加 --expect-nodes。")
            browser.close()
            return 1

        try:
            # 1. the palette offers the drawing types
            report("型号按钮齐全", buttons >= 6, f"{buttons} 个（期望至少 6 个）")

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
            #    Why it has to: this assertion clicks a device by aiming at its
            #    `renderedPosition()`, and that aim used to be wrong by up to
            #    38px — the canvas was mixing visual pixels (the rect) with
            #    layout pixels (renderedPosition), so a click meant for a device
            #    landed on the background and *placed a device*, which reads
            #    exactly like the disarm being broken. That is fixed (see
            #    marquee_hit_probe.py), but the aim still deserves a clean sheet
            #    and an explicit tap check, so a miss is reported as a probe
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
            before5 = labels()
            count_before = len(before5)
            arm("firewall")
            point, context = click_empty("空白处单击")
            after = labels()
            report("空白处单击即放置",
                   len(after) == count_before + 1 and any(n.startswith("防火墙") for n in after),
                   f"{count_before} → {len(after)} 台，新增={[n for n in after if n not in baseline]}")
            got = armed()
            report("放置后解除待放置", not got["armed"] and not got["hint"])

            # 5b. and it lands where it was asked to. The canvas converts the
            #     click through the rect/client ratio before subtracting pan and
            #     dividing by zoom; skipping that ratio is a bug that has already
            #     been shipped once here, and it is invisible without this check.
            label5, actual = placed_position(before5, "单击放置")
            err, tol, wanted = position_error(
                actual, expected_model(context, point), snapping=page.evaluate(GRID_ON))
            report("单击落点准确",
                   err <= tol,
                   f"{label5} 实际=({actual['x']:.0f},{actual['y']:.0f}) "
                   f"应为=({wanted['x']:.0f},{wanted['y']:.0f}) 偏差={err:.1f}px 容差={tol}")
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

            # 7. dragging a type onto the sheet places it too - and, again,
            #    where it was dropped rather than 38px below.
            fresh()
            before7 = labels()
            target = page.locator(".netops-cytoscape")
            box = target.bounding_box()
            # A drop point well inside the canvas and clear of the devices.
            drop = {"x": box["x"] + box["width"] * 0.28, "y": box["y"] + box["height"] * 0.74}
            context7 = page.evaluate(CONVERSION_CONTEXT)
            page.drag_and_drop('[data-testid="palette-type-router"]', ".netops-cytoscape",
                               target_position={"x": drop["x"] - box["x"], "y": drop["y"] - box["y"]})
            page.wait_for_timeout(2600)
            dragged = labels()
            routers = sorted(n for n in dragged if n.startswith("路由器"))
            report("拖拽型号到画布",
                   len(dragged) == len(before7) + 1 and len(routers) == 1,
                   f"{len(before7)} → {len(dragged)} 台，名称={routers}")
            if len(routers) == 1:
                drop_actual = page.evaluate(POSITION_OF, routers[0])
                derr, dtol, drop_wanted = position_error(
                    drop_actual, expected_model(context7, drop), snapping=page.evaluate(GRID_ON))
                report("拖放落点准确",
                       derr <= dtol,
                       f"{routers[0]} 实际=({drop_actual['x']:.0f},{drop_actual['y']:.0f}) "
                       f"应为=({drop_wanted['x']:.0f},{drop_wanted['y']:.0f}) 偏差={derr:.1f}px 容差={dtol}")

            # 8. both ways of placing must land the same way. The grid is a
            #    property of the drawing, so it cannot apply to one gesture and
            #    not the other: measured before the fix, a dragged type snapped
            #    to (-416,352) while a clicked one sat at (-184,-8) with the
            #    grid visibly on.
            if len(routers) == 1:
                grid = page.evaluate(GRID_ON)
                click_on_grid = actual["x"] % 32 == 0 and actual["y"] % 32 == 0
                drop_on_grid = drop_actual["x"] % 32 == 0 and drop_actual["y"] % 32 == 0
                report("两种放置方式一致",
                       (not grid) or (click_on_grid == drop_on_grid),
                       f"网格={'开' if grid else '关'}  "
                       f"单击{'在' if click_on_grid else '不在'}格点  "
                       f"拖放{'在' if drop_on_grid else '不在'}格点")
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
