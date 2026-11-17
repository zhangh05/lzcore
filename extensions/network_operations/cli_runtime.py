"""Interactive, vendor-aware CLI state machine for network devices."""

from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Callable
from dataclasses import dataclass

from extensions.network_operations.device_drivers import DeviceDriver, resolve_driver

ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
CONTROL_EXCEPT_LAYOUT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
MAX_PAGER_ADVANCES = 500
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
SCAN_WINDOW_BYTES = 64 * 1024
# A device can emit a console/syslog notice immediately after returning its
# prompt.  Waiting for a brief quiet period prevents that late notice from
# leaking into the next command's buffer while keeping normal CLI latency low.
INTERACTION_PROMPT = re.compile(
    r"(?:\[\s*(?:y/n|yes/no|confirm)\s*\]|\(\s*(?:y/n|yes/no)\s*\)|"
    r"(?:password|continue|confirm|filename)\s*[:?])\s*[:：]?\s*$", re.IGNORECASE,
)
# Device-side confirmations are part of an already-authorized command's CLI
# protocol, not a second user approval boundary.  Keep this deliberately
# narrower than INTERACTION_PROMPT: credentials, filenames and arbitrary
# questions must never receive a synthetic answer.
CONFIRMATION_PROMPT = re.compile(
    r"(?:continue|confirm|are you sure|warning).*?(?:\[\s*(?:y/n|yes/no|confirm)\s*\]|\(\s*(?:y/n|yes/no)\s*\))\s*[:：]?\s*$"
    r"|(?:\[\s*(?:y/n|yes/no|confirm)\s*\]|\(\s*(?:y/n|yes/no)\s*\))\s*[:：]?\s*$",
    re.IGNORECASE | re.DOTALL,
)


def _terminal_prompt_and_notices(text: str, driver: DeviceDriver) -> tuple[str, list[str]]:
    """Return a terminal prompt and any safe asynchronous trailing notices.

    Some Comware Telnet consoles append asynchronous messages immediately after
    returning a prompt (for example ``<PE 1>%... SHELL_LOGIN``).  The command
    has completed, but a strict final-line prompt check turns that transcript
    into a false timeout.  Accept only a known full prompt followed by lines
    that repeat that prompt as a percent-prefixed notification; arbitrary
    output after a prompt remains incomplete.
    """
    lines = [
        line.strip()
        for line in text.split("\n")
        if line.strip()
    ]
    for index in range(len(lines) - 2, -1, -1):
        prompt = lines[index]
        if not any(pattern.fullmatch(prompt) for pattern in driver.prompt_patterns):
            continue
        trailing = lines[index + 1:]
        if trailing and all(
            # Different Comware console servers either repeat the prompt
            # before a syslog line (``<PE>%...``) or emit the notice on its
            # own line (``%...``).  Both forms are asynchronous output after
            # an already observed prompt, never command payload.
            line.startswith((prompt + "%", "%"))
            for line in trailing
        ):
            return prompt, trailing
    prompt = driver.extract_prompt(text)
    return prompt, []


@dataclass
class CLIReadResult:
    text: str
    prompt: str = ""
    complete: bool = False
    pages: int = 0
    encoding: str = "utf-8"
    error_code: str = ""
    truncated: bool = False
    duration_ms: int = 0
    async_notices: list[str] | None = None

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "prompt": self.prompt,
            "complete": self.complete,
            "pages": self.pages,
            "encoding": self.encoding,
            "error_code": self.error_code,
            "truncated": self.truncated,
            "duration_ms": self.duration_ms,
            "async_notices": list(self.async_notices or []),
            "output_hash": hashlib.sha256(self.text.encode("utf-8")).hexdigest(),
        }


@dataclass
class CLICommandResult:
    command: str
    output: str
    prompt: str
    complete: bool
    pages: int
    encoding: str
    duration_ms: int
    error_code: str = ""
    device_error: str = ""
    truncated: bool = False
    dispatch_status: str = "not_sent"
    async_notices: list[str] | None = None

    def as_dict(self) -> dict:
        return {
            "command": self.command,
            "output": self.output,
            "prompt": self.prompt,
            "complete": self.complete,
            "pages": self.pages,
            "encoding": self.encoding,
            "duration_ms": self.duration_ms,
            "error_code": self.error_code,
            "device_error": self.device_error,
            "truncated": self.truncated,
            "dispatch_status": self.dispatch_status,
            "output_hash": hashlib.sha256(self.output.encode("utf-8")).hexdigest(),
            "async_notices": list(self.async_notices or []),
        }


