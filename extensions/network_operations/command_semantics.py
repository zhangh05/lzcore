"""Single command-intent contract for raw network-device execution.

The classifier, executor, tool schema, and selected-Skill prompt all consume
this module.  Adding a command family therefore changes one declarative
contract rather than creating prompt-only exceptions.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any


_UNSAFE_READ_SYNTAX = ("\n", "\r", ";", "&&", "`", "$(", ">", "<")
_OUTPUT_WRITE_OPERATORS = ("redirect", "append", "tee")
_READ_PIPE_FILTERS = (
    "include", "exclude", "begin", "section", "count", "i", "e", "b", "s",
    "no-more", "grep", "match",
)
_REGEX_PIPE_FILTERS = tuple(item for item in _READ_PIPE_FILTERS if item not in ("count", "no-more"))


def _split_read_pipeline(value: str) -> list[list[str]] | None:
    """Keep raw pipe adjacency and quoted arguments while finding stages."""
    segments: list[list[str]] = [[]]
    word: list[str] = []
    quote = ""
    escaped = False
    for index, char in enumerate(value):
        was_escaped = escaped
        # Escapes affect quoting only; they cannot hide pipeline operators.
        escaped = char == "\\" and not was_escaped and quote != "'"
        if quote:
            word.append(char)
            if char == quote and not was_escaped:
                quote = ""
        elif char in ("'", '"') and not was_escaped:
            quote = char
            word.append(char)
        elif char.isspace():
            if word:
                segments[-1].append("".join(word))
                word.clear()
        elif char == "&":
            return None
        elif char == "|":
            if index + 1 < len(value) and value[index + 1] == "|":
                return None
            if (
                len(segments) > 1
                and segments[-1]
                and segments[-1][0].lower() in _REGEX_PIPE_FILTERS
                and word
                and index + 1 < len(value)
                and not value[index - 1].isspace()
                and not value[index + 1].isspace()
            ):
                word.append(char)
            else:
                if word:
                    segments[-1].append("".join(word))
                    word.clear()
                segments.append([])
        else:
            word.append(char)
    if quote:
        return None
    if word:
        segments[-1].append("".join(word))
    return segments if all(segments) else None


@dataclass(frozen=True)
class CommandIntent:
    """The server-owned execution meaning of one raw device command."""

    name: str
    command_starters: tuple[str, ...]
    action: str
    read_only: bool
    description: str


RAW_COMMAND_INTENTS: tuple[CommandIntent, ...] = (
    CommandIntent(
        name="observation",
        command_starters=("display", "show", "ping"),
        action="read",
        read_only=True,
        description="Device-native observation and verification commands.",
    ),
    CommandIntent(
        name="configuration",
        command_starters=(),
        action="configure",
        read_only=False,
        description="Every raw command not classified as an observation.",
    ),
)


def classify_raw_command(command: str, vendor: str = "") -> CommandIntent:
    """Return the only execution intent permitted for ``command``.

    Vendor remains part of the API for future driver-specific declarative
    intents.  It is intentionally not a prompt-time guess today.
    """
    del vendor
    value = str(command or "").strip()
    observation = RAW_COMMAND_INTENTS[0]
    if value and not any(marker in value for marker in _UNSAFE_READ_SYNTAX):
        # A show/display prefix does not make output redirection a read. Parse
        # pipe operators separately from quoted filter text, and preserve the
        # exact command for the executor and device-account authorization.
        segments = _split_read_pipeline(value)
        if segments is None:
            return RAW_COMMAND_INTENTS[1]
        for segment in segments[1:]:
            if segment[0].lower() not in _READ_PIPE_FILTERS:
                return RAW_COMMAND_INTENTS[1]
            if segment[0].lower() == "no-more" and len(segment) != 1:
                return RAW_COMMAND_INTENTS[1]
        starters = "|".join(re.escape(item) for item in observation.command_starters)
        if re.match(rf"^(?:{starters})(?:\s|$)", value, re.IGNORECASE):
            return observation
    return RAW_COMMAND_INTENTS[1]


def is_raw_observation(command: str, vendor: str = "") -> bool:
    return classify_raw_command(command, vendor).read_only


def raw_command_semantics() -> dict[str, Any]:
    """Stable, model-visible contract derived from the executable classifier."""
    observations = RAW_COMMAND_INTENTS[0]
    return {
        "schema": "network.raw_command_semantics.v1",
        "tool": "network.operations.device.manage",
        "execution": "raw_device_cli",
        "intents": [asdict(item) for item in RAW_COMMAND_INTENTS],
        "rules": {
            "action_is_server_resolved": True,
            "raw_command_output_is_complete_evidence": True,
            "configuration_is_the_default_for_unclassified_commands": True,
            "read_command_starters": list(observations.command_starters),
            "output_write_operators": list(_OUTPUT_WRITE_OPERATORS),
            "read_pipe_filters": list(_READ_PIPE_FILTERS),
        },
    }


def render_raw_command_guidance() -> str:
    """Render model guidance from the same contract used by the executor."""
    semantics = raw_command_semantics()
    starters = ", ".join(f"`{item}`" for item in semantics["rules"]["read_command_starters"])
    return (
        "Use `network.operations.device.manage` with an exact `connection_id` "
        "and ordered raw `commands`. The server resolves each command's intent "
        f"from the raw-command contract: single-line commands starting with {starters}, "
        f"without chaining or unsafe syntax {list(_UNSAFE_READ_SYNTAX)!r}, are "
        "observations and execute as `read`; every other command executes as "
        "`configure`. Output pipes using "
        + ", ".join(f"`{operator}`" for operator in _OUTPUT_WRITE_OPERATORS)
        + " write files and execute as `configure`, even after a show/display command. "
        "Every pipe stage must be a known display filter: "
        + ", ".join(f"`{item}`" for item in _READ_PIPE_FILTERS)
        + "; unknown pipe stages require configuration approval. "
        "Within a regex filter's arguments, an unquoted single `|` touching "
        "non-whitespace on both sides is regex alternation; other unquoted "
        "pipes separate stages, including attached pipes before any filter arguments. "
        "Quoted pipes are argument text; unquoted `||` is never read-only. "
        "For device-originated verification, send the device's raw "
        "observation command in `action=read`; its complete output is evidence. "
        "The runtime sends the exact command text and order supplied by the model. "
        "Do not invent a separate tool, shell channel, approval class, or command rewrite."
    )
