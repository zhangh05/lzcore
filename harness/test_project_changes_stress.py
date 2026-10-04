"""Repeat real publication races against durable journals, not mocked results."""
from concurrent.futures import ThreadPoolExecutor
import random
import uuid

import pytest

from storage.project_changes import changeset, publish_changes, source_manifest, project_path


@pytest.mark.parametrize('seed', [17, 59, 103])
def test_many_competing_changes_preserve_one_complete_winner(monkeypatch, tmp_path, seed):
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT', str(tmp_path))
    rng = random.Random(seed)
    parent = project_path('parent', 'files/data/app')
    parent.mkdir(parents=True)
    for name in ('one.txt', 'two.txt'):
        (parent / name).write_text('baseline')
    with ThreadPoolExecutor(max_workers=4) as workers:
        for iteration in range(16):
            baseline = source_manifest(parent)
            candidates = []
            for contender in range(4):
                branch = tmp_path / 'branches' / f'{iteration}-{contender}'
                branch.mkdir(parents=True)
                payload = f'{seed}/{iteration}/{rng.randrange(1000000)}'
                for name in ('one.txt', 'two.txt'):
                    (branch / name).write_text(payload)
                change = changeset(baseline, source_manifest(branch), ['.'])
                candidates.append((branch, change, payload))
            futures = [workers.submit(publish_changes, 'parent', 'files/data/app',
                'sub-' + uuid.uuid4().hex[:8], branch, change) for branch, change, _ in candidates]
            results = [future.result(timeout=30) for future in futures]
            winners = [i for i, result in enumerate(results) if result['ok']]
            assert len(winners) == 1, results
            assert all(result['phase'] in ('integrated', 'conflict') for result in results)
            expected = candidates[winners[0]][2]
            assert (parent / 'one.txt').read_text() == (parent / 'two.txt').read_text() == expected
