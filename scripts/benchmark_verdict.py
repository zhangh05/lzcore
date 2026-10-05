"""One authoritative verdict, separate from Agent turn/transport success."""

from __future__ import annotations


def benchmark_verdict(
    *, case, acceptance_report, agent_turn_ok, acceptance_exit_code,
    team_required, team_ok, cleanup_confirmed, deadline_reached
):
    from scripts.benchmark_coverage import acceptance_summary

    scope = acceptance_summary(case, acceptance_report)
    # Exit 2 is the evaluator's explicit incomplete-coverage result. Even this
    # result requires every expected named check; the exit code alone proves none.
    accepted = (
        type(acceptance_exit_code) is int
        and (acceptance_exit_code == 0 or (acceptance_exit_code == 2 and scope["status"] == "INCOMPLETE"))
        and scope["named_acceptance_passed"]
    )
    gates_passed = (
        agent_turn_ok is True
        and deadline_reached is False
        and accepted
        and cleanup_confirmed is True
        and (team_required is False or (team_required is True and team_ok is True))
    )
    return {
        "schema": "coding.benchmark_verdict.v1",
        "case": case,
        "status": scope["status"] if gates_passed else "FAIL",
        "agent_turn_ok": agent_turn_ok is True,
        "deadline_reached": deadline_reached is True,
        "named_acceptance_passed": accepted,
        "team_required": team_required is True,
        "team_accepted": team_ok is True if team_required else None,
        "cleanup_confirmed": cleanup_confirmed is True,
        "full_benchmark_acceptance": scope["full_benchmark_acceptance"],
        "acceptance_scope": scope,
    }
