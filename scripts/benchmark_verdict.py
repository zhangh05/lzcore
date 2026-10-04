"""One authoritative verdict, separate from Agent turn/transport success."""

from __future__ import annotations


def benchmark_verdict(
    *, agent_turn_ok, acceptance_exit_code, team_required, team_ok, cleanup_confirmed
):
    accepted = type(acceptance_exit_code) is int and acceptance_exit_code == 0
    passed = (
        agent_turn_ok is True
        and accepted
        and cleanup_confirmed is True
        and (team_required is False or team_ok is True)
    )
    return {
        "schema": "coding.benchmark_verdict.v1",
        "status": "PASS" if passed else "FAIL",
        "agent_turn_ok": agent_turn_ok is True,
        "named_acceptance_passed": accepted,
        "team_required": team_required is True,
        "team_accepted": team_ok is True if team_required else None,
        "cleanup_confirmed": cleanup_confirmed is True,
        "full_benchmark_acceptance": "NOT VERIFIED",
    }