def decode_terminal_bytes(data: bytes, encodings: tuple[str, ...] = ("utf-8", "gb18030")) -> tuple[str, str]:
    for encoding in dict.fromkeys((*encodings, "utf-8", "gb18030", "latin-1")):
        try:
            return data.decode(encoding), encoding
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace"), "utf-8-replace"


def normalize_terminal_text(text: str, *, _source_positions: list[int] | None = None) -> str:
    """Normalize terminal redraws while retaining meaningful line layout."""
    source = str(text or "")
    if _source_positions is None:
        value = ANSI_ESCAPE.sub("", source)
    else:
        # Streaming pager detection also needs stable identities in the raw
        # transcript, including when ANSI escapes or redraws were removed.
        positions = []
        start = 0
        for escape in ANSI_ESCAPE.finditer(source):
            positions.extend(range(start, escape.start()))
            start = escape.end()
        positions.extend(range(start, len(source)))
        value = "".join(source[index] for index in positions)
    # Apply destructive backspace semantics instead of merely deleting the
    # backspace byte; many pagers erase their own marker this way.
    reduced: list[str] = []
    reduced_positions: list[int] = []
    for index, char in enumerate(value):
        if char == "\b":
            if reduced and reduced[-1] not in {"\n", "\r"}:
                reduced.pop()
                if _source_positions is not None:
                    reduced_positions.pop()
            continue
        reduced.append(char)
        if _source_positions is not None:
            reduced_positions.append(positions[index])
    if _source_positions is not None:
        normalized = []
        for index, char in enumerate(reduced):
            if char == "\n" and index and reduced[index - 1] == "\r":
                continue
            char = "\n" if char == "\r" else char
            if CONTROL_EXCEPT_LAYOUT.fullmatch(char):
                continue
            normalized.append(char)
            _source_positions.append(reduced_positions[index])
        return "".join(normalized)
    value = "".join(reduced).replace("\r\n", "\n").replace("\r", "\n")
    value = CONTROL_EXCEPT_LAYOUT.sub("", value)
    return value


def strip_command_envelope(text: str, command: str, prompt: str) -> str:
    lines = normalize_terminal_text(text).splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].strip() == command.strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if prompt:
        # The runtime has already verified that only recognised async notices
        # can follow this prompt.  Remove both from business command output;
        # the notices remain separately in command_results for diagnostics.
        while lines and (lines[-1].strip().startswith(prompt.strip() + "%") or lines[-1].strip().startswith("%")):
            lines.pop()
        if lines and lines[-1].strip() == prompt.strip():
            lines.pop()
    return "\n".join(lines).strip()


