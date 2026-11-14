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
            '-File', str(Path(__file__).parents[2] / 'scripts/windows_update.ps1'), '-Plan', str(plan)],
            env={**os.environ, 'PSModulePath': str(Path(os.environ['ProgramFiles']) / 'PowerShell/7/Modules')},
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


@pytest.mark.parametrize('interruption', ['runtime_removed', 'runtime_installed', 'exe_removed', 'exe_installed', 'completed'])
def test_recovery_from_persisted_transaction_without_program_entry(tmp_path, interruption):
    """A fresh helper recovers from disk, with no original updater process."""
    app = tmp_path / 'program'; app.mkdir()
    data = tmp_path / 'data'; data.mkdir()
    updates = data / '.runtime/updates' / ('p1desk-' + interruption); updates.mkdir(parents=True)
    backup = data / '.runtime/program-backups' / ('a' * 32); backup.mkdir(parents=True)
    (backup / '_internal').mkdir()
    (backup / '_internal/payload.txt').write_text('old-runtime')
    (backup / 'build-info.json').write_text(json.dumps({'version': '1.0.0', 'data_schema': 1}))
    shutil.copyfile(Path(os.environ['SystemRoot']) / 'System32/whoami.exe', backup / 'lzcore.exe')
    shutil.copytree(backup, app, dirs_exist_ok=True)
    if interruption in {'runtime_removed', 'exe_removed'}:
        shutil.rmtree(app / '_internal')
    else:
        (app / '_internal/payload.txt').write_text('new-runtime')
    if interruption == 'exe_removed':
        (app / 'lzcore.exe').unlink()
    elif interruption in {'exe_installed', 'completed'}:
        with (app / 'lzcore.exe').open('ab') as handle:
            handle.write(b'p1desk-new-version')
    (data / 'history.json').write_text('keep-user-data')
    plan = updates / 'plan.json'
    plan.write_text(json.dumps({'app': str(app), 'data': str(data), 'package': str(updates / 'absent.zip'),
        'mode': 'portable', 'data_schema': 1, 'parent_pid': 2147483647,
        'version': '1.0.1', 'previous_version': '1.0.0'}), encoding='utf-8')
    (updates / 'transaction.json').write_text(json.dumps({'app': str(app), 'backup': str(backup),
        'phase': 'completed' if interruption == 'completed' else 'prepared', 'version': '1.0.1',
        'names': ['_internal', 'lzcore.exe', 'build-info.json'],
        'originals': ['_internal', 'lzcore.exe', 'build-info.json']}), encoding='utf-8')
    helper = updates / 'apply.ps1'
    shutil.copyfile(Path(__file__).parents[2] / 'scripts/windows_update.ps1', helper)
    try:
        for _ in range(2):  # recovery is repeatable after another helper restart
            result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-File', str(helper), '-Plan', str(plan), '-Recover'], capture_output=True, timeout=30)
            assert result.returncode == 0, result.stderr.decode(errors='replace')
        assert (data / 'history.json').read_text() == 'keep-user-data'
        expected = 'new-runtime' if interruption == 'completed' else 'old-runtime'
        assert (app / '_internal/payload.txt').read_text() == expected
        expected_exe = (backup / 'lzcore.exe').read_bytes()
        if interruption == 'completed':
            expected_exe += b'p1desk-new-version'
        assert (app / 'lzcore.exe').read_bytes() == expected_exe
        phase = json.loads((updates / 'transaction.json').read_text(encoding='utf-8-sig'))['phase']
        assert phase == ('completed' if interruption == 'completed' else 'rolled_back')
    finally:
        # Only the test's unique RunOnce value is removed.
        name = '!LZCoreRecovery-p1desk-' + interruption
        subprocess.run(['powershell.exe', '-NoProfile', '-Command',
            "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name '" + name + "' -ErrorAction SilentlyContinue"], capture_output=True, timeout=15)
