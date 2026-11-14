"""Offline stdio servers exercise partial bytes, notification floods and cleanup."""

import json
import sys
import time

import pytest

from core.tools import mcp_client
from core.tools.mcp_client import McpProtocolError, McpServerConfig, StdioMcpClient


def _client(script, timeout=0.5):
    return StdioMcpClient(McpServerConfig("synthetic", (sys.executable, "-u", "-c", script),
                                         timeout_seconds=timeout))


@pytest.mark.parametrize("reply", ["partial", "notifications", "oversized"])
def test_initialize_failure_closes_pipes_and_reaps_child(monkeypatch, reply):
    if reply == "partial":
        body = 'sys.stdout.write(\'{"jsonrpc":\'); sys.stdout.flush(); time.sleep(30)'
        expected = "timed out"
    elif reply == "notifications":
        body = ('while True:\n'
                ' print(json.dumps({"jsonrpc":"2.0","method":"notifications/ping"}), flush=True)')
        expected = "notification budget"
    else:
        monkeypatch.setattr(mcp_client, "_MAX_MESSAGE_BYTES", 128)
        body = 'sys.stdout.write("x" * 129); sys.stdout.flush(); time.sleep(30)'
        expected = "too large"
    client = _client("import sys,time,json\nsys.stdin.readline()\n" + body)
    spawned = []
    popen = mcp_client.subprocess.Popen
    def capture(*args, **kwargs):
        process = popen(*args, **kwargs)
        spawned.append(process)
        return process
    monkeypatch.setattr(mcp_client.subprocess, "Popen", capture)
    start = time.monotonic()
    with pytest.raises(McpProtocolError, match=expected):
        client.__enter__()
    assert time.monotonic() - start < 4
    assert client._process is None
    assert spawned[0].poll() is not None
    assert spawned[0].stdin.closed and spawned[0].stdout.closed
    assert not client._reader.is_alive()


def test_deadline_is_not_reset_by_partial_bytes_or_unrelated_messages(monkeypatch):
    client = _client("unused", timeout=1.0)
    ticks = iter([0.2, 0.4, 0.8, 1.1])
    monkeypatch.setattr(mcp_client.time, "monotonic", lambda: next(ticks))
    waits = []
    chunks = iter([b'{"method":"notice"}\n{"id":', b'"wrong"}\n', b'{"id":'])
    class Chunks:
        def get(self, *, timeout):
            waits.append(timeout)
            return next(chunks)
    client._chunks = Chunks()
    assert json.loads(client._read_line(1.0, "test"))["method"] == "notice"
    with pytest.raises(McpProtocolError, match="timed out"):
        client._read_line(1.0, "test")
    assert waits == pytest.approx([0.8, 0.2])


def test_partial_tool_reply_times_out_after_successful_initialize():
    script = '''import sys,json,time
for line in sys.stdin:
 message=json.loads(line)
 if message.get("method")=="initialize":
  print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":{}}),flush=True)
 elif message.get("method")=="tools/call":
  sys.stdout.write('{"id":'); sys.stdout.flush(); time.sleep(30)
'''
    with _client(script) as client:
        process = client._process
        with pytest.raises(McpProtocolError, match="timed out"):
            client.call_tool("synthetic")
        assert client._process is None and process.poll() is not None
        assert process.stdin.closed and process.stdout.closed


def test_slow_notifications_do_not_extend_request_deadline():
    script = '''import sys,json,time
sys.stdin.readline()
while True:
 print(json.dumps({"method":"notice"}), flush=True)
 time.sleep(0.05)
'''
    client = _client(script)
    start = time.monotonic()
    with pytest.raises(McpProtocolError, match="timed out"):
        client.__enter__()
    assert time.monotonic() - start < 4
    assert client._process is None and not client._reader.is_alive()


def test_chunked_unicode_and_buffered_messages_keep_normal_protocol_working():
    script = '''import sys,json,time
for line in sys.stdin:
 message=json.loads(line)
 if "id" not in message: continue
 result={"tools":[{"name":"inspect"}]} if message["method"]=="tools/list" else {"text":"中文"}
 packet=(json.dumps({"id":message["id"],"result":result},ensure_ascii=False)+"\\n").encode()
 notice=b'{"method":"notice"}\\n'
 sys.stdout.buffer.write(notice+packet[:1]); sys.stdout.buffer.flush()
 for byte in packet[1:]:
  sys.stdout.buffer.write(bytes([byte])); sys.stdout.buffer.flush()
'''
    client = _client(script, timeout=2)
    with client:
        process = client._process
        assert client.list_tools() == [{"name": "inspect"}]
        assert client.call_tool("inspect", {"query": "中文"}) == {"text": "中文"}
    assert process.poll() is not None
    assert not client._reader.is_alive()


@pytest.mark.parametrize("response", [b'[]\n', b'not-json\n', b'{"id":1,"result":[]}\n', b''])
def test_invalid_response_and_eof_fail_closed(response):
    client = _client("import sys\nsys.stdin.readline()\nsys.stdout.buffer.write(" + repr(response) + ")")
    with pytest.raises(McpProtocolError):
        client.__enter__()
    assert client._process is None
