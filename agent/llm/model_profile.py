"""One answer to "what can this model do?".

Mainstream agents keep model capabilities in a catalog and let users override
them per model (OpenCode reads models.dev; LobeChat / Cherry Studio expose
vision / tools / reasoning / context window switches on a custom model).  This
module is lzcore's single source for that answer, replacing the name-substring
tables that used to live in several places.

Resolution order, per field:
1. ``capabilities`` overrides saved on the provider (the user knows best);
   legacy ``vision_enabled`` still counts as a vision override.
2. The bundled models.dev catalog (``model_catalog_data.json``), matched by the
   provider's endpoint first, then by model id across first-party vendors.
3. Conservative name heuristics for models the catalog does not know.
4. Defaults (source "unknown"): text only, tools on, no thinking control, 128K context.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

CATALOG_FILE = Path(__file__).with_name("model_catalog_data.json")
DEFAULT_CONTEXT_WINDOW = 128_000
DEFAULT_MAX_OUTPUT = 8_192
THINKING_DEFAULT = "provider_default"
EFFORT_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
# Fields a user may pin on a provider; ``None`` (or absent) means "automatic".
# Only fields that change what lzcore sends are overridable; tool support is
# reported from the catalog but the agent always needs tools.
OVERRIDE_BOOL_FIELDS = ("vision", "reasoning", "temperature")
OVERRIDE_INT_FIELDS = ("context_window", "max_output")


@dataclass(frozen=True)
class ModelProfile:
    model: str
    vision: bool = False
    pdf: bool = False
    tools: bool = True
    reasoning: bool = False
    temperature: bool = True
    context_window: int = DEFAULT_CONTEXT_WINDOW
    max_output: int = DEFAULT_MAX_OUTPUT
    # Values a turn may pass as ``thinking`` besides "provider_default".
    thinking_options: tuple[str, ...] = ()
    # The model rejects thinking="disabled" (e.g. MiniMax-M3.1).
    thinking_required: bool = False
    cost_per_million: tuple[float, float] | None = None
    catalog_ref: str = ""
    display_name: str = ""
    sources: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "vision": self.vision,
            "pdf": self.pdf,
            "tools": self.tools,
            "reasoning": self.reasoning,
            "temperature": self.temperature,
            "context_window": self.context_window,
            "max_output": self.max_output,
            "thinking_options": list(self.thinking_options),
            "thinking_required": self.thinking_required,
            "cost_per_million": list(self.cost_per_million) if self.cost_per_million else None,
            "catalog_ref": self.catalog_ref,
            "display_name": self.display_name,
            "sources": dict(self.sources),
        }


# ── catalog ─────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    try:
        data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"providers": {}}
    return data if isinstance(data, dict) and isinstance(data.get("providers"), dict) else {"providers": {}}


@lru_cache(maxsize=1)
def _global_index() -> dict[str, tuple[str, str]]:
    """lower(model id) -> (catalog provider, exact id); first provider wins."""
    index: dict[str, tuple[str, str]] = {}
    for pid, provider in load_catalog()["providers"].items():
        for mid in provider.get("models") or {}:
            index.setdefault(mid.lower(), (pid, mid))
    return index


def _endpoint_key(url: str) -> str:
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    path = parts.path.rstrip("/").lower()
    return f"{host}{path}" if host else ""


def _providers_for_endpoint(base_url: str) -> list[str]:
    key = _endpoint_key(base_url)
    if not key:
        return []
    host = key.split("/", 1)[0]
    exact, same_host = [], []
    for pid, provider in load_catalog()["providers"].items():
        api = _endpoint_key(provider.get("api") or "")
        if not api:
            continue
        if api == key:
            exact.append(pid)
        elif api.split("/", 1)[0] == host:
            same_host.append(pid)
    return exact + same_host


def _candidate_ids(model: str) -> list[str]:
    """The id as configured, then common spellings of the same model."""
    raw = str(model or "").strip()
    out = [raw]
    if "/" in raw:  # gateway style "openai/gpt-4o"
        out.append(raw.rsplit("/", 1)[1])
    for name in list(out):
        if ":" in name:  # ollama tags "qwen3:8b"
            out.append(name.split(":", 1)[0])
        out.append(re.sub(r"-(20\d{2}-?\d{2}-?\d{2}|\d{4})$", "", name))  # dated snapshots
        out.append(re.sub(r"-latest$", "", name))
    seen, result = set(), []
    for name in out:
        if name and name.lower() not in seen:
            seen.add(name.lower())
            result.append(name)
    return result


def lookup_catalog(model: str, base_url: str = "") -> tuple[str, dict[str, Any]] | None:
    """Return ("provider/model", record) or None."""
    providers = load_catalog()["providers"]
    candidates = _candidate_ids(model)
    for pid in _providers_for_endpoint(base_url):
        models = providers[pid].get("models") or {}
        lowered = {mid.lower(): mid for mid in models}
        for name in candidates:
            mid = lowered.get(name.lower())
            if mid:
                return f"{pid}/{mid}", models[mid]
    index = _global_index()
    for name in candidates:
        hit = index.get(name.lower())
        if hit:
            pid, mid = hit
            return f"{pid}/{mid}", providers[pid]["models"][mid]
    return None


# ── heuristics for models the catalog does not know ─────────────────────

# Deliberately narrow: an opaque private name ("foo-vl-001") is not assumed to see.
_VISION_MARKERS = ("vision", "qwen-vl", "qwen2-vl", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-6", "claude-3", "claude-4",
                   "claude-sonnet", "claude-opus", "claude-haiku", "gemini", "minimax-m3")
_CONTEXT_HINTS = (
    (("minimax-m3", "deepseek-v3", "deepseek-v4"), 512_000),
    (("claude",), 200_000),
    (("gemini",), 1_000_000),
    (("gpt-4o", "gpt-4-turbo", "qwen-max", "glm-4"), 128_000),
    (("gpt-3.5",), 16_000),
)


def _heuristic(model: str) -> dict[str, Any]:
    name = model.lower()
    rec: dict[str, Any] = {}
    if any(marker in name for marker in _VISION_MARKERS):
        rec["vision"] = True
    for aliases, size in _CONTEXT_HINTS:
        if any(alias in name for alias in aliases):
            rec["context"] = size
            break
    if name.startswith("minimax-m3"):
        rec["reasoning"] = True
        rec["reasoning_options"] = [{"type": "toggle"}]
    return rec


# ── thinking controls lzcore can actually send ─────────────────────────

def _thinking(model: str, protocol: str, record: dict[str, Any]) -> tuple[tuple[str, ...], bool]:
    name = model.lower()
    # MiniMax M3 family speaks Anthropic Messages with {"thinking": {"type": ...}}.
    if name.startswith("minimax-m3"):
        return ("adaptive", "disabled"), name.startswith("minimax-m3.1")
    if protocol != "openai_compatible":
        return (), False
    # OpenAI-compatible chat completions accept reasoning_effort.
    for opt in record.get("reasoning_options") or []:
        if opt.get("type") == "effort":
            values = tuple(v for v in EFFORT_LEVELS if v in (opt.get("values") or []))
            return values, False
    return (), False


# ── public API ──────────────────────────────────────────────────────────

def normalize_overrides(raw: Any) -> dict[str, Any]:
    """Keep only valid, explicitly set override fields."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in OVERRIDE_BOOL_FIELDS:
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
    for key in OVERRIDE_INT_FIELDS:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[key] = value
    return out


