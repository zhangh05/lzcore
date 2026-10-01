"""Exercise the real PowerShell updater's program transaction on Windows."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

import pytest

pytestmark = pytest.mark.skipif(sys.platform != 'win32', reason='native Windows updater')


@pytest.mark.parametrize('failure', [None, 'unsafe_path', 'locked_program'])
def test_portable_update_retains_data_and_rolls_back(tmp_path, failure):
    app = tmp_path / '中文 程序'; app.mkdir()
    data = tmp_path / '中文 用户数据'; data.mkdir()
    (data / 'history.json').write_text('用户记录', encoding='utf-8')
    (app / '_internal').mkdir()
    (app / '_internal/payload.txt').write_text('old')
    (app / 'build-info.json').write_text(json.dumps({'version': '3.2.8', 'data_schema': 1}))
    (app / 'portable.json').write_text('{}')
    # A harmless Windows command exits immediately when restarted with the
    # application's arguments. No test launches an unrelated user's program.
    shutil.copyfile(Path(os.environ['SystemRoot']) / 'System32/whoami.exe', app / 'lzcore.exe')
    original_exe = (app / 'lzcore.exe').read_bytes()
    updates = data / '.runtime/updates/test'; updates.mkdir(parents=True)
    package = updates / 'package.zip'
    with zipfile.ZipFile(package, 'w') as archive:
        archive.writestr('lzcore/_internal/payload.txt', 'new')
        archive.writestr('lzcore/build-info.json', json.dumps({'version': '3.3.0', 'data_schema': 1}))
        archive.writestr('lzcore/portable.json', '{}')
        archive.writestr('lzcore/lzcore.exe', original_exe)
        if failure == 'unsafe_path': archive.writestr('lzcore/../outside.txt', 'invalid')
    plan = updates / 'plan.json'
    plan.write_text(json.dumps({'app': str(app), 'data': str(data), 'package': str(package),
        'mode': 'portable', 'data_schema': 1, 'parent_pid': 2147483647,
        'sha256': hashlib.sha256(package.read_bytes()).hexdigest(), 'signed': False,
        'version': '3.3.0', 'previous_version': '3.2.8'}), encoding='utf-8')
    handle = None
    if failure == 'locked_program':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.CreateFileW(str(app / 'lzcore.exe'), 0x80000000, 0, None, 3, 0, None)
        assert handle not in (None, ctypes.c_void_p(-1).value)
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', str(Path(__file__).parents[1] / 'scripts/windows_update.ps1'), '-Plan', str(plan)],
            capture_output=True, timeout=30)
    finally:
        if handle: kernel.CloseHandle(handle)
    status = json.loads((updates / 'result.json').read_text(encoding='utf-8-sig'))
    assert result.returncode == (1 if failure else 0), (status, result.stderr.decode(errors='replace'))
    assert (data / 'history.json').read_text(encoding='utf-8') == '用户记录'
    assert not (tmp_path / 'outside.txt').exists()
    assert (app / '_internal/payload.txt').read_text() == ('old' if failure else 'new')
    assert json.loads((app / 'build-info.json').read_text())['version'] == ('3.2.8' if failure else '3.3.0')
    assert (app / 'lzcore.exe').read_bytes() == original_exe
    assert status['ok'] is (failure is None)
    if not failure:
        assert json.loads((data / '.runtime/desktop.json').read_text(encoding='utf-8-sig'))['previous_version'] == '3.2.8'
        assert next((data / '.runtime/program-backups').glob('*/_internal/payload.txt')).read_text() == 'old'
