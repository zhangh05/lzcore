"""Assert what every device is allowed to do during, and after, a drag.

Why this exists
---------------
Two probes have already failed to reproduce "dragging a device still sometimes
flashes it somewhere else":

  * `drag_race_probe.py` held a save reply open and watched a node that was
    *currently grabbed*. It proved that path is closed.
  * an earlier version of this file watched one node for two seconds after
    release. Six trials, zero movement.

Both picked a window and a subject. The lesson from the toolbar defect applies:
when two narrow measurements come up clean, stop guessing which window is right
and measure the whole gesture against a rule that covers it.

The rule
--------
A drag is a rigid motion. Everything selected moves by the grabbed node's delta;
nothing else moves at all. So for one trace, per device:

    expected = grabbed_delta   if the device was selected
             = 0               otherwise
    deviation = |actual - expected|

and separately, while the node is under the pointer, `node - pointerModel` is
constant apart from the alignment snap (SNAP = 5 model px, so a legitimate
deviation is bounded by 5). Both halves are measured over the whole gesture,
not over a guessed sub-window.

Two instrument decisions that are easy to get wrong, and were:

  * The listener is on the **capture** phase. Cytoscape consumes the gesture on
    its own container, so a bubble-phase `window` listener records nothing at
    all — it reported "0 samples" while looking perfectly healthy.
  * **Every** device is sampled. In a multi-selection drag only the grabbed node
    reports `grabbed()`; a defect that moves one of the others is invisible to a
    probe that watches a single node. Selection state is sampled alongside, so
    the rule above can be applied without assuming what was selected.

Gestures, because they stress different paths:

  plain     drag, release, watch
  regrab    drag, release, re-grab inside the 800ms debounce, watch
  rapid     three drags back to back, so saves queue on `saveChainRef`
  multi     two devices selected, dragged together

Touched nodes are restored on exit — a drag really does persist.

Usage:
  python drag_flash_probe.py
  python drag_flash_probe.py --gesture multi --trials 6
"""

import argparse
import json
import statistics
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
API = "http://127.0.0.1:8011/api/extensions/network.operations"
TOPO = "topo_894e4566e217"

# The alignment snap legitimately moves a node relative to the pointer by up to
# SNAP model px. Anything beyond that is not the snap.
SNAP = 5
TOL = SNAP + 3

STEPS = 12
STEP_PX = 11
STEP_MS = 28

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  window.__cy = cy; window.__host = host;
  const devices = cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-'));
  window.__devices = devices;
  window.__target = devices[0];
  if (!window.__traceHook) {
    window.__traceHook = true;
    window.__trace = [];
    window.__posWrites = [];
    window.__mark = (name) => window.__trace.push({ mark: name, t: performance.now() });
    // Capture phase, because Cytoscape consumes the gesture on its own
    // container and a bubble-phase `window` listener records nothing at all.
    //
    // But capture also means this runs *before* Cytoscape applies the pointer's
    // delta, so reading the position here is one step stale. On a steady drag
    // that lag is constant and invisible; on a single large step it looks like
    // the node failed to follow the pointer — a 37px false positive, three runs
    // in a row. So the pointer is recorded now and the positions are read in
    // `requestAnimationFrame`, by which time the drag has been applied.
    let pending = null;
    let rafId = 0;
    window.addEventListener('mousemove', (ev) => {
      const r = host.getBoundingClientRect();
      const pan = cy.pan(), zoom = cy.zoom();
      pending = { x: (ev.clientX - r.left - pan.x) / zoom,
                  y: (ev.clientY - r.top - pan.y) / zoom };
      if (rafId) return;                    // coalesce a burst into one reading
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const pointerModel = pending;
        pending = null;
        if (!pointerModel) return;
        window.__trace.push({
          t: performance.now(),
          pointerModel,
          nodes: window.__devices.map(n => ({ id: n.id(), x: n.position().x,
                                              y: n.position().y,
                                              grabbed: n.grabbed(),
                                              selected: n.selected() })),
        });
      });
    }, true);
    cy.on('position', 'node', (e) => {
      const n = e.target;
      window.__posWrites.push({ t: performance.now(), id: n.id(),
                                x: n.position().x, y: n.position().y, grabbed: n.grabbed() });
    });
  }
  cy.center(window.__target);
  return { devices: devices.map(n => ({ id: n.id(), label: n.data('label') })) };
}
"""

RESET = """
() => {
  window.__trace = []; window.__posWrites = [];
  window.__cy.center(window.__target);
  return true;
}
"""

WHERE = """
() => {
  const r = window.__host.getBoundingClientRect();
  const rp = window.__target.renderedPosition();
  return { screen: { x: r.x + rp.x, y: r.y + rp.y } };
}
"""

READ = """
() => window.__devices.map(n => ({ id: n.id(), x: n.position().x,
                                   y: n.position().y, grabbed: n.grabbed() }))
