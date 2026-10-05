"""Provider billing failures shared by transport and runtime recovery."""

import re


def is_balance_insufficient(error, http_status=None):
    """Only explicit billing evidence is terminal; ordinary 429 is transient."""
    value = str(error or "").lower()
    return (
        http_status == 402
        or bool(re.search(r"(?:provider_http_|http(?: error)?[ :]+)402\b", value))
        or any(
            marker in value
            for marker in (
                "balance_insufficient",
                "insufficient_balance",
                "insufficient_quota",
                "insufficient balance",
                "insufficient credit",
                "credit balance is too low",
                "account balance exceeded your current quota",
                "you exceeded your current quota",
                "payment required",
                "余额不足",
                "余额已耗尽",
                "额度已用尽",
            )
        )
    )
