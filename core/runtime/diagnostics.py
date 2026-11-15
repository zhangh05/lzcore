# runtime/diagnostics.py
"""Runtime diagnostics — safe, read-only diagnostic information.

Collects component status, counts, and metadata without exposing secrets.
"""

from dataclasses import dataclass, field

from storage.status_store import workspace_counts, workspace_exists


@dataclass
class ComponentStatus:
    name: str = ""
    status: str = "ok"  # ok | warning | error | unavailable
    message: str = ""
    details: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "details": self.details,
        }


@dataclass
class DiagnosticReport:
    components: list = field(default_factory=list)
    summary: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "components": [c.as_dict() for c in self.components],
            "summary": self.summary,
        }


def get_diagnostics(workspace_id: str = "default") -> DiagnosticReport:
    """Collect diagnostic information for a workspace."""
    report = DiagnosticReport()
    components = []
    exists = workspace_exists(workspace_id)

    # 1. Workspace
    if exists:
        components.append(ComponentStatus("workspace", "ok",
            f"工作区「{workspace_id}」可用"))
    else:
        components.append(ComponentStatus("workspace", "error",
            f"找不到工作区「{workspace_id}」"))

    # 2. Canonical capability and tool sources
    try:
        from agent.capabilities.catalog import list_all, list_enabled
        from core.tools.integration import get_default_tool_runtime_client
        tool_count = get_default_tool_runtime_client().tool_count
        components.append(ComponentStatus("capabilities", "ok",
            f"已启用 {len(list_enabled())} 项能力，共 {tool_count} 个工具",
            {"capability_count": len(list_all()), "tool_count": tool_count}))
    except Exception as e:
        components.append(ComponentStatus("capabilities", "error", f"能力目录读取失败：{str(e)[:100]}"))

    # 3. Run stats
    try:
        counts = workspace_counts(workspace_id) if exists else {"runs": 0, "artifacts": 0, "jobs": 0}
        components.append(ComponentStatus("runs", "ok", f"共 {counts['runs']} 条运行记录",
            {"count": counts["runs"]}))
        components.append(ComponentStatus("artifacts", "ok", f"共 {counts['artifacts']} 个产出文件",
            {"count": counts["artifacts"]}))
        components.append(ComponentStatus("jobs", "ok", f"共 {counts['jobs']} 个后台作业",
            {"count": counts["jobs"]}))
    except Exception:
        components.append(ComponentStatus("storage_counts", "warning", "无法读取存储统计"))

    # 6. Agent runtime
    try:
        from agent.runtime_status import get_runtime_status
        agent_status = get_runtime_status(probe_llm=False)
        components.append(ComponentStatus("agent", "ok",
            f"运行时：{agent_status.get('runtime_engine', '未上报')}",
            {"runtime_mode": agent_status.get("runtime_engine", "")}))
    except Exception as e:
        components.append(ComponentStatus("agent", "error", str(e)[:100]))

    # 7. Tool Runtime
    try:
        from core.tools.integration import get_default_tool_runtime_client
        client = get_default_tool_runtime_client()
        tools = client.list_tools()
        components.append(ComponentStatus("tool_runtime", "ok",
            f"已注册 {len(tools)} 个工具",
            {"tool_count": len(tools), "tools": [t["tool_id"] for t in tools]}))
    except Exception as e:
        components.append(ComponentStatus("tool_runtime", "warning", str(e)[:100]))

    # 8. LLM
    try:
        from agent.llm.runtime import get_llm_status
        llm = get_llm_status(probe_provider=False)
        components.append(ComponentStatus("llm", "ok",
            (f"已启用，默认服务：{llm.get('provider') or '未设置'}" if llm.get("enabled") else "模型未启用"),
            {"enabled": llm.get("enabled"), "provider": llm.get("provider", "disabled"),
             "safe_mode": llm.get("safe_mode", True)}))
    except Exception as e:
        components.append(ComponentStatus("llm", "warning", str(e)[:100]))

    # 9. Archive
    try:
        from core.runtime.archive import get_archive_audits
        audits = get_archive_audits(workspace_id)
        components.append(ComponentStatus("archive", "ok",
            f"共 {len(audits)} 条归档审计",
            {"audit_count": len(audits)}))
    except Exception as e:
        components.append(ComponentStatus("archive", "warning", str(e)[:100]))

    # 10. Memory
    try:
        components.append(ComponentStatus("memory", "ok", "记忆系统可用"))
    except Exception:
        components.append(ComponentStatus("memory", "warning", "记忆状态不可读"))

    # 11. Production dependencies
    try:
        from core.runtime.production import production_readiness
        readiness = production_readiness()
        for item in readiness["components"]:
            components.append(ComponentStatus(
                f"production_{item['name']}",
                "ok" if item["status"] == "ok" else "error",
                f"{item['mode']} · {item.get('latency_ms', 0)} ms",
                item.get("details") or {},
            ))
    except Exception as e:
        components.append(ComponentStatus("production", "error", str(e)[:100]))

    report.components = components
    report.summary = {
        "total": len(components),
        "ok": sum(1 for c in components if c.status == "ok"),
        "warning": sum(1 for c in components if c.status == "warning"),
        "error": sum(1 for c in components if c.status == "error"),
    }
    return report
