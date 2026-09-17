"""Frontend probes must not PUT a hardcoded production drawing."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "frontend" / "scripts"


def test_probes_do_not_hardcode_a_production_topology():
    offenders = []
    for path in sorted(ROOT.glob("*probe*.py")):
        text = path.read_text(encoding="utf-8")
        if "topo_894e4566e217" in text:
            offenders.append(path.name)
        if "urllib.request.Request" in text and "PUT" in text and "--topology-id" not in text:
            offenders.append(path.name)
    assert offenders == []
