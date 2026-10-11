"""Negative controls for incomplete, forged, or missing independent evidence."""

from copy import deepcopy

import pytest

from scripts.benchmark_coverage import acceptance_summary, expected_checks
from scripts.benchmark_verdict import benchmark_verdict


def report(case, rounds=3):
    return {"case": case, "rounds": rounds, "checks": [
        {"name": name, "status": "PASS"} for name in sorted(expected_checks(case, rounds))
    ]}


def verdict(case, evidence, exit_code=0, **changes):
    arguments = dict(case=case, acceptance_report=evidence, agent_turn_ok=True,
                     acceptance_exit_code=exit_code, team_required=True, team_ok=True,
                     cleanup_confirmed=True, deadline_reached=False)
    arguments.update(changes)
    return benchmark_verdict(**arguments)


@pytest.mark.parametrize("case", ["noc", "rts"])
@pytest.mark.parametrize("exit_code", [0, 2])
def test_successful_named_subset_cannot_complete_large_benchmark(case, exit_code):
    evidence = report(case)
    evidence["full_benchmark_acceptance"] = "PASS"
    evidence["acceptance_scope"] = {"status": "PASS", "unverified_requirements": []}
    result = verdict(case, evidence, exit_code)
    assert result["status"] == "INCOMPLETE"
    assert result["named_acceptance_passed"] is True
    assert result["full_benchmark_acceptance"] == "NOT VERIFIED"
    assert result["acceptance_scope"]["unverified_requirements"]


@pytest.mark.parametrize("case", ["counter", "noc", "rts"])
def test_zero_exit_without_complete_independent_records_is_failure(case):
    assert verdict(case, None)["status"] == "FAIL"
    evidence = report(case)
    for index in range(len(evidence["checks"])):
        incomplete = deepcopy(evidence)
        del incomplete["checks"][index]
        assert verdict(case, incomplete)["status"] == "FAIL"


@pytest.mark.parametrize("mutation", [
    lambda r: r.update(case="rts"),
    lambda r: r.update(rounds=True),
    lambda r: r.update(rounds=0),
    lambda r: r.update(rounds=11),
    lambda r: r.update(checks=[]),
    lambda r: r["checks"].append(dict(r["checks"][0])),
    lambda r: r["checks"].append({"name": "invented_check", "status": "PASS"}),
    lambda r: r["checks"].append(None),
    lambda r: r["checks"][0].update(status="NOT VERIFIED"),
    lambda r: r["checks"][0].update(status=True),
    lambda r: r["checks"][0].update(status=[]),
    lambda r: r["checks"][0].update(status={}),
    lambda r: r["checks"][0].update(status="FAIL"),
])
def test_report_identity_duplicates_unknown_checks_and_invalid_status_rejected(mutation):
    evidence = report("noc")
    mutation(evidence)
    assert verdict("noc", evidence)["status"] == "FAIL"


@pytest.mark.parametrize("case", ["noc", "rts"])
def test_one_round_is_not_repeated_stability_validation(case):
    result = acceptance_summary(case, report(case, rounds=1))
    assert result["named_acceptance_passed"]
    assert "at_least_three_independent_acceptance_rounds" in result["unverified_requirements"]


def test_counter_still_requires_browser_and_all_execution_gates():
    assert verdict("counter", report("counter"))["status"] == "PASS"
    for changes in ({"agent_turn_ok": False}, {"team_ok": False},
                    {"cleanup_confirmed": False}, {"team_required": None},
                    {"deadline_reached": True}, {"deadline_reached": None}):
        assert verdict("counter", report("counter"), **changes)["status"] == "FAIL"


@pytest.mark.parametrize("exit_code", [True, False, None, 1, 2, -9])
def test_report_does_not_override_process_failure(exit_code):
    assert verdict("counter", report("counter"), exit_code)["status"] == "FAIL"
