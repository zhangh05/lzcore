"""Single command-intent contract for raw network-device execution.

The classifier, executor, tool schema, and selected-Skill prompt all consume
this module.  Adding a command family therefore changes one declarative
contract rather than creating prompt-only exceptions.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re
import shlex
from typing import Any


_UNSAFE_READ_SYNTAX = ("\n", "\r", ";", "&&", "`", "$(", ">", "<")
_OUTPUT_WRITE_OPERATORS = ("redirect", "append", "tee")


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
        lexer = shlex.shlex(value, posix=False, punctuation_chars="|")
        lexer.whitespace_split = True
        lexer.commenters = ""
        try:
            tokens = list(lexer)
        except ValueError:
            return RAW_COMMAND_INTENTS[1]
        if any(token == "|" and index + 1 < len(tokens)
               and tokens[index + 1].lower() in _OUTPUT_WRITE_OPERATORS
               for index, token in enumerate(tokens)):
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
        "Read-only include/exclude filters remain observations. "
        "For device-originated verification, send the device's raw "
        "observation command in `action=read`; its complete output is evidence. "
        "The runtime sends the exact command text and order supplied by the model. "
        "Do not invent a separate tool, shell channel, approval class, or command rewrite."
    )
