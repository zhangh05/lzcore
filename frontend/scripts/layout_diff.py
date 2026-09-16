"""Diff two layout probes. Any difference is a cascade regression to explain."""

import json
import sys

before = json.load(open(sys.argv[1], encoding="utf-8"))
after = json.load(open(sys.argv[2], encoding="utf-8"))

IGNORE = {"backgroundColor", "color"}  # reported separately, not treated as layout
diffs = []
for route in sorted(set(before) | set(after)):
    if route.startswith("__"):
        continue
    for selector in sorted(set(before.get(route, {})) | set(after.get(route, {}))):
        left = before.get(route, {}).get(selector)
        right = after.get(route, {}).get(selector)
        if left is None or right is None:
            diffs.append(f"{route} {selector}: presence {bool(left)} -> {bool(right)}")
            continue
        if len(left) != len(right):
            diffs.append(f"{route} {selector}: count {len(left)} -> {len(right)}")
            continue
        for index, (a, b) in enumerate(zip(left, right)):
            for key in sorted(set(a) | set(b)):
                if a.get(key) == b.get(key):
                    continue
                if key in IGNORE:
                    diffs.append(f"{route} {selector}[{index}].{key}: {a.get(key)} -> {b.get(key)}")
                else:
                    diffs.append(f"LAYOUT {route} {selector}[{index}].{key}: {a.get(key)} -> {b.get(key)}")

layout_diffs = [d for d in diffs if d.startswith("LAYOUT")]
colour_diffs = [d for d in diffs if not d.startswith("LAYOUT")]
print(f"布局差异: {len(layout_diffs)}")
for line in layout_diffs[:40]:
    print("  ", line)
print(f"颜色差异: {len(colour_diffs)}")
for line in colour_diffs[:15]:
    print("  ", line)
print("页面错误:", before.get("__pageerrors__"), "->", after.get("__pageerrors__"))
