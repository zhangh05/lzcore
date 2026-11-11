#!/usr/bin/env bash
# Shared preflight policy for local service startup. This file intentionally
# contains only environment/host predicates so it can be tested without
# starting a server or occupying a port.

startup_security_is_truthy() {
    case "${1:-}" in
        true|TRUE|True|1|yes|YES|Yes|on|ON|On) return 0 ;;
        *) return 1 ;;
    esac
}

startup_security_is_loopback_host() {
    local host="${1:-}"
    host="${host#[}"
    host="${host%]}"
    case "$host" in
        localhost|127.*|::1) return 0 ;;
        *) return 1 ;;
    esac
}

startup_security_auth_mode() {
    if startup_security_is_truthy "${LZCORE_AUTH_ENABLED:-}" \
        && [ -n "${LZCORE_API_TOKEN:-}" ]; then
        printf '%s\n' 'api_token'
        return 0
    fi
    if startup_security_is_truthy "${LZCORE_IDENTITY_ENABLED:-}"; then
        printf '%s\n' 'identity'
        return 0
    fi
    local login_flag="${LZCORE_LOGIN_ENABLED:-}"
    if { [ -z "$login_flag" ] || startup_security_is_truthy "$login_flag"; } \
        && [ -n "${LZCORE_LOGIN_USERNAME:-}" ] \
        && [ -n "${LZCORE_LOGIN_PASSWORD:-}" ]; then
        printf '%s\n' 'login'
        return 0
    fi
    return 1
}

startup_security_validate_network_exposure() {
    local backend_host="${1:?backend host is required}"
    local frontend_host="${2:?frontend host is required}"
    local mode=""

    if startup_security_is_loopback_host "$backend_host" \
        && startup_security_is_loopback_host "$frontend_host"; then
        return 0
    fi

    mode="$(startup_security_auth_mode || true)"
    if [ -n "$mode" ]; then
        printf '%s\n' "[security] Network listener allowed with ${mode} authentication."
        return 0
    fi

    if startup_security_is_truthy "${LZCORE_ALLOW_UNAUTHENTICATED_NETWORK:-}"; then
        printf '%s\n' "[security] DANGER: unauthenticated network listener explicitly allowed by LZCORE_ALLOW_UNAUTHENTICATED_NETWORK=true." >&2
        return 0
    fi

    printf '%s\n' "[security] Refusing network listener without effective API token, login, or identity authentication. Use loopback hosts, configure authentication, or explicitly set LZCORE_ALLOW_UNAUTHENTICATED_NETWORK=true for trusted development only." >&2
    return 1
}

# Default listen hosts when BACKEND_HOST / FRONTEND_HOST are not set.
# The product default is 0.0.0.0 (reachable on the LAN). It falls back to
# loopback only where a network listener would be refused anyway, so a fresh
# checkout without authentication still starts instead of failing:
# - backend: 0.0.0.0 when the exposure policy above would accept it;
# - frontend: additionally requires LZCORE_ALLOW_LAN or
#   LZCORE_ALLOW_UNAUTHENTICATED_NETWORK, the same switches frontend/vite.guard.ts honours.
# Prints "<backend_host> <frontend_host>".
startup_security_default_hosts() {
    local backend="127.0.0.1" frontend="127.0.0.1"
    if startup_security_auth_mode >/dev/null 2>&1 \
        || startup_security_is_truthy "${LZCORE_ALLOW_UNAUTHENTICATED_NETWORK:-}"; then
        backend="0.0.0.0"
        if startup_security_is_truthy "${LZCORE_ALLOW_LAN:-}" \
            || startup_security_is_truthy "${LZCORE_ALLOW_UNAUTHENTICATED_NETWORK:-}"; then
            frontend="0.0.0.0"
        fi
    fi
    printf '%s %s\n' "$backend" "$frontend"
}
