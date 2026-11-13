"""Run the actual snapshot callback on a synthetic DOM; never open a profile."""

import asyncio
import json
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from agent.modules.browser import core


@pytest.mark.parametrize("field_type, autocomplete, sensitive", [
    ("password", "", True),
    ("PASSWORD", "", True),
    ("text", "section-login current-password", True),
    ("text", "new-password", True),
    ("text", "one-time-code", True),
    ("tel", "section-billing cc-number", True),
    ("text", "CC-CSC", True),
    ("text", "username", False),
])
def test_snapshot_sensitive_fields_never_read_value(monkeypatch, field_type, autocomplete, sensitive):
    if not shutil.which("node"):
        pytest.skip("node is required for the snapshot callback test")

    class Locator:
        async def evaluate(self, script, options):
            setup = r"""
const fs = require('fs');
const {script, options, fieldType, autocomplete, sensitive} = JSON.parse(fs.readFileSync(0, 'utf8'));
global.CSS = {escape: x => x};
global.Node = {ELEMENT_NODE: 1};
global.document = {body: {}};
global.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
let reads = 0;
const element = {
  id: 'field', tagName: 'INPUT', nodeType: 1, tabIndex: 0,
  get textContent() { if (sensitive) throw Error('protected text content was read'); return ''; },
  get innerText() { if (sensitive) throw Error('protected inner text was read'); return ''; },
  getAttribute: name => ({type: fieldType, autocomplete, 'aria-label': 'Field'}[name] || ''),
  getBoundingClientRect: () => ({width: 100, height: 20}),
  matches: () => false, closest: () => null, querySelectorAll: () => [],
  get value() { reads++; if (sensitive) throw Error('protected value was read'); return 'synthetic-value'; }
};
const snapshot = eval('(' + script + ')')(element, options);
process.stdout.write(JSON.stringify({snapshot, reads}));
"""
            result = subprocess.run(["node", "-e", setup], input=json.dumps({
                "script": script, "options": options, "fieldType": field_type,
                "autocomplete": autocomplete, "sensitive": sensitive,
            }), text=True, capture_output=True, check=True)
            data = json.loads(result.stdout)
            assert (data["reads"] == 0) is sensitive
            return data["snapshot"]

    class Page:
        url = "https://example.invalid/form"

        async def title(self):
            return "Synthetic form"

        def locator(self, selector):
            return Locator()

    async def get_page():
        return Page()

    monkeypatch.setattr(core, "_get_page", get_page)
    monkeypatch.setattr(core, "_run", asyncio.run)
    monkeypatch.setattr(core, "_state", lambda: SimpleNamespace(refs={}))
    result = core.browser_snapshot()
    row = result["elements"][0]
    assert row["role"] == "textbox"
    assert ("value" not in row) is sensitive
    if not sensitive:
        assert row["value"] == "synthetic-value"
