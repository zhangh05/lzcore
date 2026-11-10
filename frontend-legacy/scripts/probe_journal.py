"""A write-ahead journal, so a killed probe cannot leave the drawing moved.

Why this exists
---------------
Several probes drag a real device, which commits and persists, and then put it
back at the end. But "the end" is after the browser closes, so anything that
stops the process in between — Ctrl-C, a timeout, a SIGTERM, a crash — skips
the restore and leaves the user's drawing moved, permanently and silently.

That is not hypothetical. It happened here: a killed `interface_label_probe`
run left AR1 at (362,542) instead of (292,503). The next run then read
(362,542) as "the original" and faithfully restored to it, so the damage
survived the very run that was supposed to prevent it. Restoring on the way
out cannot protect against a process that never reaches the way out.

The revision history does not help either, which is worth knowing: layout-only
moves are deliberately not revisioned (`service.py`), so all 40 revisions show
the pristine coordinate while the live file is already wrong. Reading history
is not a way to notice this.

The fix is the ordinary one: write down what you are about to change, before
you change it. A journal that outlives the process turns "restore on the way
out" into "restore on the way in" — and the way in happens even after a kill.

Usage
-----
    from probe_journal import ProbeJournal

    journal = ProbeJournal("interface_label_probe")

    # First thing, before the browser opens: undo whatever a previous run left.
    journal.repair(read_topology, write_topology, TOPOLOGY_ID)

    # Immediately before the first mutation.
    journal.record(read_topology(), TOPOLOGY_ID)

    # And again on the way out, so the normal path stays clean.
    journal.repair(read_topology, write_topology, TOPOLOGY_ID)

`read_topology()` returns the product's topology dict; `write_topology(t)`
writes it back through the product's own endpoint. Both are supplied by the
caller so this module needs to know nothing about the API.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

# Next to the scripts, so it is obvious where to look when a run dies. Not in
# /tmp: a reboot is exactly when someone would want to know a run was killed.
JOURNAL_DIR = os.path.dirname(os.path.abspath(__file__))


class ProbeJournal:
    """Records node positions before a probe moves them, and puts them back."""

    def __init__(self, name: str) -> None:
        self.path = os.path.join(JOURNAL_DIR, f".probe-journal-{name}.json")
        self.name = name

    def record(self, topology: dict, topology_id: str) -> None:
        """Write down the node positions before anything moves them.

        Called before the mutation, so it is on disk even if the process is
        killed a moment later. Written via a temp file and renamed, so a kill
        mid-write cannot leave a half-written journal that reads as "nothing
        to undo".
        """
        entries = [
            {"node_id": n.get("node_id"), "display_name": n.get("display_name"),
             "x": n.get("x"), "y": n.get("y")}
            for n in topology.get("nodes", [])
        ]
        payload = {"probe": self.name, "topology_id": topology_id,
                   "recorded_at": datetime.now(timezone.utc).isoformat(),
                   "nodes": entries}
        temp = f"{self.path}.tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temp, self.path)

    def repair(self, read_topology, write_topology, topology_id: str) -> list[tuple]:
        """Put back whatever the journal says was moved.

        Returns the list of (name, found, restored) for anything that differed,
        so the caller can print it. Idempotent: a journal whose nodes already
        match is simply cleared.

        Runs on the way in as well as on the way out — that is the whole point.
        """
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            # An unreadable journal is worse than useless: it would silently
            # report "nothing to undo" forever. Say so and stop.
            raise AssertionError(
                f"探针日志无法读取：{self.path}。手工检查后再删除它。")

        if payload.get("topology_id") != topology_id:
            raise AssertionError("探针日志属于另一张图纸；保留日志并停止恢复。")
        was = {n["node_id"]: n for n in payload.get("nodes", []) if n.get("node_id")}
        current = read_topology()
        if current.get("topology_id") != topology_id:
            raise AssertionError("读取的图纸与恢复目标不一致；保留日志并停止恢复。")
        moved = []
        for node in current.get("nodes", []):
            before = was.get(node.get("node_id"))
            if not before:
                continue
            if node.get("x") != before["x"] or node.get("y") != before["y"]:
                moved.append((node.get("display_name"),
                              (node.get("x"), node.get("y")),
                              (before["x"], before["y"])))
                node["x"], node["y"] = before["x"], before["y"]
        if moved:
            write_topology(current)
        os.remove(self.path)
        return moved

    def clear(self) -> None:
        """Drop the journal without acting on it — for a run that never moved anything."""
        if os.path.exists(self.path):
            os.remove(self.path)
