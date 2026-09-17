"""Shared CLI contract for topology probes: never default to a production drawing."""

from __future__ import annotations

import argparse


def require_topology_target(argv: list[str] | None = None) -> tuple[str, str]:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topology-id", required=True)
    parser.add_argument("--workspace-id", default="default")
    args, _ = parser.parse_known_args(argv)
    return args.topology_id, args.workspace_id
