"""Show that a late reload drags nodes back to where they were one edit ago.

The hypothesis this tests
-------------------------
`executeSave` finishes by calling `onReload()`, which refetches the topology
list. `currentTopology` is derived from that list, and an effect adopts it into
`activeTopology` whenever the save status is "saved":

    if (saveStatusRef.current !== "saved") return;
    setActiveTopology(currentTopology);

The guard covers "a save is in flight". It does not cover "this reload was
issued before a *later* save, and is only now resolving". Two reloads can
overlap like this:

    t=0     save 1 lands, status "saved", reload #1 starts (six GETs)
    t=100   user drags again
    t=900   save 2 lands, status "saved", reload #2 starts
    t=1000  reload #1 resolves — carrying the list as of t≈0
            status is "saved", so it is adopted: every node snaps back
    t=1100  reload #2 resolves — everything snaps forward again

Two jumps, one edit apart, and the user calls it a flash. Nothing in the effect
compares versions, even though `serverVersionsRef` holds exactly the number
needed to tell the stale list from the fresh one.

How it is made deterministic
----------------------------
Hold reload #1's list request open with `route.fetch()`: the request really is
performed, so nothing is faked and the server is genuinely current — only the
*reply* is withheld. Drag again, let save 2 and its own reload land, then
release reload #1 and watch the node.

Reading the reply out of order is exactly what a slow response, a read replica
or a cached list does on its own schedule; holding it just removes the luck.

The touched node is restored on exit.

Usage:
  python reload_stale_probe.py
"""

import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
API = "http://127.0.0.1:8011/api/extensions/network.operations"
TOPO = "topo_894e4566e217"

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  const cy = host._cyreg.cy;
  window.__cy = cy; window.__host = host;
  window.__target = cy.nodes().filter(n =>
    !n.id().startsWith('group-') && !n.id().startsWith('canvas-'))[0];
  cy.center(window.__target);
  return { id: window.__target.id() };
}
"""

WHERE = """
() => {
  const r = window.__host.getBoundingClientRect();
  const rp = window.__target.renderedPosition();
  return { screen: { x: r.x + rp.x, y: r.y + rp.y } };
}
"""

READ = "() => { const p = window.__target.position(); return { x: p.x, y: p.y }; }"


def read_topology():
    return json.load(urllib.request.urlopen(f"{API}/topologies/{TOPO}?workspace_id=default", timeout=5))["topology"]


def write_topology(t):
    body = {"workspace_id": "default", "name": t["name"], "description": t.get("description", ""),
            "version": t["version"], "nodes": t["nodes"], "links": t["links"],
            "groups": t.get("groups", []), "canvas_items": t.get("canvas_items", [])}
    req = urllib.request.Request(f"{API}/topologies/{TOPO}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="PUT")
    return json.load(urllib.request.urlopen(req, timeout=10))


def drag(page, start, dx, dy):
    page.mouse.move(start["x"], start["y"])
    page.wait_for_timeout(120)
    page.mouse.down()
    page.wait_for_timeout(180)
    for i in range(1, 13):
        page.mouse.move(start["x"] + dx * i / 12, start["y"] + dy * i / 12, steps=1)
        page.wait_for_timeout(28)
    page.mouse.up()


def main() -> int:
    pristine = read_topology()
    print(f"原始 version={pristine['version']}  "
          f"nodes={[(n['node_id'][-6:], n['x'], n['y']) for n in pristine['nodes']]}")

    hold = {"on": False}
    held = []
    code = 0

    def on_route(route):
        url = route.request.url.split("?")[0]
        # Only the *list* endpoint, and only the one we asked to hold.
        if (route.request.method == "GET" and url.endswith("/topologies")
                and hold["on"] and not held):
            hold["on"] = False
            held.append((route, route.fetch()))      # perform it, keep the reply
            return
        route.continue_()

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 1500, "height": 950})
            ctx.route("**/topologies*", on_route)
            pg = ctx.new_page()
            pg.goto(f"{BASE}/topology", wait_until="domcontentloaded")
            pg.wait_for_timeout(4500)

            info = pg.evaluate(SETUP)
            print(f"目标设备 {info['id'][-6:]}\n")

            # ── edit 1: arm the hold so that its reload gets captured
            hold["on"] = True
            start = pg.evaluate(WHERE)["screen"]
            drag(pg, start, 130, 78)
            p1 = pg.evaluate(READ)
            print(f"[1] 第一次拖拽结束 ({p1['x']:.1f},{p1['y']:.1f})，等待它的保存与重载")

            deadline = time.time() + 8
            while not held and time.time() < deadline:
                pg.wait_for_timeout(100)
            if not held:
                print("!! 没有扣住列表请求，本次无法判定")
                b.close()
                return 2
            print("[2] 第一次保存已落地，它触发的列表请求被扣住（服务端是最新的）")

            # ── edit 2, and let everything of it complete
            start = pg.evaluate(WHERE)["screen"]
            drag(pg, start, -90, -54)
            print("[3] 第二次拖拽结束，等它的保存与重载都落地")
            pg.wait_for_timeout(2600)
            p2 = pg.evaluate(READ)
            print(f"[4] 稳定在 ({p2['x']:.1f},{p2['y']:.1f})")

            # ── release the stale list
            held[-1][0].fulfill(response=held[-1][1])
            print("[5] 放行第一次保存触发的（陈旧的）列表响应")
            worst = 0.0
            worst_at = 0
            t0 = time.monotonic()
            for _ in range(90):
                now = pg.evaluate(READ)
                d = max(abs(now["x"] - p2["x"]), abs(now["y"] - p2["y"]))
                if d > worst:
                    worst, worst_at = d, round((time.monotonic() - t0) * 1000)
                pg.wait_for_timeout(20)
            after = pg.evaluate(READ)
            print(f"[6] 放行后位移 {worst:.1f}px @{worst_at}ms，"
                  f"停在 ({after['x']:.1f},{after['y']:.1f})")
            print(f"    回到第一次拖拽的落点 ({p1['x']:.1f},{p1['y']:.1f}): "
                  f"{abs(after['x'] - p1['x']) < 2 and abs(after['y'] - p1['y']) < 2}")

            if worst > 2:
                print("\n=> 缺陷存在：迟到的重载把节点拖回了一次编辑之前的位置")
                code = 1
            else:
                print("\n=> 正常：迟到的重载没有覆盖更新的本地状态")
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
