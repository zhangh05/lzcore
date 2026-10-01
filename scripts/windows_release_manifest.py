"""Publish only checksums of the two verified desktop distribution artifacts."""
import hashlib
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent import __version__
from desktop_app.environment import DATA_SCHEMA
folder=ROOT/'release'
signed=json.loads((ROOT/'dist/lzcore/build-info.json').read_text())['signed']
assets={}
for mode,suffix in [('portable','portable.zip'),('installed','setup.exe')]:
    path=folder/f'lzcore-v{__version__}-windows-{suffix}'
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): digest.update(chunk)
    assets[mode]={'name':path.name,'size':path.stat().st_size,'sha256':digest.hexdigest(),'signed':signed}
(folder/'windows-update.json').write_text(json.dumps({'version':__version__,'data_schema':DATA_SCHEMA,'assets':assets},indent=2)+'\n',encoding='utf-8')
(folder/'SHA256SUMS.txt').write_text(''.join(f"{a['sha256']}  {a['name']}\n" for a in assets.values()),encoding='utf-8')
