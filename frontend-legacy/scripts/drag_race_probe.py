"""Reproduce the race where a save round-trip yanks a node out of an active drag.

Symptom it was written for: "dragging a device still sometimes flashes it
somewhere else". Intermittent because it is a race, and the window is small.

Two paths replace the whole topology from the server and neither knows a drag is
in progress:

  * the debounced PUT's reply is adopted when nothing has been *committed* since
    the request was issued (`revisionRef`) — and a drag in progress is not a
    commit yet;
  * the `onReload()` that follows a successful save refetches the list, and an
    effect keyed on the list copy swaps it into `activeTopology`, guarded only by
    save status — so its window is the whole reload round-trip.

Both converge on `applyElements`, which force-syncs positions from the props. A
node being held by the pointer gets its live position overwritten, springs back
to wherever the last save left it, and the drag in progress is discarded.

Method
------
Drag once and commit, so the debounced save is scheduled. Then hold the PUT's
*reply* open — `route.fetch()` still performs the write, so the server is
genuinely up to date and nothing is faked — and grab the node again while the
reply is still in flight. Release the reply and watch the node.

Holding the reply is what makes the race deterministic. Sleeping inside a route
handler would not work: it blocks the same event loop the drag needs.

A node that springs back to its previous resting place with the pointer still
down is the defect. The positions touched by this probe are restored on exit.
"""

import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

from probe_target import require_topology_target  # --topology-id is required

BASE = "http://127.0.0.1:5273"
API = "http://127.0.0.1:8011/api/extensions/network.operations"
TOPO, WORKSPACE = require_topology_target()

GEO = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  const target = cy.nodes().filter(n => !n.id().startsWith('group-'))[0];
  cy.center(target);
  window.__cy = cy; window.__target = target;
  const r = host.getBoundingClientRect();
  return { id: target.id(), model: target.position(), rp: target.renderedPosition(),
           rect: { x: r.x, y: r.y } };
}
"""

READ = "() => { const t = window.__target; return { x: t.position().x, y: t.position().y, grabbed: t.grabbed() }; }"


def read_topology():
    return json.load(urllib.request.urlopen(f"{API}/topologies/{TOPO}?workspace_id={WORKSPACE}", timeout=5))["topology"]


def write_topology(t):
    body = {"workspace_id": WORKSPACE, "name": t["name"], "description": t.get("description", ""),
            "version": t["version"], "nodes": t["nodes"], "links": t["links"],
            "groups": t.get("groups", []), "canvas_items": t.get("canvas_items", [])}
    req = urllib.request.Request(f"{API}/topologies/{TOPO}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="PUT")
    return json.load(urllib.request.urlopen(req, timeout=10))


def main():
    pristine = read_topology()
    print(f"原始 version={pristine['version']}  "
          f"nodes={[(n['node_id'][-6:], n['x'], n['y']) for n in pristine['nodes']]}")

    held = []
    code = 2

    def on_route(route):
        if route.request.method != "PUT":
            route.continue_()
            return
        held.append((route, route.fetch()))     # write through, keep the reply

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 1500, "height": 950})
            ctx.route("**/topologies/*", on_route)
            pg = ctx.new_page()
            pg.goto(f"{BASE}/topology", wait_until="domcontentloaded")
            pg.wait_for_timeout(4500)

            pg.evaluate(GEO)
            pg.wait_for_timeout(500)
            info = pg.evaluate(GEO)
            sx = info["rect"]["x"] + info["rp"]["x"]
            sy = info["rect"]["y"] + info["rp"]["y"]
            print(f"\n拖动对象 {info['id'][-6:]}  起点=({info['model']['x']:.0f},{info['model']['y']:.0f})")

            pg.mouse.move(sx, sy)
            pg.wait_for_timeout(150)
            pg.mouse.down()
            pg.wait_for_timeout(200)
            for i in range(1, 13):
                pg.mouse.move(sx + 12 * i, sy + 8 * i, steps=1)
                pg.wait_for_timeout(30)
            pg.mouse.up()
            pg.wait_for_timeout(200)
            p1 = pg.evaluate(READ)
            print(f"[1] 第 1 次拖拽结束并提交  ({p1['x']:.1f},{p1['y']:.1f})  —— 800ms 后触发保存")

            deadline = time.time() + 5
            while not held and time.time() < deadline:
                pg.wait_for_timeout(100)
            if not held:
                print("!! 没有捕获到保存请求，本次无法判定")
                b.close()
                return 2
            print("[2] 保存已真正写入服务端，但响应被扣住未返回")

            pg.evaluate(GEO)
            pg.wait_for_timeout(400)
            info2 = pg.evaluate(GEO)
            ax = info2["rect"]["x"] + info2["rp"]["x"]
            ay = info2["rect"]["y"] + info2["rp"]["y"]
            pg.mouse.move(ax, ay)
            pg.wait_for_timeout(150)
            pg.mouse.down()
            pg.wait_for_timeout(150)
            for i in range(1, 5):
                pg.mouse.move(ax - 10 * i, ay - 7 * i, steps=1)
                pg.wait_for_timeout(40)
            mid = pg.evaluate(READ)
            print(f"[3] 第 2 次拖拽中，按住不放  ({mid['x']:.1f},{mid['y']:.1f})  grabbed={mid['grabbed']}")

            before = (mid["x"], mid["y"])
            held[-1][0].fulfill(response=held[-1][1])
            pg.wait_for_timeout(120)
            after = pg.evaluate(READ)
            pg.mouse.up()
            pg.wait_for_timeout(300)

            dx, dy = after["x"] - before[0], after["y"] - before[1]
            snapped = abs(after["x"] - p1["x"]) < 2 and abs(after["y"] - p1["y"]) < 2
            jump = abs(dx) > 5 or abs(dy) > 5

            print(f"[4] 响应落地瞬间位移  dx={dx:+.1f}  dy={dy:+.1f} model px")
            print(f"    落点 == 上一次提交的静止位置: {snapped}")
            if jump and snapped:
                print("\n=> 缺陷存在：保存响应在拖拽途中把节点弹回了上一次的静止位置")
                code = 1
            elif jump:
                print("\n=> 节点被挪动了，但落点不是上一次的静止位置（另有来源，需再查）")
                code = 1
            else:
                print("\n=> 正常：拖拽途中的节点没有被外部写入改动")
                code = 0
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

    return code


if __name__ == "__main__":
    sys.exit(main())
