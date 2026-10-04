#!/usr/bin/env python3
"""Independent, opt-in acceptance checks for generated benchmark applications.

Never edits the application and never treats its own test results as complete
functional acceptance. Uncovered requirements remain NOT VERIFIED.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=("counter", "noc", "rts"), required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    from urllib.parse import urlsplit
    origin = urlsplit(args.origin)
    if origin.hostname != "127.0.0.1" or origin.scheme != "http" or origin.username:
        parser.error("only an explicit loopback HTTP benchmark origin is accepted")
    project = args.project.resolve()
    checks = []
    def check(name, action):
        start = time.monotonic()
        try:
            evidence = action()
            checks.append({"name": name, "status": "PASS", "evidence": evidence,
                           "duration_seconds": round(time.monotonic() - start, 3)})
        except Exception as exc:
            checks.append({"name": name, "status": "FAIL", "error": str(exc)[:1200]})
    def command(arguments):
        result = subprocess.run(arguments, cwd=project, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise AssertionError((result.stdout + result.stderr)[-1200:])
        return (result.stdout + result.stderr)[-1600:]
    check("generated_test_suite", lambda: command(["npm", "test"]))
    check("production_build", lambda: command(["npm", "run", "build"]))

    def api(path, data=None):
        req = urllib.request.Request(args.origin.rstrip("/") + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    def array(path, key):
        data = api(path)
        rows = data if isinstance(data, list) else data.get(key)
        assert isinstance(rows, list), f"{path} must return {key} array"
        return rows
    if args.case == "noc":
        check("api_boot", lambda: api("/api/health"))
        def inventory():
            devices = array("/api/devices", "devices")
            interfaces = array("/api/interfaces", "interfaces")
            topology = api("/api/topology")
            assert len(devices) >= 50 and len(interfaces) >= 300, f"inventory below baseline: {len(devices)} devices, {len(interfaces)} interfaces"
            assert len(topology["links"]) >= 80, f"only {len(topology['links'])} links"
            assert len({item["id"] for item in devices}) == len(devices)
            return {"devices": len(devices), "interfaces": len(interfaces), "links": len(topology["links"])}
        check("baseline_inventory", inventory)
        def progress():
            before = api("/api/test/state")
            api("/api/test/step", {"seconds": 10})
            after = api("/api/test/state")
            assert after["tick"] > before["tick"], "simulation tick did not advance"
            return {"tick_before": before["tick"], "tick_after": after["tick"]}
        check("simulation_progress", progress)
        def stress():
            api("/api/test/stress", {})
            data = inventory()
            assert data["devices"] >= 100 and data["interfaces"] >= 1000, f"stress inventory below target: {data}"
            state = api("/api/test/state")
            # Retention counts differ from the page returned by a bounded API.
            assert array("/api/syslog", "syslog"), "syslog endpoint returned no retained records"
            data.update(syslogs=state["counts"]["syslog"], active_alerts=state["activeAlerts"])
            assert data["syslogs"] >= 10000, f"only {data['syslogs']} retained syslogs; need 10000"
            assert data["active_alerts"] >= 500, f"only {data['active_alerts']} active alerts; need 500"
            return data
        check("stress_inventory", stress)
    if args.case == "rts":
        def engine_check(scenario):
            entries = [project / name for name in ("src/engine.ts", "src/engine.js", "src/engine/index.ts")]
            entry = next((path for path in entries if path.is_file()), None)
            assert entry, "generated engine entry is missing"
            evaluator = Path(__file__).resolve().parents[1] / "harness/fixtures/coding_bench/rts_acceptance.cjs"
            result = subprocess.run(["node", str(evaluator), str(project), str(entry), scenario],
                                    cwd=project, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, (result.stdout + result.stderr)[-1200:]
            return json.loads(result.stdout.strip().splitlines()[-1])
        for scenario in ("seed_and_tick", "save_load", "fog_save", "battle_100v100"):
            check(f"independent_engine_{scenario}", lambda scenario=scenario: engine_check(scenario))
    from playwright.sync_api import sync_playwright
    def browser_checks():
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            response = page.goto(args.origin, wait_until="domcontentloaded", timeout=30000)
            assert response and response.ok
            page.get_by_role("button").first.wait_for(state="visible", timeout=30000)
            if args.case == "counter":
                value = page.get_by_test_id("value")
                reset = page.get_by_role("button", name="Reset", exact=True)
                increment = page.get_by_role("button", name="Increment", exact=True)
                decrement = page.get_by_role("button", name="Decrement", exact=True)
                reset.click(); assert value.inner_text() == "0"
                for _ in range(20): increment.click()
                assert value.inner_text() == "20"
                page.reload(wait_until="networkidle")
                assert value.inner_text() == "20"
                for _ in range(20): decrement.click()
                assert value.inner_text() == "0"
                if decrement.is_enabled(): decrement.click()
                assert value.inner_text() == "0"
                increment.click(); reset.click(); assert value.inner_text() == "0"
                page.reload(wait_until="networkidle"); assert value.inner_text() == "0"
            else:
                assert len(page.locator("body").inner_text()) > 40, "empty application"
                assert page.get_by_role("button").count() >= 1, "no interactive controls"
                if args.case == "rts":
                    assert page.locator("canvas").count() >= 1, "no game world canvas"
            assert not errors, errors
            args.report.parent.mkdir(parents=True, exist_ok=True)
            screenshot = args.report.with_suffix(".png")
            page.screenshot(path=str(screenshot), full_page=True)
            browser.close()
            return {"viewport": "1280x720", "page_errors": errors, "screenshot": str(screenshot)}
    check("independent_browser_interactions" if args.case == "counter" else "browser_boot_only", browser_checks)
    payload = {"case": args.case, "checks": checks,
               "full_benchmark_acceptance": "NOT VERIFIED",
               "note": "Only the named checks were independently executed; generated tests are not independent functional acceptance."}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] == "FAIL" for item in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