def validate_overrides(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, dict):
        return ["capabilities must be an object"]
    errors = []
    for key, value in raw.items():
        if key in OVERRIDE_BOOL_FIELDS:
            if value is not None and not isinstance(value, bool):
                errors.append(f"capabilities.{key} must be true, false or null")
        elif key in OVERRIDE_INT_FIELDS:
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 1_000 <= value <= 10_000_000):
                errors.append(f"capabilities.{key} must be an integer between 1000 and 10000000, or null")
        else:
            errors.append(f"unknown capability: {key}")
    return errors


def resolve_model_profile(config: dict | None) -> ModelProfile:
    """Resolve capabilities for one provider runtime/saved config."""
    from agent.llm.protocols import resolve_protocol

    config = config or {}
    model = str(config.get("model") or "")
    protocol = resolve_protocol(str(config.get("provider") or "custom"), config)
    overrides = normalize_overrides(config.get("capabilities"))
    if "vision" not in overrides and isinstance(config.get("vision_enabled"), bool):
        overrides["vision"] = config["vision_enabled"]

    hit = lookup_catalog(model, str(config.get("base_url") or "")) if model else None
    record: dict[str, Any] = dict(hit[1]) if hit else {}
    base_source = "catalog" if hit else "heuristic"
    guessed = {} if hit else _heuristic(model)
    if guessed.get("reasoning_options") and not record.get("reasoning_options"):
        record["reasoning_options"] = guessed["reasoning_options"]

    sources: dict[str, str] = {}

    def pick(key: str, catalog_key: str, default: Any) -> Any:
        if key in overrides:
            sources[key] = "user"
            return overrides[key]
        value = record.get(catalog_key)
        # Booleans count as answers (False is a real "no"); a 0 limit means "unknown".
        if isinstance(value, bool) or (value is not None and value != 0):
            sources[key] = "catalog"
            return record[catalog_key]
        if catalog_key in guessed:
            sources[key] = "heuristic"
            return guessed[catalog_key]
        sources[key] = "unknown"
        return default

    vision = bool(pick("vision", "vision", False))
    tools = bool(record["tools"]) if isinstance(record.get("tools"), bool) else True
    sources["tools"] = "catalog" if isinstance(record.get("tools"), bool) else "unknown"
    reasoning = bool(pick("reasoning", "reasoning", False))
    temperature = bool(pick("temperature", "temperature", True))
    context_window = int(pick("context_window", "context", DEFAULT_CONTEXT_WINDOW))
    max_output = int(pick("max_output", "output", DEFAULT_MAX_OUTPUT))
    thinking_options, thinking_required = _thinking(model, protocol, record)
    if overrides.get("reasoning") is False:
        thinking_options, thinking_required = (), False
    cost = record.get("cost")
    return ModelProfile(
        model=model,
        vision=vision,
        pdf=bool(record.get("pdf")),
        tools=tools,
        reasoning=reasoning,
        temperature=temperature,
        context_window=context_window,
        max_output=max_output,
        thinking_options=thinking_options,
        thinking_required=thinking_required,
        cost_per_million=(float(cost[0]), float(cost[1])) if isinstance(cost, list) and len(cost) == 2 else None,
        catalog_ref=hit[0] if hit else "",
        display_name=str(record.get("name") or ""),
        sources={**sources, "_base": base_source},
    )


