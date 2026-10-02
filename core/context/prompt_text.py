"""Encode reserved prompt tags without corrupting operational syntax.

This preserves a text boundary, not a security guarantee; authorization remains
the responsibility of the runtime and tool gateways.
"""

import re


RUNTIME_BOUNDARIES = (
    "runtime_identity", "conversation_history", "governed_context",
    "current_user_request", "runtime_guidance", "tool_failure_evidence",
    "auto_tracking_results", "safe_read_recovery", "network_execution_evidence",
)
DATA_BOUNDARIES = (*RUNTIME_BOUNDARIES, "provided_context", "selected_skill_context",
                   "skill_authored_instructions")


def escape_prompt_data(value, *, boundaries=DATA_BOUNDARIES) -> str:
    text = str(value if value is not None else "").replace("\x00", "")
    names = "|".join(re.escape(name) for name in boundaries)
    return re.sub(
        rf"<(\/?)(?:{names})(?:\s[^>]*|\s*/?)>",
        lambda match: "&lt;" + match[0][1:-1] + "&gt;",
        text,
        flags=re.IGNORECASE,
    )
