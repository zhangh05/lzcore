"""Atomic publication rejects injected durability failures using temporary files."""

import errno
import io
import os
import stat

import pytest

from storage import atomic_io


@pytest.fixture(params=["text", "bytes", "stream"])
def publish(request):
    if request.param == "text":
        return lambda path: atomic_io.atomic_write_text(path, "new 内容")
    if request.param == "bytes":
        return lambda path: atomic_io.atomic_write_bytes(path, "new 内容".encode())
    return lambda path: atomic_io.atomic_write_stream(path, io.BytesIO("new 内容".encode()))


@pytest.mark.parametrize("error", [errno.ENOSPC, errno.EIO])
def test_file_fsync_failure_preserves_target_and_removes_temp(tmp_path, monkeypatch, publish, error):
    target = tmp_path / "record"
    target.write_bytes(b"original")
    replacements = []

    def fail_sync(fd):
        raise OSError(error, "injected file sync failure")

    monkeypatch.setattr(atomic_io.os, "fsync", fail_sync)
    monkeypatch.setattr(atomic_io.os, "replace", lambda *args: replacements.append(args))
    with pytest.raises(OSError) as failure:
        publish(target)
    assert failure.value.errno == error
    assert replacements == []
    assert target.read_bytes() == b"original"
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.skipif(os.name != "posix", reason="POSIX directory synchronization")
@pytest.mark.parametrize("error", [None, errno.EINVAL, errno.ENOTSUP, errno.ENOSYS, errno.ENOSPC, errno.EIO])
def test_directory_sync_after_publication(tmp_path, monkeypatch, publish, error):
    target = tmp_path / "record"
    target.write_bytes(b"original")
    synced = []
    real_fsync = os.fsync

    def sync(fd):
        directory = stat.S_ISDIR(os.fstat(fd).st_mode)
        synced.append("directory" if directory else "file")
        if directory:
            assert target.read_text() == "new 内容"
            if error is not None:
                raise OSError(error, "injected directory sync failure")
        return real_fsync(fd)

    monkeypatch.setattr(atomic_io.os, "fsync", sync)
    if error in {errno.ENOSPC, errno.EIO}:
        with pytest.raises(OSError) as failure:
            publish(target)
        assert failure.value.errno == error
    else:
        publish(target)
    assert synced == ["file", "directory"]
    assert target.read_text() == "new 内容"
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.skipif(os.name != "posix", reason="POSIX directory synchronization")
@pytest.mark.parametrize("error", [errno.ENOTSUP, errno.EIO, errno.ENOSPC])
def test_directory_open_error_classification(tmp_path, monkeypatch, error):
    target = tmp_path / "record"
    real_open = os.open

    def open_directory(path, flags, *args):
        if path == str(tmp_path):
            raise OSError(error, "injected directory open failure")
        return real_open(path, flags, *args)

    monkeypatch.setattr(atomic_io.os, "open", open_directory)
    if error == errno.ENOTSUP:
        atomic_io.atomic_write_text(target, "published")
    else:
        with pytest.raises(OSError) as failure:
            atomic_io.atomic_write_text(target, "published")
        assert failure.value.errno == error
    assert target.read_text() == "published"
    assert list(tmp_path.iterdir()) == [target]