def profile_for_model_name(model: str) -> ModelProfile:
    """Lookup when only a model name is known (budgets, cost estimates)."""
    return resolve_model_profile({"model": model, "provider": "custom"})


# ── vision probe ────────────────────────────────────────────────────────

VISION_PROBE_COLORS = {"red": (220, 38, 38), "green": (22, 163, 74), "blue": (37, 99, 235), "yellow": (234, 179, 8)}
VISION_PROBE_WORDS = {"red": ("red", "红"), "green": ("green", "绿"), "blue": ("blue", "蓝"), "yellow": ("yellow", "黄")}
VISION_PROBE_PROMPT = "What is the single dominant color of this image? Answer with one English word."


def vision_probe_image(color: str, size: int = 48) -> str:
    """A solid-color PNG as a data URL: answerable only by actually seeing it."""
    import base64
    import struct
    import zlib

    r, g, b = VISION_PROBE_COLORS[color]
    row = b"\x00" + bytes((r, g, b)) * size
    raw = row * size

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def vision_probe_passed(color: str, reply: str) -> bool:
    text = str(reply or "").lower()
    if not any(word in text for word in VISION_PROBE_WORDS[color]):
        return False
    # A model that lists every color has not looked.
    return sum(any(w in text for w in words) for words in VISION_PROBE_WORDS.values()) == 1
