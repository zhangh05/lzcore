"""Device evidence presentation derived from execution facts, never business health."""

from __future__ import annotations

import errno
import socket
from typing import Any


def exception_code(error: Exception) -> str:
    if isinstance(error, socket.gaierror):
        return "host_resolution_failed"
    if isinstance(error, TimeoutError):
        return "connection_timeout"
    if isinstance(error, ConnectionRefusedError):
        return "connection_refused"
    if isinstance(error, OSError) and error.errno in {
        errno.ENETUNREACH,
        errno.EHOSTUNREACH,
    }:
        return "network_unreachable"
    if type(error).__name__ in {"AuthenticationException", "BadAuthenticationType"}:
        return "authentication_failed"
    return "connection_failed"


_DIAGNOSTICS = {
    "host_resolution_failed": (
        "target",
        "管理地址解析失败",
        "核对设备管理地址与当前 DNS。",
    ),
    "connection_refused": (
        "tcp",
        "管理端口拒绝连接",
        "核对管理协议、端口及设备服务是否开启。",
    ),
    "network_unreachable": (
        "tcp",
        "到管理地址的网络不可达",
        "核对当前网络、VPN、路由与源地址。",
    ),
    "connection_timeout": (
        "connection",
        "连接或终端响应超时",
        "结合已完成阶段核对网络、访问控制及设备响应。",
    ),
    "host_key_observation_required": ("host_key", "尚未取得主机指纹", "先测试连接取得指纹，再核对接受。"),
    "host_key_not_trusted": (
        "host_key",
        "首次连接需要核对主机指纹",
        "在设备连接管理中核对指纹后明确接受。",
    ),
    "host_key_mismatch": (
        "host_key",
        "设备主机指纹发生变化",
        "核对设备身份或更换记录，确认原因后更新信任。",
    ),
    "authentication_failed": ("auth", "设备认证失败", "核对账号、认证方式与凭据。"),
    "username_required": ("auth", "缺少设备用户名", "编辑连接并配置设备账号。"),
    "username_required_by_device": (
        "auth",
        "设备要求用户名",
        "编辑连接并配置设备账号。",
    ),
    "password_required_by_device": ("auth", "设备要求密码", "编辑连接并配置设备凭据。"),
    "device_prompt_not_detected": (
        "prompt",
        "未识别到完整设备提示符",
        "核对终端登录流程、协议与设备回显。",
    ),
    "unsupported_protocol": ("target", "连接协议不受支持", "选择 SSH 或 Telnet。"),
}


def execution_diagnostic(result: dict[str, Any]) -> dict[str, Any]:
    code = str(result.get("error_code") or result.get("error") or "")
    if result.get("execution_may_continue") or result.get("status") == "unknown":
        phase, summary, next_step = (
            "execution",
            "写入结果未知",
            "先回读并核对实际状态，再决定后续操作。",
        )
        code = "configuration_outcome_unknown"
    elif code in _DIAGNOSTICS:
        phase, summary, next_step = _DIAGNOSTICS[code]
    elif result.get("configuration_ok") is True:
        phase, summary, next_step = (
            "execution",
            "配置命令已处理，业务效果待核对",
            "按任务目标进行独立写后读取。",
        )
    elif result.get("read_ok") is False or result.get("status") == "partial":
        phase, summary, next_step = (
            "command",
            "部分命令或回显不完整",
            "查看逐命令结果，针对缺失证据继续处理。",
        )
    elif result.get("ok"):
        phase, summary, next_step = (
            "complete",
            "本次读取完成" if result.get("command_results") else "本次连接验证成功",
            "",
        )
    else:
        phase, summary, next_step = (
            "connection",
            "本次连接未完成",
            "查看错误与已完成阶段，核对连接配置。",
        )
    return {
        "code": code,
        "phase": phase,
        "summary": summary,
        "next_step": next_step,
        "retryable": not bool(
            result.get("execution_may_continue")
            or result.get("automatic_retry_allowed") is False
            or code
            in {
                "host_key_mismatch",
                "host_key_not_trusted",
                "authentication_failed",
                "username_required",
                "username_required_by_device",
                "password_required_by_device",
            }
        ),
    }


def device_presentation(
    result: dict[str, Any], *, action: str, target: dict[str, Any], observed_at: str
) -> dict[str, Any]:
    rows = result.get("command_results") or []
    unknown = bool(
        result.get("execution_may_continue") or result.get("status") == "unknown"
    )
    state = (
        "unknown"
        if unknown
        else "unavailable"
        if result.get("connection_ok") is False
        else "partial"
        if result.get("status") == "partial" or result.get("read_ok") is False
        else "ok"
        if result.get("ok")
        else "fail"
    )
    return {
        "kind": "network_device",
        "state": state,
        "action": action,
        "target": target,
        "observed_at": observed_at,
        "diagnostic": result.get("diagnostic") or execution_diagnostic(result),
        "stages": result.get("stages") or [],
        "verification_status": "required"
        if action == "configure"
        else "observation_only",
        "command_results": [
            {
                key: row.get(key)
                for key in (
                    "command",
                    "complete",
                    "error_code",
                    "device_error",
                    "dispatch_status",
                    "truncated",
                    "pages",
                    "encoding",
                    "duration_ms",
                )
            }
            for row in rows
        ],
        "command_count": len(rows),
        "output_available": bool(rows),
    }
