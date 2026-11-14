"""Minimal MCP client boundary for local stdio servers."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, BinaryIO


_MAX_MESSAGE_BYTES = 4 * 1024 * 1024
_MAX_SKIPPED_MESSAGES = 256


def _read_stdout(stream: BinaryIO, chunks: queue.Queue, stopped: threading.Event) -> None:
    """Pipe reads run off-thread on both POSIX and Windows (no pipe select).

    Reads never wait for a newline. The request thread bounds both buffering
    and elapsed time; stopping the child releases an outstanding pipe read.
    """
    while not stopped.is_set():
        try:
            chunk = os.read(stream.fileno(), 65536)
        except (OSError, ValueError):
            chunk = b""
        while not stopped.is_set():
            try:
                chunks.put(chunk, timeout=0.05)
                break
            except queue.Full:
                continue
        if not chunk:
            return


_SAFE_ENV = frozenset({
    "PATH", "HOME", "USER", "LANG", "TMPDIR", "TEMP", "TMP", "TZ",
    "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
    "COMSPEC", "PATHEXT", "SHELL", "LOGNAME",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
})


def _subprocess_env(configured: dict[str, str] | None) -> dict[str, str]:
    env = {}
    for name, value in os.environ.items():
        upper = name.upper()
        if upper.startswith("LZCORE_") or any(
            part in upper for part in ("KEY", "TOKEN", "SECRET", "PASSWORD")
        ):
            continue
        if upper in _SAFE_ENV or upper.startswith("LC_"):
            env[name] = value
    env.update(configured or {})
    env["PYTHONIOENCODING"] = "utf-8"
    return env


class McpProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class McpServerConfig:
    server_id: str
    command: tuple[str, ...]
    env: dict[str, str] | None = None
    cwd: str | None = None
    timeout_seconds: float = 30.0


class StdioMcpClient:
    """Synchronous MCP client for discovery and tool calls.

    Returned tools must still be mapped through the platform's manifest, risk,
    authorization and audit pipeline before they become model-visible.
    """

    def __init__(self, config: McpServerConfig):
        self.config = config
        self._process: subprocess.Popen[bytes] | None = None
        self._next_id = 0
        self._buffer = b""
        self._chunks: queue.Queue = queue.Queue(maxsize=16)
        self._stopped = threading.Event()
        self._reader: threading.Thread | None = None

    def __enter__(self) -> "StdioMcpClient":
        if self._process is not None:
            raise McpProtocolError("MCP client is already connected")
        self._buffer = b""
        self._chunks = queue.Queue(maxsize=16)
        self._stopped = threading.Event()
        self._reader = None
        self._process = subprocess.Popen(
            list(self.config.command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, bufsize=0, cwd=self.config.cwd,
            env=_subprocess_env(self.config.env),
        )
        try:
            self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lzcore", "version": "1"}})
            self.notify("notifications/initialized", {})
        except BaseException:
            self._terminate()
            raise
        return self

    def __exit__(self, *_: Any) -> None:
        self._terminate()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._process or not self._process.stdin or not self._process.stdout:
            raise McpProtocolError("MCP client is not connected")
        self._next_id += 1
        request_id = self._next_id
        deadline = time.monotonic() + self.config.timeout_seconds
        if self._reader is None:
            self._reader = threading.Thread(target=_read_stdout,
                args=(self._process.stdout, self._chunks, self._stopped), daemon=True)
            self._reader.start()
        try:
            self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
            for _ in range(_MAX_SKIPPED_MESSAGES + 1):
                line = self._read_line(deadline, method)
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError) as exc:
                    raise McpProtocolError("Invalid MCP response JSON") from exc
                if not isinstance(message, dict):
                    raise McpProtocolError("Invalid MCP response envelope")
                if message.get("id") != request_id:
                    continue
                if message.get("error"):
                    raise McpProtocolError(str(message["error"]))
                result = message.get("result", {})
                if not isinstance(result, dict):
                    raise McpProtocolError("Invalid MCP response result")
                return result
            raise McpProtocolError("MCP response notification budget exceeded")
        except BaseException:
            self._terminate()
            raise

    def _read_line(self, deadline: float, method: str) -> bytes:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpProtocolError(f"MCP request timed out after {self.config.timeout_seconds:g}s: {method}")
            end = self._buffer.find(b"\n")
            if end > _MAX_MESSAGE_BYTES or (end < 0 and len(self._buffer) > _MAX_MESSAGE_BYTES):
                raise McpProtocolError("MCP response message too large")
            if end >= 0:
                line, self._buffer = self._buffer[:end], self._buffer[end + 1:]
                return line
            try:
                chunk = self._chunks.get(timeout=remaining)
            except queue.Empty:
                raise McpProtocolError(f"MCP request timed out after {self.config.timeout_seconds:g}s: {method}") from None
            if not chunk:
                raise McpProtocolError("MCP server closed stdout")
            self._buffer += chunk

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def list_tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list").get("tools") or [])

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def _send(self, message: dict[str, Any]) -> None:
        assert self._process and self._process.stdin
        data = memoryview((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        while data:
            written = self._process.stdin.write(data)
            if not written:
                raise McpProtocolError("MCP server closed stdin")
            data = data[written:]
        self._process.stdin.flush()

    def _terminate(self) -> None:
        process = self._process
        self._process = None
        self._stopped.set()
        if not process:
            return
        if process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        if self._reader is not None:
            self._reader.join(timeout=0.2)
        self._buffer = b""
