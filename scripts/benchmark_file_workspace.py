"""Offline FileRecord scale benchmark using disposable real payloads only."""
import argparse, sys, platform
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path)
args = parser.parse_args()
import json, tempfile, time, hashlib
from pathlib import Path
import os
with tempfile.TemporaryDirectory(prefix='lzcore-file-scale-') as directory:
    os.environ['LZCORE_WORKSPACE_ROOT'] = directory
    from storage.schemas import FileRecord, FileReference
    from storage.paths import workspace_root
    from storage.file_workspace import files_page
    from storage.file_search import search_content
    from storage.data_management import managed_data_files
    ws = 'file_scale'; root = workspace_root(ws); (root / 'files/data').mkdir(parents=True); (root / 'index').mkdir()
    records, refs = [], []
    for n in range(10000):
        fid = f'file_scale_{n:05}'; raw = f'row one\n正文 sample {n%10} 100%_literal'.encode(); path = f'files/data/{fid}.txt'
        (root / path).write_bytes(raw)
        records.append(FileRecord(file_id=fid, workspace_id=ws, logical_type='user_upload', file_kind='text', path=path, original_name=f'中文 {n:05}.txt', mime_type='text/plain', size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(), created_at=f'2026-10-07T{n:05}', source='synthetic').as_dict())
        refs.extend(FileReference(ref_id=f'ref_scale_{n:05}_{r}', workspace_id=ws, file_id=fid, owner_type='session', owner_id=f'session_{r}', relation='attachment').as_dict() for r in range(3))
    for name, rows in [('files', records), ('references', refs)]:
        (root / f'index/{name}.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))
    def measure(call):
        start=time.perf_counter(); value=call(); return value, (time.perf_counter()-start)*1000
    list_times = [measure(lambda: files_page(ws, limit=50))[1] for _ in range(20)]
    result, cold = measure(lambda: search_content(ws, 'sample 3', limit=50))
    search_times=[]
    for _ in range(20):
        _, elapsed=measure(lambda: (managed_data_files(ws), search_content(ws, 'sample 3', limit=50)))
        search_times.append(elapsed)
    seen=[]; cursor=''
    while True:
        page=files_page(ws, limit=200, cursor=cursor); seen.extend(r['file_id'] for r in page['files']); cursor=page['next_cursor']
        if not cursor: break
    assert len(seen)==len(set(seen))==10000
    report={'files':10000,'references':30000,'list_samples':20,'search_samples':20,'list_p95_ms':sorted(list_times)[18],'search_with_read_model_p95_ms':sorted(search_times)[18],'cold_text_index_and_search_ms':cold,'search_matches':result['total'],'pagination_unique_count':len(set(seen)),'fixture':'real temporary UTF-8 payloads and JSONL records; no LLM','platform':platform.system()+' '+platform.machine()}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
