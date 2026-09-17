"""Measure where a topology canvas item's label actually lands.

Why this exists
---------------
Cytoscape paints nodes and their labels to a `<canvas>`. There is no DOM element
to inspect, so the stylesheet is the only readable thing — and it is exactly the
wrong thing to read here, because the bug this was written for was a *semantic*
mismatch that looks perfectly reasonable in source.

`.canvas-item-text` asked for `text-halign: left`. That reads like "left-align
the text", and it means "hang the label off the node's left side" — i.e. put it
outside the box entirely. The rendered offset was -149px, with the glyphs 43px
clear of the box's left edge. No amount of reading the rule list says that.

A second defect was hiding underneath: the shared `node` rule nudges every label
8px down so a device name sits under its icon. Canvas items never reset it, so
their labels sat ~10px below the middle of their own box — obvious on a 36px-tall
text box, invisible on a 110px-tall ellipse.

How it measures
---------------
Everything happens in the renderer's own pixel space. `getImageData` returns
canvas pixels, and `renderedPosition()` speaks the same units, so there is no
coordinate translation to get wrong. (An earlier version mixed
`getBoundingClientRect()` with `renderedPosition()` and reported a confident
27px offset that was entirely the probe's own error: a container's border box is
not the origin of its canvas.)

Two details that are easy to get wrong:

  * Isolation has to be applied in one call and the pixels read in the next.
    `cy.style()` takes effect on the following render, so reading in the same
    synchronous call returns the previous frame — which silently reports every
    item as having identical glyphs.
  * The read is windowed to the item's neighbourhood, so a failure to isolate
    cannot quietly pull in a neighbouring label.

Usage:
  python canvas_label_probe.py              # canvas items
  python canvas_label_probe.py --devices    # device nodes, to check for regressions
  python canvas_label_probe.py --tag before # keep a JSON snapshot to diff against
"""

import argparse
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"
DARK = 120

CY = "[...document.querySelectorAll('div')].map(d => d._cyreg && d._cyreg.cy).find(Boolean)"

SETUP = f"""
() => {{
  const cy = {CY};
  if (!cy) return {{ error: 'no cytoscape instance on this page' }};
  window.__cy = cy;
  return {{
    zoom: cy.zoom(),
    canvases: cy.container().querySelectorAll('canvas').length,
    items: cy.nodes().map(n => n.id()).filter(id => !id.startsWith('group-')),
  }};
}}
"""

GEO = f"""
(id) => {{
  const cy = {CY}, n = cy.getElementById(id);
  const c = n.renderedPosition();
  return {{
    id, label: n.data('label'), classes: String(n.classes()),
    box: {{ w: n.width(), h: n.height() }},
    centre: {{ x: c.x, y: c.y }},
    style: {{
      halign: n.style('text-halign'), valign: n.style('text-valign'),
      marginX: n.style('text-margin-x'), marginY: n.style('text-margin-y'),
      fontSize: n.style('font-size'),
    }},
  }};
}}
"""

ISOLATE = f"""
({{ id, devices }}) => {{
  const cy = {CY}, n = cy.getElementById(id);
  cy.elements().not(n).style({{ opacity: 0, 'text-opacity': 0 }});
  // A device node's own icon is dark and would be counted as glyph pixels.
  // `background-image: none` does not clear it — `background-image-opacity` does.
  if (devices) n.style({{ 'background-image-opacity': 0, 'background-opacity': 0, 'border-width': 0 }});
}}
"""

RESTORE = f"() => {{ {CY}.elements().removeStyle(); }}"

