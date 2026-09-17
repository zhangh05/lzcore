"""Shift + drag on a device must move the device, not start a box selection.

Why this exists
---------------
The sheet sits under `zoom: 0.95` on <body>, so two pixel spaces are in play:

  * `getBoundingClientRect()` reports **visual** pixels (scaled by 0.95);
  * everything Cytoscape reports — `pan()`, `zoom()`, `renderedPosition()`,
    `width()` — is in the container's **layout** pixels.

`nodeUnderPointer` subtracts one from the other without the ratio, which puts
the point it tests ~`rp.y * 0.05` BELOW the device. Measured: 0.9497, i.e. 38px
at the bottom of the sheet. That is more than a device is tall, so a press
squarely on a device was read as a press on empty canvas and the marquee took
the gesture — the device could not be dragged at all while Shift was held.

Cytoscape's own hit test was never affected (it stays in one space throughout),
which is exactly why plain clicking a device always worked and the defect only
showed up through the hand-rolled conversions.

What it asserts
---------------
  对照         a plain click at the computed point really does land on the device
  设备上       Shift + press on the device (low on the sheet) starts no marquee
  空白处       Shift + press on empty canvas still starts one — the feature lives
  几何          the marquee box is written in layout pixels, not visual ones

Two disciplines this file exists to honour:

* **Every section starts from a fresh page load.** The point is computed from
  `getBoundingClientRect()` and the device's rendered position. Opening the
  inspector reflows the canvas — measured, `rect.top` moved 149.7 → 186.5 and
  `clientWidth` 1340 → 1020 — so a point computed before a click is 37px stale
  afterwards. The first version of this probe reused one across a click and
  reported the resulting miss as a product defect.
* **A press that moved nothing proves nothing.** In the fixed case Cytoscape
  handles the press and really does drag the device, so positions are captured
  first and written back at the end through the product's own endpoint.

Usage:
  python marquee_hit_probe.py
  python marquee_hit_probe.py --shot DIR
"""

import argparse
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

from probe_journal import ProbeJournal

