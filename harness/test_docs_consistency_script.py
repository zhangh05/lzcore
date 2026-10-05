import subprocess
import sys
import re
from pathlib import Path


def test_docs_runtime_consistency_script_passes_without_traceback():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, str(root / "scripts" / "verify_docs_runtime_consistency.py")],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert "Traceback" not in result.stderr
    assert result.returncode == 0, result.stdout + result.stderr


def test_api_docs_only_list_registered_backend_routes():
    from backend.main import app

    root = Path(__file__).resolve().parents[1]
    docs = (root / "docs" / "API.md").read_text(encoding="utf-8")
    actual = set()
    for rule in app.url_map.iter_rules():
        if not str(rule).startswith(("/api/", "/ws/")) and str(rule) != "/metrics":
            continue
        shape = re.sub(r"<[^>]+>", "<var>", str(rule))
        actual.update((method, shape) for method in rule.methods if method not in {"HEAD", "OPTIONS"})
    documented = []
    for line in docs.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        methods, paths = cells[:2]
        methods = methods.strip("`")
        if not re.fullmatch(r"(?:GET|POST|PUT|PATCH|DELETE|WS)(?:/(?:GET|POST|PUT|PATCH|DELETE))*", methods):
            continue
        routes = re.findall(r"`(/[^`]+)`", paths)
        assert routes and all(path.startswith(("/api/", "/ws/")) or path == "/metrics" for path in routes), \
            f"Document complete API paths so every method can be checked: {line}"
        documented.extend(
            ("GET" if method == "WS" else method, re.sub(r"<[^>]+>", "<var>", path))
            for method in methods.split("/")
            for path in routes
        )

    assert documented, "API route extraction must not pass on an empty selection"
    assert not (set(documented) - actual), f"Invalid documented route methods: {set(documented) - actual}"
    assert not (actual - set(documented)), f"Undocumented API route methods: {actual - set(documented)}"


def test_frontend_docs_match_navigation_routes():
    root = Path(__file__).resolve().parents[1]
    docs = (root / "docs" / "FRONTEND.md").read_text(encoding="utf-8")
    nav_text = (root / "frontend" / "src" / "config" / "nav.ts").read_text(encoding="utf-8")
    nav_routes = re.findall(r'to:\s*"([^"]+)"', nav_text)
    assert nav_routes, "Navigation extraction must not pass on an empty selection"
    for route in nav_routes:
        assert route in docs, f"Route '{route}' not mentioned in FRONTEND.md"