READ = f"""
({{ id, pad }}) => {{
  const cy = {CY};
  const n = cy.getElementById(id);
  const c = n.renderedPosition();
  const half = Math.max(n.width(), n.height()) * cy.zoom() / 2 + pad;
  const win = {{ x: c.x - half, y: c.y - half, w: half * 2, h: half * 2 }};

  let x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1;
  for (const cv of cy.container().querySelectorAll('canvas')) {{
    const sc = cv.width / cv.clientWidth;
    const sx = Math.max(0, Math.round(win.x * sc));
    const sy = Math.max(0, Math.round(win.y * sc));
    const sw = Math.min(cv.width - sx, Math.round(win.w * sc));
    const sh = Math.min(cv.height - sy, Math.round(win.h * sc));
    if (sw <= 0 || sh <= 0) continue;
    const img = cv.getContext('2d').getImageData(sx, sy, sw, sh);
    const px = img.data, W = img.width, H = img.height;
    for (let y = 0; y < H; y++) {{
      for (let x = 0; x < W; x++) {{
        const o = (y * W + x) * 4;
        if (px[o + 3] < 8) continue;
        if (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114 >= {DARK}) continue;
        const ax = (sx + x) / sc, ay = (sy + y) / sc;
        if (ax < x1) x1 = ax;
        if (ay < y1) y1 = ay;
        if (ax > x2) x2 = ax;
        if (ay > y2) y2 = ay;
      }}
    }}
  }}
  return x2 < 0 ? null : {{ x1, y1, x2, y2 }};
}}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--devices", action="store_true", help="measure device nodes instead of canvas items")
    ap.add_argument("--tag", default="", help="write a JSON snapshot to /tmp/canvas_label_<tag>.json")
    ap.add_argument("--pad", type=int, default=60, help="scan window padding around the node, in screen px")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
        page.goto(f"{BASE}/topology", wait_until="networkidle")
        page.wait_for_timeout(2500)

        info = page.evaluate(SETUP)
        if "error" in info:
            print(info["error"])
            browser.close()
            return 1

        want = "manual-node" if args.devices else "canvas-item"
        targets = []
        for i in info["items"]:
            geo = page.evaluate(GEO, i)
            if want in geo["classes"]:
                targets.append((i, geo))

        print(f"zoom={info['zoom']:.4f}  canvases={info['canvases']}  targets={len(targets)}")
        snapshot = {"zoom": info["zoom"], "items": []}

        for tid, geo in targets:
            page.evaluate(ISOLATE, {"id": tid, "devices": args.devices})
            page.wait_for_timeout(200)
            glyphs = page.evaluate(READ, {"id": tid, "pad": args.pad})
            page.evaluate(RESTORE)
            page.wait_for_timeout(80)

            s, b, c = geo["style"], geo["box"], geo["centre"]
            print(f"\n--- {tid[-6:]}  label={geo['label']!r}  [{geo['classes']}]")
            print(f"    halign={s['halign']} valign={s['valign']} "
                  f"marginX={s['marginX']} marginY={s['marginY']}   box {b['w']}x{b['h']}")
            if not glyphs:
                print("    no glyphs found in the scan window")
                continue

            gcx = (glyphs["x1"] + glyphs["x2"]) / 2
            gcy = (glyphs["y1"] + glyphs["y2"]) / 2
            gw = glyphs["x2"] - glyphs["x1"]
            gh = glyphs["y2"] - glyphs["y1"]
            dx, dy = gcx - c["x"], gcy - c["y"]
            print(f"    glyphs  {gw:6.1f} x {gh:6.1f}   (model px)")
            print(f"    offset from the item's own centre   dx={dx:+7.1f}  dy={dy:+7.1f}")
            if not args.devices:
                inside = (abs(dx) + gw / 2 <= b["w"] / 2) and (abs(dy) + gh / 2 <= b["h"] / 2)
                print(f"    GLYPHS INSIDE THEIR OWN BOX: {inside}")
            snapshot["items"].append({**geo, "glyphs": glyphs, "dx": dx, "dy": dy})

        if args.tag:
            out = f"/tmp/canvas_label_{args.tag}.json"
            json.dump(snapshot, open(out, "w"), ensure_ascii=False, indent=2)
            print(f"\nwrote {out}")

        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