BASE = "http://127.0.0.1:5273"
API = "http://127.0.0.1:8011/api/extensions/network.operations"
TOPO = "topo_894e4566e217"

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  window.__cy = cy; window.__host = host;
  return true;
}
"""

# Put a device low on the sheet, where the missing scale factor is largest.
# Panning is view state only - nothing is persisted.
LOW = """
() => {
  const host = window.__host, cy = window.__cy;
  const n = cy.nodes().filter(x =>
    !x.id().startsWith('group-') && !x.id().startsWith('canvas-'))[0];
  window.__n = n;
  const rp = n.renderedPosition();
  cy.pan({ x: cy.pan().x, y: cy.pan().y + ((host.clientHeight - 110) - rp.y) });
  return true;
}
"""

# The press point: inside the device, 70% of the way up its body. The upper
# part is the hard case - that is where the missing factor puts the tested
# point furthest outside.
ON_DEVICE = """
() => {
  const host = window.__host, n = window.__n;
  const r = host.getBoundingClientRect();
  const scale = r.height / host.clientHeight;
  const rp = n.renderedPosition();
  const halfVisual = (n.height() * window.__cy.zoom()) / 2 * scale;
  return {
    id: n.id(),
    point: { x: r.x + rp.x * scale, y: r.y + rp.y * scale - halfVisual * 0.7 },
    centre: { x: r.x + rp.x * scale, y: r.y + rp.y * scale },
    rectTop: r.top, scale, halfVisual,
  };
}
"""

# Empty sheet: inside the canvas, clear of every device, and clear of the
# minimap and zoom cluster (they are siblings of the canvas, so a press on them
# never reaches this code at all).
EMPTY = """
() => {
  const host = window.__host, cy = window.__cy;
  const r = host.getBoundingClientRect();
  const scale = { x: r.width / host.clientWidth, y: r.height / host.clientHeight };
  const zoom = cy.zoom(), pan = cy.pan();
  const boxes = cy.$('node').filter(n => !n.id().startsWith('group-')).map(n => {
    const p = n.position();
    return { x: pan.x + p.x * zoom, y: pan.y + p.y * zoom,
             hw: (n.width() * zoom) / 2 + 30, hh: (n.height() * zoom) / 2 + 30 };
  });
  for (let ly = 90; ly < host.clientHeight - 150; ly += 40) {
    for (let lx = 90; lx < host.clientWidth - 260; lx += 40) {
      if (boxes.some(b => Math.abs(lx - b.x) <= b.hw && Math.abs(ly - b.y) <= b.hh)) continue;
      const c = { x: r.left + lx * scale.x, y: r.top + ly * scale.y };
      const el = document.elementFromPoint(c.x, c.y);
      if (!el || !host.contains(el)) continue;
      return { point: c, local: { x: lx, y: ly }, rectTop: r.top };
    }
  }
  return null;
}
"""

MARQUEE = """
() => {
  const el = document.querySelector('.netops-selection-marquee');
  return el ? { top: parseFloat(el.style.top), left: parseFloat(el.style.left) } : null;
}
"""

WATCH_TAP = """
() => {
  window.__tap = null;
  window.__cy.on('tap', e => {
    window.__tap = { id: e.target.id ? e.target.id() : null,
                     isNode: e.target.isNode ? e.target.isNode() : false };
  });
  return true;
}
"""

# The probe drags a device for real, so it persists. Recording the positions
# before the drag and repairing on the way *in* is what makes the restore
# survive a killed run — see probe_journal.py for why the way out is not
# enough.
journal = ProbeJournal("marquee_hit_probe")


def read_topology():
    return json.load(urllib.request.urlopen(
        f"{API}/topologies/{TOPO}?workspace_id=default", timeout=5))["topology"]


def write_topology(t):
    body = {"workspace_id": "default", "name": t["name"], "description": t.get("description", ""),
            "version": t["version"], "nodes": t["nodes"], "links": t["links"],
            "groups": t.get("groups", []), "canvas_items": t.get("canvas_items", [])}
    req = urllib.request.Request(f"{API}/topologies/{TOPO}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="PUT")
    return json.load(urllib.request.urlopen(req, timeout=10))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shot", default=None)
    args = ap.parse_args()

    rows = []

    # Undo whatever a previous run left behind, before touching anything. A
    # killed run dies between the drag and its own restore, and only a check on
    # the way in can catch that.
    for name, now, back in journal.repair(read_topology, write_topology, TOPO):
        print(f"  !!!!  上次运行被中断，先复原 {name}: {now} → {back}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        def fresh():
            page.goto(f"{BASE}/topology", wait_until="networkidle")
            page.wait_for_timeout(3200)
            page.evaluate(SETUP)
            page.evaluate(LOW)
            page.wait_for_timeout(400)

        def report(name, ok, note=""):
            rows.append((name, ok))
            print(f"  {'OK  ' if ok else 'FAIL'}  {name:<30} {note}")
            return ok

        def shift_drag(point, dx=30, dy=30):
            """Shift + press, small move, release. Returns the marquee box, if any."""
            page.keyboard.down("Shift")
            page.wait_for_timeout(180)
            page.mouse.move(point["x"], point["y"])
            page.wait_for_timeout(140)
            page.mouse.down()
            page.wait_for_timeout(140)
            page.mouse.move(point["x"] + dx, point["y"] + dy, steps=3)
            page.wait_for_timeout(240)
            box = page.evaluate(MARQUEE)
            page.mouse.up()
            page.wait_for_timeout(250)
            page.keyboard.up("Shift")
            page.wait_for_timeout(250)
            return box

        print("Shift + 拖动设备，是否被误判为框选")

        # 1. Control, on its own page: the computed point really is on the
        #    device. Without this a "no marquee" result could just mean the
        #    press landed somewhere harmless.
        fresh()
        journal.record(read_topology(), TOPO)
        target = page.evaluate(ON_DEVICE)
        page.evaluate(WATCH_TAP)
        page.mouse.click(target["point"]["x"], target["point"]["y"])
        page.wait_for_timeout(800)
        tap = page.evaluate("() => window.__tap")
        report("对照：该点确实在设备上",
               bool(tap and tap["isNode"] and tap["id"] == target["id"]),
               f"tap={tap['id'][-12:] if tap and tap['id'] else None}")

        # 2. The defect. Fresh page: nothing has reflowed since the point was
        #    computed, so a miss here is the product's, not the probe's.
        fresh()
        target = page.evaluate(ON_DEVICE)
        box = shift_drag(target["point"])
        if args.shot:
            page.screenshot(path=f"{args.shot}/01_设备上.png")
        report("设备上按下不起框选", box is None,
               f"落点 y={target['point']['y']:.1f}  rect.top={target['rectTop']:.1f}  "
               f"框选={'出现 top=%.1f' % box['top'] if box else '未出现'}")

        # 3. The feature still lives: the same gesture on empty canvas must
        #    still produce a box, or step 2 would pass for the wrong reason.
        fresh()
        empty = page.evaluate(EMPTY)
        if not empty:
            raise AssertionError("探针自身失效：找不到远离设备的空白落点")
        box = shift_drag(empty["point"])
        if args.shot:
            page.screenshot(path=f"{args.shot}/02_空白处.png")
        report("空白处按下仍起框选", box is not None,
               f"框选={'出现 top=%.1f' % box['top'] if box else '未出现'}")

        # 4. The box is a CSS offset inside the host, so it must be written in
        #    layout pixels. Writing visual pixels would make it drift from the
        #    pointer by up to 5% of the canvas height.
        if box:
            scale = page.evaluate(
                "() => { const h = window.__host; const r = h.getBoundingClientRect();"
                " return r.height / h.clientHeight; }")
            raw = empty["point"]["y"] - empty["rectTop"]
            expected = raw / scale
            report("框选几何用布局像素", abs(box["top"] - expected) < 2.5,
                   f"style.top={box['top']:.1f} 期望={expected:.1f} "
                   f"(若用视觉像素会是 {raw:.1f})")

        browser.close()

    # Put back anything the fixed behaviour legitimately dragged. `repair`
    # clears the journal, so a normal run leaves nothing for the next to undo.
    moved = journal.repair(read_topology, write_topology, TOPO)
    if moved:
        for name, now, back in moved:
            print(f"  ----  复原 {name}: {now} → {back}")
    else:
        print("  ----  画布未被改动")

    bad = [r for r in rows if not r[1]]
    print(f"\n{len(rows)} 项断言，{len(bad)} 项失败")
    for name, _ in bad:
        print(f"  失败：{name}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
