"""Both file datasets are bounded using the opened file's actual size."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.tools import canonical_registry as registry
from core.tools.schemas import ToolInvocation


@pytest.mark.parametrize('prefix', ['', 'right_'])
@pytest.mark.parametrize('growth', [False, True])
def test_dataset_file_rejects_oversize_and_growth_before_decode(monkeypatch, tmp_path, prefix, growth):
    from core.tools.general_tools import data_engine, shared
    path = tmp_path / 'dataset.csv'
    path.write_bytes(b'\xff' * 65)  # Must reject size before UTF-8 decoding.
    monkeypatch.setattr(data_engine, 'MAX_INPUT_BYTES', 64)
    monkeypatch.setattr(shared, '_caller_workspace', lambda _: 'test-ws')
    monkeypatch.setattr(shared, '_workspace_path', lambda *a: path)
    monkeypatch.setattr(registry, '_dispatch_data', lambda _: pytest.fail('oversize data dispatched'))
    if growth:
        monkeypatch.setattr('os.fstat', lambda _: SimpleNamespace(st_mode=0o100644, st_size=1))
    monkeypatch.setattr(Path, 'read_bytes', lambda _: pytest.fail('unbounded read'))
    result = registry._handle_data(ToolInvocation(tool_id='data.manage', arguments={prefix + 'source_filepath': 'input.csv'}))
    assert not result['ok'] and 'byte limit' in str(result)


def test_two_valid_files_preserve_content_and_source_evidence(monkeypatch, tmp_path):
    from hashlib import sha256
    from core.tools.general_tools import shared
    for name in ('left', 'right'):
        (tmp_path / name).write_bytes(b'\xef\xbb\xbfx\n1\n')
    monkeypatch.setattr(shared, '_caller_workspace', lambda _: 'test-ws')
    monkeypatch.setattr(shared, '_workspace_path', lambda ws, path: tmp_path / path)
    captured = []
    monkeypatch.setattr(registry, '_dispatch_data', lambda inv: captured.append(inv.arguments) or {'ok': True})
    result = registry._handle_data(ToolInvocation(arguments={'source_filepath': 'left', 'right_source_filepath': 'right'}))
    assert result['ok'] and captured[0]['text'] == captured[0]['right_text'] == 'x\n1\n'
    assert [item['side'] for item in result['sources']] == ['left', 'right']
    assert all(item['sha256'] == sha256(b'\xef\xbb\xbfx\n1\n').hexdigest() for item in result['sources'])
