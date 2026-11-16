"""Model capability checks used on the request path.

Capabilities come from :mod:`agent.llm.model_profile` (user overrides, then
the bundled models.dev catalog, then conservative name heuristics).  Unknown
models stay text-only: sending images optimistically turns an understandable
limitation into a provider 400.
"""

from __future__ import annotations


def supports_vision(config: dict | None) -> bool:
    """Whether the configured chat model accepts image inputs."""
    from agent.llm.model_profile import resolve_model_profile
    return resolve_model_profile(config).vision
