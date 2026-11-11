"""Bounded, read-only model discovery for configured LLM transports."""

import json
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from agent.llm.protocols import resolve_protocol
from agent.llm.provider import _redact_error_detail


MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_MODELS = 500


def _safe_error(detail: str, api_key: str) -> str:
    # Providers sometimes echo the raw key without a recognizable header/prefix.
    if api_key:
        detail = detail.replace(api_key, "[REDACTED]")
    return _redact_error_detail(detail)[:500]


def _http_error_detail(error: HTTPError) -> str:
    try:
        with error:
            body = error.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return str(error.reason)
        text = body.decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return text or str(error.reason)
        if isinstance(payload, dict):
            detail = payload.get("error", payload.get("message"))
            if isinstance(detail, dict):
                detail = detail.get("message")
            if isinstance(detail, str):
                return detail
        return str(error.reason)
    except (OSError, HTTPException, ValueError):
        return str(error.reason)


def list_models(cfg: dict) -> dict:
    """Return a normalized catalog or a safe provider failure, without writes."""
    base_url = (cfg.get("base_url") or "").rstrip("/")
    api_key = cfg.get("api_key") or ""
    protocol = resolve_protocol(cfg.get("provider", "custom"), cfg)
    headers = {"Accept": "application/json"}
    if protocol == "anthropic_messages":
        if not base_url.endswith("/v1"):
            base_url += "/v1"
        headers.update({"x-api-key": api_key, "anthropic-version": "2023-06-01"})
    elif protocol == "openai_compatible":
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
    else:
        return {"ok": False, "error": "unsupported provider protocol"}

    try:
        # urlopen retains urllib's default, bounded redirect handling.
        req = Request(f"{base_url}/models", headers=headers, method="GET")
        with urlopen(req, timeout=10) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return {"ok": False, "error": "model catalog exceeds 2 MB limit"}
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            return {"ok": False, "error": "invalid model catalog JSON"}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "invalid model catalog response"}
        entries = payload.get("data")
        ollama = protocol == "openai_compatible" and "data" not in payload
        if ollama:
            entries = payload.get("models")
        if not isinstance(entries, list):
            return {"ok": False, "error": "invalid model catalog response"}

        models = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            model_id = (entry.get("name") or entry.get("model")) if ollama else entry.get("id")
            if not isinstance(model_id, str) or not model_id.strip() or model_id in models:
                continue
            label = entry.get("display_name") if protocol == "anthropic_messages" else model_id
            item = {"id": model_id, "label": label if isinstance(label, str) and label else model_id}
            if isinstance(entry.get("owned_by"), str):
                item["owned_by"] = entry["owned_by"]
            models[model_id] = item
        return {
            "ok": True,
            "models": [models[model_id] for model_id in sorted(models)[:MAX_MODELS]],
            "source": urlsplit(base_url).hostname or "",
        }
    except HTTPError as exc:
        detail = _safe_error(_http_error_detail(exc), api_key)
        return {"ok": False, "error": f"HTTP {exc.code}: {detail}", "http_status": exc.code}
    except (URLError, OSError, HTTPException, ValueError) as exc:
        return {"ok": False, "error": _safe_error(str(exc), api_key)}