class InteractiveCLISession:
    """Stateful reader over an authenticated SSH shell or Telnet socket.

    ``receive`` returns bytes when data is available, ``None`` when no data is
    currently ready, and ``b''`` when the peer closed the session.
    """

    def __init__(
        self,
        *,
        send: Callable[[bytes], None],
        receive: Callable[[], bytes | None],
        driver: DeviceDriver,
        timeout: float = 15,
        initial_text: str = "",
    ):
        self._send = send
        self._receive = receive
        self.driver = driver
        self.timeout = max(1.0, float(timeout))
        self.prompt = driver.extract_prompt(initial_text)
        self.banner = normalize_terminal_text(initial_text)
        self.encoding = "utf-8"
        self._synchronized = True
        self.deadline: float | None = None

    @property
    def synchronized(self) -> bool:
        return self._synchronized

    def invalidate(self) -> None:
        self._synchronized = False

    def check_ready(self) -> bool:
        """A harmless prompt handshake, never a replay of a business command."""
        if not self._synchronized:
            return False
        self._send(b"\r\n")
        result = self.read_until_prompt(timeout=min(self.timeout, 2.0))
        self._synchronized = result.complete
        if result.prompt:
            self.prompt = result.prompt
        return result.complete

    def bootstrap(self) -> CLIReadResult:
        if self.prompt:
            return CLIReadResult(self.banner, self.prompt, True, encoding=self.encoding)
        self._send(b"\r\n")
        result = self.read_until_prompt(timeout=min(self.timeout, 8.0))
        self.banner = (self.banner + "\n" + result.text).strip()
        if result.prompt:
            self.prompt = result.prompt
        return result

    def refine_driver(self, transcript: str) -> dict:
        resolved, source = resolve_driver(self.driver.vendor, self.banner + "\n" + str(transcript or ""))
        self.driver = resolved
        return resolved.public_profile(detected_from=source)

    def disable_paging(self) -> CLICommandResult | None:
        command = self.driver.disable_paging_command
        return self.run_command(command, internal=True) if command else None

    def run_command(self, command: str, *, internal: bool = False) -> CLICommandResult:
        started = time.monotonic()
        from core.tools.context import get_runtime_cancel_check
        cancel = get_runtime_cancel_check()
        cancelled = bool(cancel and cancel())
        expired = self.deadline is not None and started >= self.deadline
        if cancelled or expired:
            self._synchronized = False
            return CLICommandResult(
                command=command, output="", prompt=self.prompt, complete=False,
                pages=0, encoding=self.encoding, duration_ms=0,
                error_code="cancelled" if cancelled else "execution_timeout",
            )
        if not self._synchronized:
            return CLICommandResult(
                command=command, output="", prompt=self.prompt, complete=False,
                pages=0, encoding=self.encoding, duration_ms=0,
                error_code="cli_session_unsynchronized",
            )
        try:
            payload = (str(command).strip() + "\r\n").encode(self.encoding, errors="strict")
        except (UnicodeError, LookupError):
            return CLICommandResult(
                command=command, output="", prompt=self.prompt, complete=False,
                pages=0, encoding=self.encoding, duration_ms=0,
                error_code="command_encoding_error",
                device_error="Command cannot be encoded for this session; revise the text or verify the device encoding.",
            )
        try:
            self._send(payload)
        except (OSError, EOFError):
            self._synchronized = False
            return CLICommandResult(
                command=command, output="", prompt=self.prompt, complete=False,
                pages=0, encoding=self.encoding, duration_ms=0,
                error_code="command_dispatch_uncertain", dispatch_status="uncertain",
            )
        read = self.read_until_prompt(timeout=self.timeout)
        if read.prompt:
            self.prompt = read.prompt
        output = strip_command_envelope(read.text, command, self.prompt)
        # A duplicate prompt from the previous command can remain buffered and
        # falsely complete this read before the new response arrives. Keep the
        # same command boundary open briefly; never resend the command.
        prompt_only = bool(output and self.driver.extract_prompt(output) == output.strip())
        if not internal and read.complete and (not output or prompt_only):
            follow_up = self.read_until_prompt(timeout=min(self.timeout, 1.0))
            if follow_up.text:
                if follow_up.prompt:
                    self.prompt = follow_up.prompt
                candidate = strip_command_envelope(follow_up.text, command, self.prompt)
                if candidate and self.driver.extract_prompt(candidate) != candidate.strip():
                    read = follow_up
                    output = candidate
        if not read.complete:
            # Never attribute the unfinished command's late bytes to the next
            # command. A new tool operation establishes a fresh connection.
            self._synchronized = False
        device_error = self.driver.command_error(output)
        error_code = read.error_code
        if device_error and not error_code:
            error_code = "device_command_rejected"
        if internal and command == self.driver.disable_paging_command and device_error:
            # Disabling pagination is an optimization. Interactive pager
            # handling remains active when the device rejects the command.
            error_code = "paging_disable_rejected"
        return CLICommandResult(
            command=command,
            output=output,
            prompt=self.prompt,
            complete=read.complete,
            pages=read.pages,
            encoding=read.encoding,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_code=error_code,
            device_error=device_error,
            truncated=read.truncated,
            dispatch_status="sent",
            async_notices=read.async_notices,
        )

    def read_until_prompt(self, *, timeout: float | None = None) -> CLIReadResult:
        started = time.monotonic()
        deadline = started + max(0.5, float(timeout or self.timeout))
        if self.deadline is not None:
            deadline = min(deadline, self.deadline)
        from core.tools.context import get_runtime_cancel_check
        cancel = get_runtime_cancel_check()
        raw = bytearray()
        pages = 0
        peer_closed = False
        truncated = False
        matched_spans: set[tuple[int, str]] = set()
        observed_prompt = ""
        prompt_observed_at = 0.0
        confirmations = 0

        def finish(*, complete=False, error_code="") -> CLIReadResult:
            decoded, encoding = decode_terminal_bytes(bytes(raw), self.driver.encodings)
            text = _remove_pagers(normalize_terminal_text(decoded), self.driver)
            prompt, notices = _terminal_prompt_and_notices(text, self.driver) if complete else ("", [])
            if complete and not prompt:
                # A tail window can begin inside an ordinary output line.
                # Confirm the boundary against the full transcript once.
                complete, error_code = False, "prompt_timeout"
            if complete:
                self.encoding = encoding
            return CLIReadResult(
                text=text, prompt=prompt, complete=complete, pages=pages,
                encoding=encoding, error_code=error_code, truncated=truncated,
                duration_ms=int((time.monotonic() - started) * 1000),
                async_notices=notices,
            )

        while time.monotonic() < deadline:
            if cancel and cancel():
                return finish(error_code="cancelled")
            try:
                chunk = self._receive()
            except (OSError, EOFError):
                peer_closed = True
                break
            if chunk == b"":
                peer_closed = True
                break
            if chunk:
                previous_size = len(raw)
                remaining = MAX_OUTPUT_BYTES - previous_size
                raw.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated = True
                    break
                # Scan overlapping bounded windows, including large receive
                # chunks. Pager identities use raw byte offsets so normalization
                # and a moving window cannot count the same marker twice.
                step = SCAN_WINDOW_BYTES // 2
                for end in range(previous_size, len(raw) + step, step):
                    end = min(end, len(raw))
                    if end <= previous_size:
                        continue
                    start = max(0, end - SCAN_WINDOW_BYTES)
                    decoded, encoding = decode_terminal_bytes(bytes(raw[start:end]), self.driver.encodings)
                    normalized = normalize_terminal_text(decoded)
                    source_positions: list[int] | None = None
                    for rule in self.driver.pager_rules:
                        for match in rule.pattern.finditer(normalized):
                            if source_positions is None:
                                source_positions = []
                                normalize_terminal_text(decoded, _source_positions=source_positions)
                            source_start = source_positions[match.start()]
                            if start and source_start == 0:
                                continue  # a marker cut at the window boundary
                            offset = start + len(decoded[:source_start].encode(encoding))
                            key = (offset, rule.name)
                            if key in matched_spans:
                                continue
                            matched_spans.add(key)
                            pages += 1
                            if pages > MAX_PAGER_ADVANCES:
                                return finish(error_code="pager_limit_exceeded")
                            self._send(rule.response)
                    if end == len(raw):
                        break
                prompt, notices = _terminal_prompt_and_notices(
                    _remove_pagers(normalized, self.driver), self.driver,
                )
                if not prompt and observed_prompt:
                    observed_prompt = ""
                if not prompt and CONFIRMATION_PROMPT.search(normalized):
                    if confirmations < 1:
                        confirmations += 1
                        self._send(b"Y\r\n")
                        continue
                    return finish(error_code="interaction_required")
                if not prompt and INTERACTION_PROMPT.search(normalized):
                    return finish(error_code="interaction_required")
                if prompt:
                    terminal_text = _remove_pagers(normalized, self.driver).strip()
                    if not notices and terminal_text == prompt and len(raw) <= SCAN_WINDOW_BYTES:
                        # Only a complete prompt-only buffer is a stale prompt.
                        return finish(complete=True)
                    observed_prompt = prompt
                    prompt_observed_at = time.monotonic()
            else:
                if observed_prompt and time.monotonic() - prompt_observed_at >= max(
                    0.02, float(self.driver.prompt_settle_seconds),
                ):
                    return finish(complete=True)
                time.sleep(0.02)

        error_code = (
            "output_limit_exceeded" if truncated else
            "connection_closed" if peer_closed else
            "prompt_timeout"
        )
        return finish(error_code=error_code)


def _remove_pagers(text: str, driver: DeviceDriver) -> str:
    value = text
    for rule in driver.pager_rules:
        value = rule.pattern.sub("", value)
    return value
