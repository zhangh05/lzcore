"""Remove probe debris from the topology canvas, through the product's own path.

Why this exists
---------------
Probe runs that crash before their own cleanup leave nodes on the drawing. The
next run then measures a polluted baseline, and — worse — a drawing with five or
more devices is exactly the state in which this canvas's renderer hit test and
`renderedPosition()` come apart (see device_add_probe.py), so the pollution
turns into false failures that look like product defects.

Deleting the file directly would be a lie: the app keeps its own state, revision
history and version counter, and a hand edit desynchronises all three. So this
goes through the UI exactly as a user would — select on the canvas, press
Delete, answer the confirm dialog.

Safety
------
It only ever removes nodes whose label is *not* in the keep list, and it prints
the before/after sets so the change is visible rather than assumed. Take a copy
of the topology file first if the content matters:

    cp .../topo_XXXX.json /tmp/lz_backup/

Usage:
  python canvas_cleanup.py                      # keep AR1, CE1
  python canvas_cleanup.py --keep AR1,CE1,SW1
  python canvas_cleanup.py --shot DIR
"""

import argparse
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5273"

SETUP = """
() => {
  const host = document.querySelector('.netops-cytoscape');
  window.__cy = host._cyreg.cy;
  window.__host = host;
  return true;
}
"""

NODES = """
() => window.__cy.nodes()
  .filter(n => !n.id().startsWith('group-') && !n.id().startsWith('canvas-'))
  .map(n => ({ id: n.id(), label: n.data('label'), selected: n.selected() }))
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", default="AR1,CE1", help="逗号分隔：保留哪些设备的名称")
    ap.add_argument("--shot", default=None, help="目录：前后截图")
    args = ap.parse_args()

    keep = [name.strip() for name in args.keep.split(",") if name.strip()]

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        page.goto(f"{BASE}/topology", wait_until="networkidle")
        page.wait_for_timeout(3200)
        page.evaluate(SETUP)

        before = page.evaluate(NODES)
        print(f"清理前 {len(before)} 台：{[n['label'] for n in before]}")
        if args.shot:
            page.screenshot(path=f"{args.shot}/cleanup_00_before.png")

        doomed = [n for n in before if n["label"] not in keep]
        if not doomed:
            print("没有需要清理的设备，画布已是目标状态。")
            browser.close()
            return 0

        print(f"将移除 {len(doomed)} 台：{[n['label'] for n in doomed]}")
        print(f"保留 {len(before) - len(doomed)} 台：{keep}")

        # Select exactly the doomed set. Everything else is unselected first so
        # the batch delete cannot reach past its target.
        page.evaluate(
            """(ids) => {
                 const cy = window.__cy;
                 cy.elements().unselect();
                 ids.forEach(id => cy.getElementById(id).select());
                 return cy.$('node:selected').length;
               }""",
            [n["id"] for n in doomed],
        )
        page.wait_for_timeout(600)
        selected = page.evaluate("() => window.__cy.$('node:selected').length")
        if selected != len(doomed):
            print(f"中止：选中的是 {selected} 台，期望 {len(doomed)} 台 —— 不按 Delete。")
            browser.close()
            return 1

        page.keyboard.press("Delete")
        page.wait_for_timeout(1200)

        confirm = page.locator("button", has_text="移除")
        count = confirm.count()
        if not count:
            print("中止：没有出现确认对话框，画布未被改动。")
            browser.close()
            return 1
        # The dialog's own confirm button reads exactly 移除; the inspector also
        # carries one reading 从拓扑中移除节点, so match on the exact label.
        target = None
        for i in range(count):
            if confirm.nth(i).inner_text().strip() == "移除":
                target = confirm.nth(i)
                break
        if target is None:
            print(f"中止：{count} 个按钮里没有一个是“移除”，画布未被改动。")
            browser.close()
            return 1
        target.click()
        page.wait_for_timeout(3600)

        after = page.evaluate(NODES)
        print(f"清理后 {len(after)} 台：{[n['label'] for n in after]}")
        if args.shot:
            page.screenshot(path=f"{args.shot}/cleanup_01_after.png")

        leftover = [n["label"] for n in after if n["label"] not in keep]
        browser.close()

        if leftover:
            print(f"失败：仍有残留 {leftover}")
            return 1
        print(f"完成：画布已回到 {keep}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