"""

TAKE = """
() => { const t = window.__trace, w = window.__posWrites;
        window.__trace = []; window.__posWrites = []; return { trace: t, writes: w }; }
"""

MARK = "(name) => window.__mark(name)"


def read_topology():
    return json.load(urllib.request.urlopen(f"{API}/topologies/{TOPO}?workspace_id=default", timeout=5))["topology"]


def write_topology(t):
    body = {"workspace_id": "default", "name": t["name"], "description": t.get("description", ""),
            "version": t["version"], "nodes": t["nodes"], "links": t["links"],
            "groups": t.get("groups", []), "canvas_items": t.get("canvas_items", [])}
    req = urllib.request.Request(f"{API}/topologies/{TOPO}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="PUT")
    return json.load(urllib.request.urlopen(req, timeout=10))


def drag(page, start, dx, dy, release=True):
    page.mouse.move(start["x"], start["y"])
    page.wait_for_timeout(120)
    page.mouse.down()
    page.wait_for_timeout(180)
    for i in range(1, STEPS + 1):
        page.mouse.move(start["x"] + dx * i / STEPS, start["y"] + dy * i / STEPS, steps=1)
        page.wait_for_timeout(STEP_MS)
    end = {"x": start["x"] + dx, "y": start["y"] + dy}
    if release:
        page.mouse.up()
    return end


def watch(page, ms, interval=20):
    samples = []
    t0 = time.monotonic()
    deadline = t0 + ms / 1000
    while time.monotonic() < deadline:
        samples.append((round((time.monotonic() - t0) * 1000), page.evaluate(READ)))
        page.wait_for_timeout(interval)
    return samples


def analyse(trace, writes):
    """Apply the rigid-motion rule to one gesture."""
    marks = {e["mark"]: e["t"] for e in trace if "mark" in e}
    cut_down, cut_up = marks.get("down"), marks.get("up")
    samples = [e for e in trace if "nodes" in e
               and (cut_down is None or e["t"] >= cut_down)
               and (cut_up is None or e["t"] <= cut_up)]
    if len(samples) < 3:
        return {"samples": len(samples), "grab_jump": 0.0, "rigid_jump": 0.0,
                "grab_axis": None, "offenders": []}

    first, last = samples[0]["nodes"], samples[-1]["nodes"]
    by_id_first = {n["id"]: n for n in first}
    delta = {}
    for n in last:
        a = by_id_first.get(n["id"])
        if a:
            delta[n["id"]] = (n["x"] - a["x"], n["y"] - a["y"])

    grabbed_ids = {n["id"] for s in samples for n in s["nodes"] if n["grabbed"]}
    lead = None
    for n in last:
        if n["id"] in grabbed_ids:
            lead = n["id"]
            break
    if lead is None:                      # never grabbed: nothing to assert against
        lead = last[0]["id"]
    lead_delta = delta.get(lead, (0.0, 0.0))

    # 1. Rigid motion: the grabbed node moves by the pointer's delta, everything
    #    selected moves with it, nothing else moves at all. The grabbed node is
    #    the reference, so it is exempt from the "should not have moved" half —
    #    and it need not be selected: Cytoscape does not select a node that was
    #    only dragged, and counting that as a violation was this probe's own bug.
    offenders = []
    for n in last:
        if n["id"] == lead:
            continue
        expected = lead_delta if n["selected"] else (0.0, 0.0)
        got = delta.get(n["id"], (0.0, 0.0))
        dev = max(abs(got[0] - expected[0]), abs(got[1] - expected[1]))
        if dev > 2:
            offenders.append({"id": n["id"], "selected": n["selected"],
                              "moved": got, "expected": expected, "dev": dev})
    rigid_jump = max((o["dev"] for o in offenders), default=0.0)

    # 2. While the grabbed node is under the pointer, node - pointerModel is fixed.
    grab_axis = None
    grab_jump = 0.0
    offs = []
    series = []
    for s in samples:
        for n in s["nodes"]:
            if n["id"] == lead:
                offs.append((n["x"] - s["pointerModel"]["x"],
                             n["y"] - s["pointerModel"]["y"]))
                series.append((round(s["t"] - samples[0]["t"]), round(offs[-1][0], 1),
                               round(offs[-1][1], 1), n["grabbed"]))
    if len(offs) >= 4:
        mx, my = statistics.median(o[0] for o in offs), statistics.median(o[1] for o in offs)
        grab_axis = (mx, my)
        grab_jump = max(max(abs(o[0] - mx), abs(o[1] - my)) for o in offs)

    # 3. Writes that landed after the pointer came up.
    post = [w for w in writes if cut_up is not None and w["t"] > cut_up]
    return {"samples": len(samples), "grab_jump": grab_jump, "rigid_jump": rigid_jump,
            "grab_axis": grab_axis, "offenders": offenders, "series": series,
            "post_writes": len(post),
            "post_first_ms": (post[0]["t"] - cut_up) if post else None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=4)
    ap.add_argument("--gesture", default="plain,regrab,rapid,multi")
    ap.add_argument("--watch-ms", type=int, default=2200)
    args = ap.parse_args()

    gestures = [g for g in args.gesture.split(",") if g]
    pristine = read_topology()
    print(f"原始 version={pristine['version']}  "
          f"nodes={[(n['node_id'][-6:], n['x'], n['y']) for n in pristine['nodes']]}")

    rows = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 1500, "height": 950})
            pg = ctx.new_page()
            pg.goto(f"{BASE}/topology", wait_until="domcontentloaded")
            pg.wait_for_timeout(4500)

            info = pg.evaluate(SETUP)
            print(f"共 {len(info['devices'])} 台设备，目标 "
                  f"{info['devices'][0]['id'][-6:]} 「{info['devices'][0]['label']}」\n")

            for g in gestures:
                print(f"══ 手势 {g}")
                for trial in range(1, args.trials + 1):
                    pg.wait_for_timeout(1400)
                    pg.evaluate(RESET)
                    pg.wait_for_timeout(250)

                    if g == "multi":
                        pg.evaluate("() => { const cy = window.__cy; cy.elements().unselect();"
                                    " window.__devices.slice(0, 2).forEach(n => n.select()); }")
                        pg.wait_for_timeout(150)

                    here = pg.evaluate(WHERE)
                    pg.evaluate(MARK, "down")
                    if g == "rapid":
                        for _ in range(3):
                            drag(pg, here["screen"], 40, 24)
                            pg.wait_for_timeout(260)
                            here = pg.evaluate(WHERE)
                    else:
                        drag(pg, here["screen"], STEP_PX * STEPS, STEP_PX * STEPS * 0.6)
                        if g == "regrab":
                            # Release first: the point of this gesture is to
                            # re-take the node after letting go. Leaving the
                            # button down made it one continuous drag, and the
                            # offset metric then reported the probe's own
                            # second move as a 42px "jump".
                            pg.wait_for_timeout(220)
                            back = pg.evaluate(WHERE)
                            pg.mouse.move(back["screen"]["x"], back["screen"]["y"])
                            pg.wait_for_timeout(80)
                            pg.mouse.down()
                            pg.wait_for_timeout(120)
                            pg.mouse.move(back["screen"]["x"] - 40, back["screen"]["y"] - 25, steps=1)

                    pg.evaluate(MARK, "up")
                    samples = watch(pg, args.watch_ms)
                    if g == "regrab":
                        pg.mouse.up()
                        pg.wait_for_timeout(150)

                    base = {n["id"]: n for n in samples[0][1]}
                    drift, drift_id, drift_at = 0.0, "", 0
                    for ms, reading in samples:
                        for n in reading:
                            b0 = base.get(n["id"])
                            if not b0:
                                continue
                            d = max(abs(n["x"] - b0["x"]), abs(n["y"] - b0["y"]))
                            if d > drift:
                                drift, drift_id, drift_at = d, n["id"], ms

                    got = pg.evaluate(TAKE)
                    a = analyse(got["trace"], got["writes"])
                    bad = a["grab_jump"] > TOL or a["rigid_jump"] > 2 or drift > 2
                    rows.append({"gesture": g, "trial": trial, "bad": bad, "drift": drift,
                                 "drift_id": drift_id, "drift_at": drift_at, **a})
                    print(f"  [{trial}] 采样 {a['samples']:3d}  "
                          f"抓取偏移突变 {a['grab_jump']:6.1f}px (容差 {TOL})  "
                          f"刚性偏差 {a['rigid_jump']:6.1f}px  "
                          f"松手后位移 {drift:5.1f}px  "
                          f"松手后写入 {a.get('post_writes', 0)} 次  "
                          f"{'FLASH' if bad else 'ok'}")
                    for o in a["offenders"][:3]:
                        print(f"        {o['id'][-6:]} selected={o['selected']} "
                              f"实际移动 ({o['moved'][0]:+.1f},{o['moved'][1]:+.1f}) "
                              f"应为 ({o['expected'][0]:+.1f},{o['expected'][1]:+.1f}) "
                              f"偏差 {o['dev']:.1f}px")
                    if a["grab_jump"] > TOL and a["grab_axis"]:
                        print(f"        抓取偏移基准 ({a['grab_axis'][0]:+.1f},"
                              f"{a['grab_axis'][1]:+.1f})  —— 节点相对指针滑了 "
                              f"{a['grab_jump']:.1f}px")
                        print("        t(ms)  offsetX  offsetY  grabbed")
                        for t, ox, oy, gr in a["series"]:
                            print(f"        {t:5d}  {ox:7.1f}  {oy:7.1f}  {gr}")
                    pg.wait_for_timeout(300)

            b.close()
    finally:
        cur = read_topology()
        cur["nodes"] = pristine["nodes"]
        cur["links"] = pristine["links"]
        cur["groups"] = pristine.get("groups", [])
        cur["canvas_items"] = pristine.get("canvas_items", [])
        restored = write_topology(cur).get("topology", {})
        print(f"\n已复原节点位置，version={restored.get('version')}  "
              f"nodes={[(n['node_id'][-6:], n['x'], n['y']) for n in restored.get('nodes', [])]}")

    print(f"\n共 {len(rows)} 次试验")
    for g in gestures:
        sub = [r for r in rows if r["gesture"] == g]
        if not sub:
            continue
        print(f"  {g:<7} 抓取偏移 {max(r['grab_jump'] for r in sub):6.1f}px  "
              f"刚性偏差 {max(r['rigid_jump'] for r in sub):6.1f}px  "
              f"松手后位移 {max(r['drift'] for r in sub):5.1f}px  "
              f"异常 {len([r for r in sub if r['bad']])}/{len(sub)}")
    return 1 if any(r["bad"] for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
