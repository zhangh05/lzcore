"""Measure how the canvas lets a user select more than one device.

Why this exists
---------------
Reported as "多选设备功能没有". The canvas *does* ship a Shift + drag marquee, so
the claim cannot be taken at face value — it has to be turned into a question
with a measurable answer: which gestures actually grow the selection, and which
ones silently collapse it back to one object?

The first run of this probe answered it:

  单击 A                 1 个   OK
  ⌘ / Ctrl / Shift + 单击 B   1 个   FAIL — a tap could never add
  Shift + 拖框            2 个   OK

Every ordinary tap ended with `cy.elements().unselect()` followed by selecting
exactly the tapped element, so no click could ever grow the selection. The only
way in was Shift + drag, whose hint appears only *after* Shift is already held.

What it measures
----------------
Two independent sources, because they can disagree:

  cy      `cy.$('node:selected').length` — what the canvas believes
  ui      the caption 已选 N 个对象, which only exists when N > 0

A gesture counts as "adds to the selection" only when both grow. A gesture that
grows `cy` but leaves the caption at zero means the canvas selected something
the workspace was never told about.

Gestures covered, and what each should do:

  单击 A                        只选中 A
  ⌘ + 单击 B                    追加 B
  Ctrl + 单击 B                 追加 B
  ⌘ + 单击 B（B 已选）            把 B 移出选区
  Shift + 拖框                  框选（替换）
  ⌘ + 拖框（B 已选）              框选（追加，走 Cytoscape 原生）
  ⌘ + A                        全选（设备 + 图元）

Exit code is the verdict, so this can be run as a gate.

Usage:
  python multiselect_probe.py
  python multiselect_probe.py --shot DIR     # 每个手势一张截图
"""

import argparse
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  window.__cy = cy; window.__host = host;
  const devices = cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-'));
  window.__a = devices[0];
  window.__b = devices[1];
  // Ids, not a captured collection: the canvas reconciles after every save and
  // a collection taken here can end up pointing at elements that were removed
  // and re-added. Reading through `cy.getElementById` each time is what makes
  // the readings below true of the live drawing.
  window.__ids = devices.map(n => n.id());
  // Copy the numbers out. `node.position()` returns the renderer's own object
  // and mutates it in place — two calls give the same reference, and a
  // "snapshot" taken with it silently follows the node around. Measured: a
  // captured origin reported zero drift after a 68px drag.
  const snapshot = () => Object.fromEntries(
    window.__ids.map(id => {
      const p = window.__cy.getElementById(id).position();
      return [id, { x: p.x, y: p.y }];
    }));
  window.__origin = snapshot();
  cy.fit(devices, 140);
  return {
    devices: devices.length,
    total: cy.nodes().filter(n => !n.id().startsWith('group-')).length,
    a: devices[0] && devices[0].id(),
    b: devices[1] && devices[1].id(),
  };
}
"""

STATE = """
() => {
  const cy = window.__cy;
  const caption = document.querySelector('.canvas-selection-count');
  return {
    cy: cy.$('node:selected').length,
    cyIds: cy.$('node:selected').map(n => n.id()),
    ui: caption ? parseInt(caption.textContent.replace(/\\D+/g, ''), 10) : 0,
    captionText: caption ? caption.textContent.trim() : null,
    gestureLayer: !!document.querySelector('.netops-selection-gesture-layer'),
  };
}
"""

# `renderedPosition()` is in the container's LAYOUT pixels, while
# `getBoundingClientRect()` is in VISUAL pixels - the sheet sits under
# `zoom: 0.95` on <body>, so the two differ by that ratio. Skipping it puts the
# computed point ~rp * 0.05 below the device (measured 38px near the bottom of
# the sheet), which is enough to click past a device entirely.
CENTER = """
(id) => {
  const h = window.__host, r = h.getBoundingClientRect();
  const sx = r.width / h.clientWidth, sy = r.height / h.clientHeight;
  const n = window.__cy.getElementById(id);
  const rp = n.renderedPosition();
  return { x: r.x + rp.x * sx, y: r.y + rp.y * sy };
}
"""

BOX = """
(ids) => {
  const h = window.__host, r = h.getBoundingClientRect();
  const sx = r.width / h.clientWidth, sy = r.height / h.clientHeight;
  const pts = ids.map(id => {
    const rp = window.__cy.getElementById(id).renderedPosition();
    return { x: r.x + rp.x * sx, y: r.y + rp.y * sy };
  });
  const pad = 45;
  return {
    x1: Math.min(...pts.map(q => q.x)) - pad, y1: Math.min(...pts.map(q => q.y)) - pad,
    x2: Math.max(...pts.map(q => q.x)) + pad, y2: Math.max(...pts.map(q => q.y)) + pad,
  };
}
"""

CLEAR = "() => { window.__cy.elements().unselect(); }"

# Live positions of every device, looked up by id and copied out of the
# renderer's mutable position object.
POSITIONS = """
() => Object.fromEntries(
  window.__ids.map(id => {
    const p = window.__cy.getElementById(id).position();
    return [id, { x: p.x, y: p.y }];
  }))
