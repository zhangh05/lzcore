"""Bounded deterministic text processing; preserves explicit coverage."""

import regex

REGEX_TIMEOUT_SECONDS = 1.0


def regex_matches(pattern: str, text: str, cancel_check=None) -> dict:
    matches, count = [], 0
    try:
        for match in regex.finditer(pattern, text, regex.MULTILINE | regex.DOTALL | regex.VERSION0,
                                    timeout=REGEX_TIMEOUT_SECONDS):
            if cancel_check and cancel_check():
                return {"ok": False, "error_code": "TOOL_CANCELLED", "error": "Text matching cancelled"}
            count += 1
            if len(matches) < 100:
                value = match.group() if not match.re.groups else (
                    match.group(1) or "" if match.re.groups == 1 else tuple(v or "" for v in match.groups())
                )
                matches.append(value)
    except TimeoutError:
        return {"ok": False, "error_code": "REGEX_TIMEOUT",
                "error": "Regex computation exceeded its deadline; narrow the input or revise the expression.",
                "partial_match_count": count, "complete": False, "automatic_retry_allowed": False}
    return {"ok": True, "matches": matches, "match_count": count,
            "truncated": count > len(matches), "complete": True,
            "summary": f"Regex matched {count} occurrence(s); returned {len(matches)}."}
