"""Apply or revert the per-stylesheet cascade-layer split, for measurement.

Why this exists
---------------
The layer split cannot be evaluated in the single-layer state: the conflict
enumerator (`cascade_conflicts.py`) reads each rule's layer from the CSS, so
with everything in one `product` layer it has nothing to compare and reports
0 flips — a silent zero that reads like success. The split therefore has to be
applied before it can be measured, and reverted afterwards, once per round.

That is the loop the audit describes ("改一条 → 构建 → 探针 → 对比", repeated
7+ times), so the mechanical half of it lives here rather than in a shell
one-liner that has to be re-derived each time.

What it does
------------
Each shared stylesheet already wraps its rules in `@layer product { ... }`.
Applying the split renames that wrapper to the sheet's own layer:

    global.css            -> base
    typography.css        -> typography
    product-shell.css     -> shell
    console-system.css    -> console
    AgentWorkbench.css    -> workbench
    RuntimeEventTimeline.css -> runtime

and rewrites `layers.css` to declare the split order. Reverting is
`git checkout` of the same files, because the single-layer state is committed.

Usage:
    python apply_layer_split.py --apply     # then build, probe, enumerate
    python apply_layer_split.py --revert    # back to the committed state

The revert refuses to run if any of the files has changes beyond the split, so
it cannot silently throw away unrelated work.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"

# sheet -> its layer, in the order the split declares them.
LAYERS = [
    ("styles/global.css", "base"),
    ("styles/typography.css", "typography"),
    ("styles/product-shell.css", "shell"),
    ("styles/console-system.css", "console"),
    ("pages/AgentWorkbench/AgentWorkbench.css", "workbench"),
    ("components/RuntimeEventTimeline.css", "runtime"),
    ("styles/pages.css", "pages"),
]

LAYERS_CSS = "styles/layers.css"
# This is the order the bundler already produced, now written down instead of
# left to the import statements. It is *not* the order the sheets are listed in
# `main.tsx` reads as "sensible": `typography.css` is imported after
# `console-system.css`, and `RuntimeEventTimeline.css` before `global.css`. A
# declared order that disagrees with the document order is not a no-op — it is
# a behaviour change, and it is exactly the kind that looks clean: measured,
# declaring `typography` second instead of sixth moved the page-header's h1
# from 700/8px back to 600/2px on five routes.
ORDER = ("runtime, base, shell, console, workbench, typography, pages, "
         "extension, responsive")

ORDER_HEADER = """/**
 * Cascade layer order — the single place that decides which stylesheet wins.
 *
 * `product` used to be one layer covering every shared sheet, because a split
 * changes outcomes: a layer beats specificity, and the previous cascade
 * resolved conflicts by specificity first and fell back to load order. The
 * split was therefore earned one conflict at a time, each verified against the
 * layout probe, until it stopped moving a box.
 *
 * The order below is the order the bundler was already producing, declared.
 * It reads oddly — `runtime` first, `typography` after the component layers —
 * because the import order it replaces was accidental. Preserving it is the
 * whole point: a declared order that disagrees with the document order is a
 * behaviour change, not a refactor. Reordering these deliberately is a
 * separate change, and one the layout probe can measure.
 *
 *   1. runtime      runtime event timeline — imported first, so weakest
 *   2. base         foundation: tokens, resets, element defaults
 *   3. shell        the application shell
 *   4. console      Design System 3.0 primitives and page compositions
 *   5. workbench    the agent workbench
 *   6. typography   element-level type scale. It has to beat the component
 *                   layers, because `.page-header h1` here is the one that
 *                   wins over console-system.css's copy.
 *   7. pages        page-specific refinements. A page refines the design
 *                   system, and it used to do that by *selector weight* — so
 *                   `.kl-stats .stat-card` out-weighed the design system's
 *                   `.stat-card`. A layer beats specificity, so that weight
 *                   only still works if the refinement sits in a later layer.
 *                   Without this the split moves 135 declarations.
 *   8. extension    extension pages
 *   9. responsive   narrow-width adaptations, which must outrank everything
 *
 * Rules for future work:
 *   - Never resolve a conflict by reordering imports; put the rule in the layer
 *     that owns the concern, or scope the selector.
 *   - Unlayered rules beat every layer, so a stylesheet that forgets to declare
 *     a layer silently wins over all of these. Keep every sheet layered.
 *   - Extension styles must stay scoped to the extension's own root class.
 */
@layer {order};
"""


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=SRC.parent.parent,
                          capture_output=True, text=True, check=True).stdout


def apply_split() -> int:
    changed = []
    for rel, layer in LAYERS:
        path = SRC / rel
        src = path.read_text(encoding="utf-8")
        if re.search(rf"@layer\s+{layer}\s*\{{", src):
            print(f"  已是 {layer}：{rel}")
            continue
        new, n = re.subn(r"@layer\s+product\s*\{", f"@layer {layer} {{", src, count=1)
        if n != 1:
            print(f"  !! {rel}：找到 {n} 处 `@layer product`，期望 1 —— 跳过")
            return 1
        path.write_text(new, encoding="utf-8")
        changed.append(rel)
        print(f"  {rel}: @layer product -> @layer {layer}")
    (SRC / LAYERS_CSS).write_text(ORDER_HEADER.format(order=ORDER), encoding="utf-8")
    print(f"  {LAYERS_CSS}: 声明顺序 {ORDER}")
    print(f"\n已应用拆层（{len(changed)} 个文件改动）。测量完请 --revert。")
    return 0


def unapply_split() -> int:
    """Rename the layers back to `product`, keeping any other edits.

    `--revert` throws the whole directory back to the committed state, which is
    right when the only change is the split. It is wrong in the middle of a fix:
    the fix under test is uncommitted, so checking out would delete it along
    with the split it was meant to be measured against. This renames the layers
    back and touches nothing else.
    """
    for rel, layer in LAYERS:
        path = SRC / rel
        src = path.read_text(encoding="utf-8")
        new, n = re.subn(rf"@layer\s+{layer}\s*\{{", "@layer product {", src, count=1)
        if n != 1:
            print(f"  !! {rel}：找不到 `@layer {layer} {{`，跳过")
            continue
        path.write_text(new, encoding="utf-8")
        print(f"  {rel}: @layer {layer} -> @layer product")
    # layers.css is only ever the declaration, so restoring it from git cannot
    # lose anything.
    git("checkout", "--", f"frontend/src/{LAYERS_CSS}")
    print(f"  {LAYERS_CSS}: 恢复为已提交的单层声明")
    print("\n已取消拆层（保留了其他改动）。")
    return 0


def revert_split() -> int:
    # Only ever throw away the split itself. Anything else is someone's work.
    allowed = {rel for rel, _ in LAYERS} | {LAYERS_CSS}
    paths = {line.split()[-1] for line in
             git("status", "--short", "--", "frontend/src").splitlines() if line.strip()}
    unexpected = {p.replace("frontend/src/", "") for p in paths} - allowed
    if unexpected:
        print(f"  !! 除拆层外还有别的改动：{sorted(unexpected)}")
        print("     先处理它们，避免被一并丢掉。")
        return 1
    git("checkout", "--", "frontend/src")
    print("已还原到已提交的单层状态。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--apply", action="store_true")
    group.add_argument("--unapply", action="store_true",
                       help="只把层名改回 product，保留其他改动")
    group.add_argument("--revert", action="store_true")
    args = ap.parse_args()
    if args.apply:
        return apply_split()
    if args.unapply:
        return unapply_split()
    return revert_split()


if __name__ == "__main__":
    sys.exit(main())
