"""Toggle the shared stylesheets between split layers and one collapsed layer.

Why this exists
---------------
A cascade layer beats specificity, so whether two rules agree in *value*
depends on which layer each sits in. The only way to know the split still
preserves behaviour is to measure the same page twice — once split, once
collapsed — and diff the two. This script does the switching; `layout_probe.py`
and `layout_diff.py` do the measuring.

Which state the repo is in
--------------------------
**Split is the committed state.** Each shared sheet owns its layer and
`layers.css` declares the order. `--single` is a temporary, uncommitted detour
taken only to produce the other half of a diff; `--split` puts it back.

So this is not how the split gets installed — that already happened. Running
`--split` on a clean tree is a no-op, and says so. It used to be documented as
"apply the split, then revert with git checkout", which stopped being true the
moment the split was committed: reverting to the committed state now *is* the
split, so that flag silently did nothing.

Usage
-----
    python layer_state.py --status   # which state the working tree is in
    python layer_state.py --split    # the committed state; idempotent
    python layer_state.py --single   # collapse into one `product` layer

Always rebuild after switching. The preview server serves `frontend/dist`, not
these sources, so a switch you have not built is a switch you have not made:

    npm --prefix frontend run build
"""

import argparse
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"

# sheet -> the layer it owns. Imported by cascade_conflicts.py, which refuses to
# measure unless every one of these is present in the loaded CSS.
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

# The order the bundler was already producing, written down. It reads oddly —
# `runtime` first, `typography` after the component layers — because the import
# order it replaces was accidental. Preserving it is the point: a declared order
# that disagrees with the document order is a behaviour change, not a refactor.
# Measured, declaring `typography` second instead of sixth moved the page-header
# h1 from 700/8px back to 600/2px on five routes.
ORDER = ("runtime, base, shell, console, workbench, typography, pages, "
         "extension, responsive")

# `product` has to be declared, and declared first. An undeclared layer is
# appended after every declared one, which would drop the shared sheets in
# behind `responsive` and let them invert the narrow-width rules — a collapsed
# state that measures something nobody ships.
SINGLE_ORDER = "product, extension, responsive"


def _doc(text: str) -> str:
    return text.format(order="{order}")


SPLIT_HEADER = """/**
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
 *   - A modifier belongs in the same layer as the base it modifies. `.btn.sm`
 *     in `base` loses to `.btn` in `console` on every property both set, and
 *     loses silently — the compact buttons just quietly grow back.
 */
@layer {order};
"""

SINGLE_HEADER = """/**
 * Cascade layer order — COLLAPSED STATE, written by `layer_state.py --single`.
 *
 * Not the committed state, and not something to commit. Every shared sheet is
 * back in one `product` layer so the same routes can be measured a second time
 * and diffed against the split. `layer_state.py --split` restores the real file.
 *
 * `product` is declared explicitly and first on purpose: an undeclared layer is
 * appended after every declared one, which would put the shared sheets behind
 * `responsive` and make the narrow-width rules lose to the rules they exist to
 * override. A collapsed state that measures the wrong cascade is worse than no
 * measurement, because the diff looks clean.
 */
@layer {order};
"""


def _rename(src: str, old: str, new: str) -> tuple[str, int]:
    return re.subn(rf"@layer\s+{re.escape(old)}\s*\{{", f"@layer {new} {{",
                   src, count=1)


def _layer_of(src: str, layer: str) -> bool:
    return re.search(rf"@layer\s+{re.escape(layer)}\s*\{{", src) is not None


def _switch(to_split: bool) -> int:
    target = "split" if to_split else "single"
    changed = 0
    problems = []
    for rel, layer in LAYERS:
        path = SRC / rel
        src = path.read_text(encoding="utf-8")
        if to_split:
            if _layer_of(src, layer):
                continue
            new, n = _rename(src, "product", layer)
            if n != 1:
                problems.append(f"{rel}：既不是 @{layer} 也不是 @layer product")
                continue
            path.write_text(new, encoding="utf-8")
            print(f"  {rel}: @layer product -> @layer {layer}")
        else:
            if _layer_of(src, "product"):
                continue
            new, n = _rename(src, layer, "product")
            if n != 1:
                problems.append(f"{rel}：找不到 @layer {layer} {{")
                continue
            path.write_text(new, encoding="utf-8")
            print(f"  {rel}: @layer {layer} -> @layer product")
        changed += 1
    header = SPLIT_HEADER if to_split else SINGLE_HEADER
    order = ORDER if to_split else SINGLE_ORDER
    (SRC / LAYERS_CSS).write_text(header.format(order=order), encoding="utf-8")
    print(f"  {LAYERS_CSS}: {order}")
    for p in problems:
        print(f"  !! {p}")
    if problems:
        print(f"\n{target} 未完整应用 —— 上面 {len(problems)} 个文件状态异常。")
        return 1
    if changed == 0:
        print(f"\n已经是 {target} 状态，无操作。")
    else:
        print(f"\n已切到 {target}（{changed} 个文件）。记得 npm --prefix frontend run build。")
    return 0


def _status() -> int:
    split, single, other = [], [], []
    for rel, layer in LAYERS:
        src = (SRC / rel).read_text(encoding="utf-8")
        if _layer_of(src, layer):
            split.append(rel)
        elif _layer_of(src, "product"):
            single.append(rel)
        else:
            other.append(rel)
    decl = (SRC / LAYERS_CSS).read_text(encoding="utf-8")
    declared = re.search(r"@layer\s+([^;]+);", decl)
    print(f"  {LAYERS_CSS} 声明：{declared.group(1).strip() if declared else '(未找到)'}")
    print(f"  已在自己的层：{len(split)}/{len(LAYERS)}")
    print(f"  已在 product：{len(single)}/{len(LAYERS)}")
    for rel in other:
        print(f"  !! {rel}：层名既不是自己的也不是 product")
    for rel in single:
        if split:
            print(f"  ~  {rel} 落后（其他表已拆层）")
    if not single and not other:
        print("\n状态：拆层（已提交状态）。")
    elif not split and not other:
        print("\n状态：单层（仅供测量，别提交）。")
    else:
        print("\n状态：不一致 —— 部分表已拆，部分没有。测量前先 --split 或 --single。")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--split", action="store_true",
                       help="切到已提交的拆层状态（幂等）")
    group.add_argument("--single", action="store_true",
                       help="临时把所有共享表收回一个 product 层，用于对照测量")
    group.add_argument("--status", action="store_true", help="只报告当前状态")
    args = ap.parse_args()
    if args.split:
        return _switch(True)
    if args.single:
        return _switch(False)
    return _status()


if __name__ == "__main__":
    sys.exit(main())