"""

# How far the drawing has drifted from the snapshot taken on arrival.
DRIFT = """
() => {
  const origin = window.__origin;
  let worst = 0;
  for (const id of window.__ids) {
    const o = origin[id], p = window.__cy.getElementById(id).position();
    worst = Math.max(worst, Math.abs(p.x - o.x) + Math.abs(p.y - o.y));
  }
  return +worst.toFixed(1);
}
"""

# Selecting anything opens the inspector, which narrows the canvas. Cytoscape
# keeps the pan, so a node can end up outside the visible strip and a click
# aimed at it lands on the inspector instead. That failure mode is invisible in
# the selection count — the selection simply does not change, which reads
# exactly like "the gesture is not implemented". Re-fit before every gesture,
# and refuse to interpret a click that did not actually reach the canvas.
REFIT = """
() => {
  const cy = window.__cy;
  const devices = cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-'));
  cy.fit(devices, 150);
  return true;
}
"""

# Which element is on top at this viewport point, and is it the canvas?
HIT = """
(pt) => {
  const host = document.querySelector('.netops-cytoscape');
  const el = document.elementFromPoint(pt.x, pt.y);
  return {
    hit: el === host || (host.contains(el) && el.tagName === 'CANVAS'),
    tag: el ? el.tagName : null,
    cls: el && el.className && el.className.toString ? el.className.toString().slice(0, 48) : null,
  };
}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", default=None, help="目录：每个手势存一张截图")
    args = ap.parse_args()

    rows = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(f"{BASE}/topology", wait_until="networkidle")
        page.wait_for_timeout(3400)
        info = page.evaluate(SETUP)
        page.wait_for_timeout(300)

        total = info["total"]
        print(f"画布：{info['devices']} 台设备，共 {total} 个可选对象  "
              f"A={info['a']}  B={info['b']}")
        if info["devices"] < 2:
            print("设备不足两台，无法测多选")
            browser.close()
            return 1

        def state():
            return page.evaluate(STATE)

        def clear():
            page.evaluate(CLEAR)
            page.wait_for_timeout(140)

        def aimed_at(node_id):
            """Re-fit, then return a point that really is over the canvas."""
            page.evaluate(REFIT)
            page.wait_for_timeout(340)
            pt = page.evaluate(CENTER, node_id)
            hit = page.evaluate(HIT, pt)
            if not hit["hit"]:
                raise AssertionError(
                    f"探针自身失效：{node_id} 的落点 ({pt['x']:.0f},{pt['y']:.0f}) "
                    f"命中的是 {hit['tag']}.{hit['cls']}，不是画布")
            return pt

        def click(node_id, keys=(), label=None):
            """A real mouse click on the node's rendered centre."""
            pt = aimed_at(node_id)
            for key in keys:
                page.keyboard.down(key)
            page.wait_for_timeout(90)
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(300)
            for key in reversed(keys):
                page.keyboard.up(key)
            page.wait_for_timeout(170)
            if label and args.shot:
                page.screenshot(path=f"{args.shot}/{label}.png")
            return state()

        def drag_box(ids, keys=(), label=None):
            page.evaluate(REFIT)
            page.wait_for_timeout(340)
            box = page.evaluate(BOX, ids)
            for key in keys:
                page.keyboard.down(key)
            page.wait_for_timeout(200)
            page.mouse.move(box["x1"], box["y1"])
            page.wait_for_timeout(110)
            page.mouse.down()
            for i in range(1, 9):
                page.mouse.move(box["x1"] + (box["x2"] - box["x1"]) * i / 8,
                                box["y1"] + (box["y2"] - box["y1"]) * i / 8, steps=1)
                page.wait_for_timeout(32)
            page.mouse.up()
            page.wait_for_timeout(340)
            for key in reversed(keys):
                page.keyboard.up(key)
            page.wait_for_timeout(200)
            if label and args.shot:
                page.screenshot(path=f"{args.shot}/{label}.png")
            return state()

        def report(name, got, expect, note=""):
            ok = got["cy"] == expect and got["ui"] == expect
            rows.append((name, ok, got, expect))
            short = [i.replace("node_", "").replace("canvas_", "g")[:10] for i in got["cyIds"]]
            print(f"  {'OK  ' if ok else 'FAIL'}  {name:<30} "
                  f"cy={got['cy']} ui={got['ui']}（期望 {expect}）  {short}  {note}")
            return ok

        print("\n点击：能否把第二个设备加进选区")

        clear()
        report("单击 A", click(info["a"], (), "01_单击A"), 1, "基线")

        # ⌘ / Ctrl + click must grow the selection. A is selected first, by a
        # plain click, so the probe measures "add" and not "replace".
        for keys, label, zh in (
            (("Meta",), "02_Meta单击B", "⌘ + 单击 B"),
            (("Control",), "03_Ctrl单击B", "Ctrl + 单击 B"),
        ):
            clear()
            click(info["a"])
            got = click(info["b"], keys, label)
            report(zh, got, 2, "A 已选中")

        # The same gesture again must remove B — this is the half that needs the
        # pre-click snapshot, because a toggle-off cannot be inferred from the
        # post-click state.
        clear()
        click(info["a"])
        click(info["b"], ("Meta",))
        got = click(info["b"], ("Meta",), "04_Meta再点B取消")
        report("⌘ + 再单击 B（取消）", got, 1, "选区应只剩 A")

        # Shift + click on a device: Shift is the marquee arm, so this only works
        # if the overlay lets clicks on a device through to Cytoscape.
        clear()
        click(info["a"])
        got = click(info["b"], ("Shift",), "05_Shift单击B")
        report("Shift + 单击 B", got, 2, "A 已选中")

        print("\n框选")

        clear()
        report("Shift + 拖框（框住 A、B）",
               drag_box([info["a"], info["b"]], ("Shift",), "06_Shift拖框"), 2)

        # The native box is additive, so with B already selected a box over A
        # and B must leave three... no — it must leave A and B, and it must not
        # have panned the sheet on the way.
        clear()
        click(info["b"])
        got = drag_box([info["a"], info["b"]], ("Meta",), "07_Meta拖框追加")
        report("⌘ + 拖框（追加）", got, 2, "B 已选中")

        print("\n全选")

        clear()
        page.keyboard.press("Meta+a")
        page.wait_for_timeout(320)
        got = state()
        if args.shot:
            page.screenshot(path=f"{args.shot}/08_全选.png")
        report("⌘ + A 全选", got, total, "设备 + 图元")

        # The marquee press is caught on `document` in the capture phase, so it
        # sits in front of every other gesture on the page. These four assert
        # that it stays out of the way when it has no business intervening.
        print("\n回归：新监听不得碰坏原有手势")

        # 1. a plain drag on empty canvas must still pan, not select
        clear()
        page.evaluate(REFIT)
        page.wait_for_timeout(340)
        before = page.evaluate("() => ({ pan: window.__cy.pan(), sel: window.__cy.$('node:selected').length })")
        page.mouse.move(420, 760)
        page.wait_for_timeout(100)
        page.mouse.down()
        for i in range(1, 7):
            page.mouse.move(420 + 14 * i, 760 - 6 * i, steps=1)
            page.wait_for_timeout(28)
        page.mouse.up()
        page.wait_for_timeout(280)
        after = page.evaluate("() => ({ pan: window.__cy.pan(), sel: window.__cy.$('node:selected').length })")
        moved = abs(after["pan"]["x"] - before["pan"]["x"]) + abs(after["pan"]["y"] - before["pan"]["y"])
        ok = moved > 20 and after["sel"] == 0
        rows.append(("空白处拖动仍为平移", ok, {"moved": round(moved, 1), "sel": after["sel"]}, ">20px 且不选中"))
        print(f"  {'OK  ' if ok else 'FAIL'}  {'空白处拖动仍为平移':<30} "
              f"平移 {moved:.1f}px  选中={after['sel']}（期望 >20px 且 0）")

        # 2. A plain drag on a device must still move it. The capture listener
        #    stands down when Shift is not held, and this is what proves it.
        #
        #    Shift + drag on a device is deliberately *not* asserted to move it:
        #    Shift is this canvas's marquee arm, and Cytoscape treats Shift as a
        #    multi-select key, so a box is the documented behaviour there. What
        #    matters is that Shift + *click* adds, which is asserted above.
        clear()
        pt = aimed_at(info["a"])
        pos_before = page.evaluate(
            "(id) => { const p = window.__cy.getElementById(id).position(); return {x: p.x, y: p.y}; }",
            info["a"])
        page.mouse.move(pt["x"], pt["y"])
        page.wait_for_timeout(110)
        page.mouse.down()
        for i in range(1, 9):
            page.mouse.move(pt["x"] + 7 * i, pt["y"] + 4 * i, steps=1)
            page.wait_for_timeout(28)
        page.mouse.up()
        page.wait_for_timeout(2600)
        pos_after = page.evaluate(
            "(id) => { const p = window.__cy.getElementById(id).position(); return {x: p.x, y: p.y}; }",
            info["a"])
        dist = ((pos_after["x"] - pos_before["x"]) ** 2 + (pos_after["y"] - pos_before["y"]) ** 2) ** 0.5
        ok = dist > 20
        rows.append(("拖动设备（无修饰键）移动它", ok, {"dist": round(dist, 1)}, ">20px"))
        print(f"  {'OK  ' if ok else 'FAIL'}  {'拖动设备（无修饰键）':<30} "
              f"位移 {dist:.1f}px（期望 >20px）")

        # 3. The payoff of multi-select: dragging one of several selected
        #    devices moves the whole selection by the same delta, rigidly.
        clear()
        click(info["a"])
        click(info["b"], ("Meta",))
        if state()["cy"] == 2:
            page.evaluate(REFIT)
            page.wait_for_timeout(340)
            pt = page.evaluate(CENTER, info["a"])
            before_pos = page.evaluate(POSITIONS)
            page.mouse.move(pt["x"], pt["y"])
            page.wait_for_timeout(110)
            page.mouse.down()
            for i in range(1, 9):
                page.mouse.move(pt["x"] + 6 * i, pt["y"] + 3 * i, steps=1)
                page.wait_for_timeout(30)
            mid_pos = page.evaluate(POSITIONS)
            page.mouse.up()
            page.wait_for_timeout(300)
            deltas = {i: (mid_pos[i]["x"] - before_pos[i]["x"], mid_pos[i]["y"] - before_pos[i]["y"])
                      for i in before_pos}
            lead = deltas[info["a"]]
            spread = max(abs(d[0] - lead[0]) + abs(d[1] - lead[1]) for d in deltas.values())
            lead_moved = abs(lead[0]) + abs(lead[1])
            ok = lead_moved > 20 and spread < 2
            rows.append(("多选后整体移动", ok, {"lead": round(lead_moved, 1), "spread": round(spread, 2)}, ">20px 且一致"))
            print(f"  {'OK  ' if ok else 'FAIL'}  {'多选后整体移动（刚性）':<28} "
                  f"抓取位移 {lead_moved:.1f}px  最大偏差 {spread:.2f}px（期望 >20px 且 <2px）")
            for i, d in deltas.items():
                print(f"        {i[-12:]}  Δ=({d[0]:.1f}, {d[1]:.1f})")
        else:
            rows.append(("多选后整体移动", False, {"note": "多选未建立，跳过"}, 2))
            print("  FAIL  多选后整体移动 —— 多选没建立起来，无法测")

        # 4. Shift + box must replace, not accumulate.
        clear()
        click(info["b"])
        got = drag_box([info["a"], info["b"]], ("Shift",), "09_Shift拖框替换")
        report("Shift + 拖框（替换）", got, 2, "此前已选 B")

        # Net-zero. A bare `cy.position()` is not an edit — it moves the renderer
        # without touching React state, so it is never saved. Measured: after
        # "restoring" that way the drawing was still 31px out on disk. Undo is
        # the product's own path, it pushes a real state and it persists, so the
        # probe ends by undoing every drag it performed. The count is not
        # assumed — it undoes until the renderer agrees with the snapshot taken
        # on arrival, because how many history entries exist depends on what ran
        # before this probe.
        clear()
        drift = page.evaluate(DRIFT)
        attempts = 0
        while drift > 1 and attempts < 5:
            page.keyboard.press("Meta+z")
            page.wait_for_timeout(1500)
            drift = page.evaluate(DRIFT)
            attempts += 1
        page.wait_for_timeout(1200)
        drift = page.evaluate(DRIFT)
        print(f"  ----  {'收尾：撤销本次拖动':<30} 撤销 {attempts} 次，最大残差 {drift}px")
        if drift > 1:
            rows.append(("探针收尾无残留", False, {"residual": drift}, "<=1px"))
            print("  FAIL  探针收尾无残留 —— 探针改动了画布")

        browser.close()

    bad = [r for r in rows if not r[1]]
    print(f"\n{len(rows)} 项断言，{len(bad)} 项失败")
    for name, _, got, expect in bad:
        # Rows carry different payloads: selection assertions report cy/ui,
        # the regression rows report distances. Print whichever is present.
        detail = (f"cy={got['cy']} ui={got['ui']}" if "cy" in got else str(got))
        print(f"  失败：{name}  {detail}  期望={expect}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
