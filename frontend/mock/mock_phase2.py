"""frontend-next mock：阶段 2–6 接口（全部合成数据，只在内存里）。

被 mock_server.py 调用：`handle(handler, method, path, parts, q, scenario)`，返回 True 表示已处理。
未实现的接口仍由 mock_server.py 返回 501（不假装成功）。

重要（与真实后端的字段差异，见交付说明「数据源问题」）：
- `/api/runtime/tasks*` 按基线后端 durable TaskState 形状返回，**不含** execution_outcome / unknown_outcome。
- 未知项只在 `/api/runtime/sessions/<sid>/task-state` 的 `task_state.task.unknowns` 里出现（与基线一致）。
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import struct
import threading
import time

NOW = "2026-11-09T06:00:00-08:00"
YESTERDAY = "2026-11-08T10:00:00-08:00"
LOCK = threading.RLock()
SHARED: dict = {}  # mock_server 注入 LEDGER / WORKSPACES（避免 __main__ 重复导入出两份数据）

PHASE2_SCENARIO_KEYS = {
    "turn": {"complete", "partial", "unknown", "mapping2", "error", "slow"},
    "jobs": {"data", "mapping1", "empty"},
    "admin": {"ok", "forbidden"},
    "conflict": {"none", "topology", "annotations", "approval", "memory"},
}


def _sid() -> str:
    return secrets.token_hex(6)


# ── 会话与消息 ──────────────────────────────────────────────
SESSIONS = {
    "ws-demo-1": [
        {"session_id": "s_unknown", "title": "整理周报并写入共享目录", "status": "active", "created_at": NOW, "updated_at": NOW, "metadata": {}},
        {"session_id": "s_mapping2", "title": "映射二样例：ok=true 但结果未知", "status": "active", "created_at": NOW, "updated_at": NOW, "metadata": {}},
        {"session_id": "s_partial", "title": "汇总三份资料（部分达成）", "status": "active", "created_at": YESTERDAY, "updated_at": YESTERDAY, "metadata": {}},
        {"session_id": "s_reconciled", "title": "已回读确认的写入", "status": "active", "created_at": YESTERDAY, "updated_at": YESTERDAY, "metadata": {}},
        {"session_id": "s_drawing", "title": "绑定了图纸的会话", "status": "active", "created_at": YESTERDAY, "updated_at": YESTERDAY, "metadata": {"topology_id": "topo_demo", "workbench_selection": {"extension_id": "network.operations", "skill_id": "drawing:topo_demo", "skill_name": "绑定图纸", "resource_ids": ["topo_demo"], "allow_edit": False}}},
        {"session_id": "s_archived", "title": "已归档的旧会话", "status": "archived", "created_at": "2026-10-01T09:00:00-07:00", "updated_at": "2026-10-01T09:00:00-07:00", "metadata": {}},
    ],
    "ws-demo-2": [],
}

def _assistant(content, outcome=None, unknown=None, ok=True, errors=None, crid="", stage_outputs=None, tool_calls=None, task_id=""):
    md = {"client_request_id": crid, "tool_calls": tool_calls or [], "stage_outputs": stage_outputs or []}
    if outcome:
        md["execution_outcome"] = outcome
    if unknown:
        md["unknown_outcome"] = unknown
    if task_id:
        md["task_id"] = task_id
    return {"message_id": "m_" + _sid(), "role": "assistant", "content": content, "ok": ok, "errors": errors or [], "metadata": md, "created_at": NOW}

STAGES = [{"stage": "plan", "title": "规划", "status": "done", "summary": "合成：拆成 2 步。"}, {"stage": "act", "title": "执行", "status": "done", "summary": "合成：调用 1 个写入工具。"}]
WRITE_CALL_UNKNOWN = {"call_id": "call_demo_1", "tool_id": "workspace.file.write", "status": "unknown", "summary": "写入 weekly.md", "result": {"ok": False, "error": "receipt_lost"}}

MESSAGES = {
    "s_unknown": [
        {"message_id": "m_u1", "role": "user", "content": "把本周周报整理后写入共享目录。", "created_at": NOW},
        _assistant("周报已整理；写入共享目录的回执丢失。", outcome="unknown", ok=False, errors=["receipt_lost"],
                   unknown={"tool_id": "workspace.file.write", "call_id": "call_demo_1", "execution_may_continue": True},
                   stage_outputs=STAGES, tool_calls=[WRITE_CALL_UNKNOWN], task_id="task_demo_unknown"),
    ],
    "s_mapping2": [
        {"message_id": "m_m1", "role": "user", "content": "更新配置文件。", "created_at": NOW},
        # 映射二：ok=true、无 errors、execution_outcome=unknown、job 未失败
        _assistant("已提交配置更新。", outcome="unknown", ok=True, errors=[],
                   unknown={"tool_id": "workspace.file.write", "call_id": "call_demo_3", "execution_may_continue": True},
                   stage_outputs=STAGES, tool_calls=[{"call_id": "call_demo_3", "tool_id": "workspace.file.write", "status": "unknown", "result": {"ok": True}}], task_id="task_demo_mapping2"),
    ],
    "s_partial": [
        {"message_id": "m_p1", "role": "user", "content": "汇总三份资料。", "created_at": YESTERDAY},
        _assistant("已汇总两份；第三份无法读取。", outcome="partial", stage_outputs=STAGES, task_id="task_demo_partial",
                   tool_calls=[{"call_id": "c1", "tool_id": "workspace.file.read", "status": "ok", "result": {"ok": True}}, {"call_id": "c2", "tool_id": "workspace.file.read", "status": "error", "result": {"ok": False, "error": "not_found"}}]),
    ],
    "s_reconciled": [
        {"message_id": "m_r1", "role": "user", "content": "写入一条记录。", "created_at": YESTERDAY},
        _assistant("写入已回读确认。", outcome="complete", unknown={"tool_id": "workspace.file.write", "call_id": "call_demo_2", "status": "reconciled"}, stage_outputs=STAGES, task_id="task_demo_reconciled"),
    ],
    "s_drawing": [], "s_archived": [],
}

SESSION_TASKS = {
    "s_unknown": {"task_id": "task_demo_unknown", "objective": "整理周报并写入共享目录", "status": "partial",
                  "unknowns": [{"kind": "unknown_outcome", "reason": "workspace.file.write 回执丢失", "operation_id": "op_demo_unknown_01"}],
                  "recovery_goals": [{"goal_id": "g1", "status": "done", "description": "整理周报"}, {"goal_id": "g2", "status": "unknown", "description": "写入共享目录"}]},
    "s_mapping2": {"task_id": "task_demo_mapping2", "objective": "更新配置文件", "status": "partial",
                   "unknowns": [{"kind": "unknown_outcome", "reason": "写入结果未确认"}], "recovery_goals": []},
    "s_partial": {"task_id": "task_demo_partial", "objective": "汇总三份资料", "status": "partial", "unknowns": [],
                  "recovery_goals": [{"goal_id": "g1", "status": "done", "description": "资料 A"}, {"goal_id": "g2", "status": "done", "description": "资料 B"}, {"goal_id": "g3", "status": "pending", "description": "资料 C"}]},
    "s_reconciled": {"task_id": "task_demo_reconciled", "objective": "写入一条记录", "status": "succeeded", "unknowns": [], "recovery_goals": []},
}

# durable TaskState（agent/runtime/durable/models.py:53-62 的字段；无 outcome 字段）
RUNTIME_TASKS = {
    "ws-demo-1": [
        {"task_id": "task_demo_unknown", "workspace_id": "ws-demo-1", "session_id": "s_unknown", "run_id": "run_demo_1", "job_id": "job_demo_failed_unknown", "trace_id": "tr1",
         "user_goal": "整理周报并写入共享目录", "status": "failed", "current_step_id": "st2",
         "steps": [{"step_id": "st1", "title": "整理周报", "status": "succeeded"}, {"step_id": "st2", "title": "写入共享目录", "status": "failed", "tool_id": "workspace.file.write"}],
         "pending_action_id": "", "warnings": [], "errors": ["receipt_lost"], "created_at": NOW, "updated_at": NOW},
        {"task_id": "task_demo_partial", "workspace_id": "ws-demo-1", "session_id": "s_partial", "run_id": "run_demo_2", "job_id": "", "trace_id": "tr2",
         "user_goal": "汇总三份资料", "status": "failed", "current_step_id": "st3",
         "steps": [{"step_id": "st1", "title": "读取 A", "status": "succeeded"}, {"step_id": "st2", "title": "读取 B", "status": "succeeded"}, {"step_id": "st3", "title": "读取 C", "status": "failed"}],
         "warnings": [], "errors": ["not_found"], "created_at": YESTERDAY, "updated_at": YESTERDAY},
        {"task_id": "task_demo_running", "workspace_id": "ws-demo-1", "session_id": "", "user_goal": "长任务（运行中）", "status": "running", "steps": [], "created_at": NOW, "updated_at": NOW},
    ],
    "ws-demo-2": [],
}

JOBS_BASE = {
    "ws-demo-1": [
        # 映射一：job failed + active_turn.unknown_outcome（WORKER_LEASE_EXPIRED）
        {"job_id": "job_demo_failed_unknown", "job_type": "agent_turn", "status": "failed", "error": "worker lease expired", "created_at": NOW,
         "payload": {"user_input": "把本周周报整理后写入共享目录。"},
         "result_summary": None,
         "metadata": {"active_turn": {"status": "running", "unknown_outcome": {"tool_id": "jobs.worker", "error_code": "WORKER_LEASE_EXPIRED", "execution_may_continue": True}}}},
        {"job_id": "job_demo_failed_plain", "job_type": "report", "status": "failed", "error": "template_missing", "created_at": YESTERDAY,
         "payload": {"report": "weekly", "format": "pdf"}, "result_summary": {"ok": False, "execution_outcome": "failed"}, "metadata": {}},
        {"job_id": "job_demo_queued", "job_type": "agent_turn", "status": "queued", "created_at": NOW, "payload": {"user_input": "排队中的请求"}, "metadata": {}},
        {"job_id": "job_demo_succeeded_partial", "job_type": "agent_turn", "status": "succeeded", "created_at": YESTERDAY,
         "result_summary": {"ok": True, "execution_outcome": "partial"}, "metadata": {}},
        {"job_id": "job_demo_cancel_req", "job_type": "agent_turn", "status": "cancel_requested", "created_at": NOW, "metadata": {}},
    ],
    "ws-demo-2": [],
}
JOBS = {k: [dict(j) for j in v] for k, v in JOBS_BASE.items()}

FILES = {"ws-demo-1": [
    {"file_id": "file_demo_1", "name": "weekly.md", "folder": "reports", "size_bytes": 2048, "mime_type": "text/markdown", "lifecycle": "active", "created_at": NOW, "logical_type": "document", "content": "# 周报（合成）\n- 完成 A\n- 进行中 B\n"},
    {"file_id": "file_demo_2", "name": "data.csv", "folder": "data", "size_bytes": 512, "mime_type": "text/csv", "lifecycle": "active", "created_at": YESTERDAY, "logical_type": "table", "content": "a,b\n1,2\n"},
    {"file_id": "file_demo_3", "name": "old.txt", "folder": "", "size_bytes": 10, "mime_type": "text/plain", "lifecycle": "trash", "created_at": YESTERDAY, "logical_type": "document", "content": "old"},
], "ws-demo-2": []}

KNOWLEDGE = {"ws-demo-1": [
    {"source_id": "ks_demo_1", "title": "产品手册（合成）", "status": "indexed", "chunk_count": 12, "updated_at": NOW},
    {"source_id": "ks_demo_2", "title": "FAQ（合成）", "status": "failed", "chunk_count": 0, "error": "parse_error", "updated_at": YESTERDAY},
], "ws-demo-2": []}

MEMORY = {"ws-demo-1": [
    {"memory_id": "mem_demo_1", "summary": "周报每周五 17:00 前提交", "content": "周报每周五 17:00 前提交", "status": "active", "scope": "workspace", "memory_type": "knowledge_note", "updated_at": NOW, "metadata": {}},
    {"memory_id": "mem_demo_2", "summary": "周报每周四提交", "content": "周报每周四提交", "status": "conflict", "scope": "workspace", "memory_type": "knowledge_note", "updated_at": NOW, "metadata": {"conflict_memory_ids": ["mem_demo_1"]}},
], "ws-demo-2": []}

APPROVAL_OPS = {
    "appr_demo_1": {"operation_id": "appr_demo_1", "status": "pending", "title": "下发配置（合成）", "target": {"device": {"name": "core-sw-01（合成）", "device_id": "dev_demo_1"}, "connection": {"connection_id": "conn_demo_1", "name": "core-sw-01 ssh（合成）"}},
                    "commands": ["interface Gi0/1", "description uplink"], "risk_level": "high", "created_at": NOW},
}

BACKUPS = [{"backup_id": "bk_demo_1", "created_at": YESTERDAY, "size_bytes": 1048576}]
USERS = [
    {"username": "demo", "role": "admin", "organization_id": "org-demo", "workspace_ids": ["ws-demo-1", "ws-demo-2"], "enabled": True},
    {"username": "alice", "role": "operator", "organization_id": "org-demo", "workspace_ids": ["ws-demo-2"], "home_workspace_id": "ws-demo-2", "enabled": True},
]
REPORTS = [
    {"artifact_id": "rep_demo_1", "artifact_type": "report", "title": "整理周报 · 运行报告（合成）", "run_id": "run_demo_1", "sensitivity": "internal", "lifecycle": "active",
     "created_at": YESTERDAY, "file_ext": ".md", "_content": "# 整理周报（合成）\n\n- 已汇总两份\n- 第三份写入结果未知，需核对\n"},
    {"artifact_id": "rep_demo_sensitive", "artifact_type": "report", "title": "敏感报告（合成）", "run_id": "run_demo_1", "sensitivity": "sensitive", "lifecycle": "active",
     "created_at": YESTERDAY, "file_ext": ".md", "_content": "# 敏感报告（合成）\n仅在声明 allow_sensitive=1 时可读。\n"},
    {"artifact_id": "rep_demo_secret", "artifact_type": "report", "title": "机密报告（合成）", "run_id": None, "sensitivity": "secret", "lifecycle": "active",
     "created_at": YESTERDAY, "file_ext": ".md", "_content": "不可读"},
]
ORGS = [{"organization_id": "org-demo", "name": "演示组织（合成）", "workspace_ids": ["ws-demo-1", "ws-demo-2"]}]
MEMBERSHIPS = [{"username": "alice", "organization_id": "org-demo", "role": "operator", "workspace_ids": ["ws-demo-2"]}]
PROVIDERS = [
    {"provider": "mock-llm", "label": "合成模型", "provider_type": "openai_compatible", "base_url": "http://127.0.0.1:0/mock", "model": "mock-1", "key_configured": False, "key_preview": None},
]
WORKFLOWS = {"ws-demo-1": [{"workflow_id": "wf_demo_1", "name": "周报流程（合成）", "steps": [{"id": "s1"}, {"id": "s2"}], "updated_at": NOW}], "ws-demo-2": []}
WORKFLOW_RUNS = {"wfr_demo_1": {"run_id": "wfr_demo_1", "workflow_id": "wf_demo_1", "status": "running", "task_id": "task_demo_running", "steps": [{"step_id": "s1", "status": "succeeded"}, {"step_id": "s2", "status": "running"}], "created_at": NOW}}
TEMPLATES = [{"template_id": "tpl_weekly", "name": "周报模板（合成）", "description": "两步：整理 + 写入"}]

NET = {
    "devices": [{"device_id": "dev_demo_1", "name": "core-sw-01（合成）", "vendor": "synthetic", "region_id": "r1"}],
    "connections": [{"connection_id": "conn_demo_1", "name": "core-sw-01 ssh（合成）", "device_id": "dev_demo_1", "host": "192.0.2.10", "port": 22, "protocol": "ssh", "host_key_fingerprint": ""},
                    {"connection_id": "conn_demo_2", "name": "edge-rt-01 ssh（合成）", "device_id": "dev_demo_1", "host": "192.0.2.11", "port": 22, "protocol": "ssh", "host_key_fingerprint": "SHA256:synthetic-ok"}],
    "skills": [{"skill_id": "skill_demo_1", "name": "查看接口状态（合成）", "enabled": False, "steps": [{"command": "show interfaces"}]}],
    "scripts": [{"script_id": "script_demo_1", "name": "基础巡检（合成）", "commands": ["show version", "show interfaces"]}],
    "inspections": [
        {"task_id": "insp_demo_partial", "status": "partial", "connection_ids": ["conn_demo_1", "conn_demo_2"], "created_at": NOW, "updated_at": NOW,
         "results": {"conn_demo_1": {"status": "succeeded", "name": "core-sw-01"}, "conn_demo_2": {"status": "failed", "name": "edge-rt-01", "error": "timeout"}}},
        {"task_id": "insp_demo_unknown", "status": "unknown", "connection_ids": ["conn_demo_1"], "created_at": NOW, "updated_at": NOW, "results": {}},
    ],
    # 与旧画布读写同形（nodes / links / groups / canvas_items / version），合成数据
    "topologies": [{"topology_id": "topo_demo", "name": "演示拓扑（合成）", "description": "", "version": 3, "created_at": YESTERDAY, "updated_at": NOW,
                    "nodes": [{"node_id": "n1", "display_name": "core（合成）", "device_type": "switch", "x": 80, "y": 80},
                              {"node_id": "n2", "display_name": "edge（合成）", "device_type": "router", "x": 260, "y": 80},
                              {"node_id": "n3", "display_name": "access（合成）", "device_type": "switch", "x": 170, "y": 200}],
                    "links": [{"link_id": "l1", "source": "n1", "target": "n2"}, {"link_id": "l2", "source": "n1", "target": "n3"}],
                    "groups": [], "canvas_items": []}],
    "annotations": {"topo_demo": {"version": 1, "items": [{"node_id": "n1", "text": "核心"}]}},
    "revisions": {"topo_demo": [{"revision_id": "rev_2", "version": 2, "created_at": YESTERDAY}, {"revision_id": "rev_1", "version": 1, "created_at": YESTERDAY}]},
    "observations": [{"observation_id": "obs_demo_1", "summary": "Gi0/1 down（合成）", "status": "observed", "observed_at": NOW}],
}


def _ws(q, body=None):
    return (q.get("workspace_id") or (body or {}).get("workspace_id") or "")


def _find(lst, key, val):
    return next((x for x in lst if x.get(key) == val), None)


# ── WebSocket（/ws/agent）：最小 RFC6455 实现，只用于本地 mock ───────────────
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
TURN_BUFFERS: dict[str, dict] = {}  # client_request_id -> {"frames": [...], "done": bool}


def ws_handshake(handler) -> bool:
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key or (handler.headers.get("Upgrade") or "").lower() != "websocket":
        return False
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept)
    handler.end_headers()
    return True


def _ws_send(handler, obj):
    data = json.dumps(obj, ensure_ascii=False).encode()
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126); header += struct.pack(">H", n)
    else:
        header.append(127); header += struct.pack(">Q", n)
    handler.wfile.write(bytes(header) + data)
    handler.wfile.flush()


def _ws_recv(handler):
    r = handler.rfile
    h = r.read(2)
    if len(h) < 2:
        return None
    opcode = h[0] & 0x0F
    masked = h[1] & 0x80
    n = h[1] & 0x7F
    if n == 126:
        n = struct.unpack(">H", r.read(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", r.read(8))[0]
    mask = r.read(4) if masked else b"\x00\x00\x00\x00"
    payload = bytearray(r.read(n))
    for i in range(len(payload)):
        payload[i] ^= mask[i % 4]
    if opcode == 0x8:
        return None
    if opcode == 0x9:  # ping
        return {"type": "_ping"}
    try:
        return json.loads(payload.decode())
    except Exception:
        return {}


def _turn_frames(scenario, ws, session_id, crid, text, metadata):
    kind = scenario.get("turn", "complete")
    job_id = "job_turn_" + _sid()
    frames = [{"type": "event", "name": "turn_accepted", "data": {"job_id": job_id, "client_request_id": crid}},
              {"type": "event", "name": "model_started", "data": {"job_id": job_id}}]
    reply = {"complete": "（合成）已完成你的请求。", "partial": "（合成）完成了一部分，还有目标待处理。", "unknown": "（合成）写入的回执丢失。",
             "mapping2": "（合成）已提交写入。", "error": "", "slow": "（合成）这是一条慢回复，可以点停止。"}[kind]
    tool = {"call_id": "call_" + _sid(), "tool_id": "workspace.file.write", "status": "unknown" if kind in {"unknown", "mapping2"} else "ok",
            "result": {"ok": kind != "unknown"}}
    if kind != "error":
        frames.append({"type": "event", "name": "tool_call", "data": {"job_id": job_id, "tool_id": tool["tool_id"]}})
    seq = 0
    for ch in [reply[i:i + 6] for i in range(0, len(reply), 6)]:
        seq += 1
        frames.append({"type": "token", "content": ch, "seq": seq})
    if kind == "error":
        frames.append({"type": "error", "message": "合成错误：模型不可用"})
        return job_id, frames
    md = {"client_request_id": crid, "tool_calls": [tool], "stage_outputs": STAGES, "task_id": f"task_{session_id}"}
    if metadata.get("resume_task_id"):
        md["resumed_task_id"] = metadata["resume_task_id"]
    ok, errors = True, []
    if kind == "complete":
        md["execution_outcome"] = "complete"
    elif kind == "partial":
        md["execution_outcome"] = "partial"
    elif kind == "unknown":
        md["execution_outcome"] = "unknown"; md["unknown_outcome"] = {"tool_id": tool["tool_id"], "call_id": tool["call_id"], "execution_may_continue": True}; ok = False; errors = ["receipt_lost"]
    elif kind == "mapping2":
        md["execution_outcome"] = "unknown"; md["unknown_outcome"] = {"tool_id": tool["tool_id"], "call_id": tool["call_id"], "execution_may_continue": True}
    elif kind == "slow":
        md["execution_outcome"] = "complete"
    frames.append({"type": "done", "final_response": reply, "session_id": session_id, "turn_id": "turn_" + _sid(), "tool_calls": [tool], "metadata": md, "errors": errors, "ok": ok})
    return job_id, frames


CANCELLED_JOBS: set[str] = set()


def ws_loop(handler, scenario):
    while True:
        msg = _ws_recv(handler)
        if msg is None:
            return
        t = msg.get("type")
        if t == "_ping" or t == "ping":
            _ws_send(handler, {"type": "pong"}); continue
        if t == "resume":
            crid = str(msg.get("client_request_id") or "")
            cursor = int(msg.get("stream_seq") or 0)
            buf = TURN_BUFFERS.get(crid)
            if not buf:
                _ws_send(handler, {"type": "error", "message": "resume_not_found"}); continue
            # 只续传游标之后的帧（传输日志语义）；不重新执行回合。
            frames = buf["frames"]
            start = 0
            for i, f in enumerate(frames):
                if f.get("type") == "token" and int(f.get("seq") or 0) <= cursor:
                    start = i + 1
            for f in frames[start:]:
                _ws_send(handler, f)
            continue
        if t != "message":
            continue
        ws = str(msg.get("workspace_id") or ""); sid = str(msg.get("session_id") or "")
        md = msg.get("metadata") or {}
        crid = str(md.get("client_request_id") or _sid())
        text = str(msg.get("user_input") or "")
        job_id, frames = _turn_frames(scenario, ws, sid, crid, text, md)
        TURN_BUFFERS[crid] = {"frames": frames, "done": False}
        with LOCK:
            MESSAGES.setdefault(sid, []).append({"message_id": "m_" + _sid(), "role": "user", "content": text, "created_at": NOW, "metadata": {"client_request_id": crid}})
            JOBS.setdefault(ws, []).insert(0, {"job_id": job_id, "job_type": "agent_turn", "status": "running", "created_at": NOW, "payload": {"user_input": text}, "metadata": {}})
        delay = 0.6 if scenario.get("turn") == "slow" else 0.03
        for f in frames:
            if job_id in CANCELLED_JOBS and f.get("type") in {"token", "done"}:
                done = {"type": "done", "final_response": "（已按请求停止）", "session_id": sid, "metadata": {"client_request_id": crid, "cancelled": True, "execution_outcome": "partial"}, "errors": [], "ok": True}
                _store_done(ws, sid, crid, done, job_id, "cancelled")
                _ws_send(handler, done)
                break
            _ws_send(handler, f)
            if f.get("type") == "done":
                _store_done(ws, sid, crid, f, job_id, "succeeded")
            if f.get("type") == "error":
                _store_job(ws, job_id, "failed")
            time.sleep(delay)
        TURN_BUFFERS[crid]["done"] = True


def _store_job(ws, job_id, status):
    with LOCK:
        j = _find(JOBS.get(ws, []), "job_id", job_id)
        if j:
            j["status"] = status


def _store_done(ws, sid, crid, frame, job_id, status):
    with LOCK:
        md = dict(frame.get("metadata") or {})
        md["client_request_id"] = crid
        MESSAGES.setdefault(sid, []).append({"message_id": "m_" + _sid(), "role": "assistant", "content": frame.get("final_response", ""), "ok": frame.get("ok", True), "errors": frame.get("errors", []), "metadata": md, "created_at": NOW})
        _store_job(ws, job_id, status)


# ── HTTP 路由 ─────────────────────────────────────────────
def handle(h, method, path, parts, q, sc):  # noqa: C901
    J = h._json
    b = h._body() if method in {"POST", "PUT", "PATCH", "DELETE"} else {}
    ws = _ws(q, b)

    def forbidden_admin():
        if sc.get("admin") == "forbidden":
            J(403, {"ok": False, "error": "forbidden"}); return True
        return False

    # agent status / llm
    if path == "/api/agent/status":
        return J(200, {"ok": True, "status": "ready", "mock": True}) or True
    if path == "/api/agent/llm/status":
        return J(200, {"ok": True, "status": "可用（合成）", "provider": "mock-llm"}) or True
    if path == "/api/agent/llm/providers" and method == "GET":
        return J(200, {"ok": True, "providers": PROVIDERS, "active": "mock-llm", "templates": []}) or True
    if path == "/api/agent/llm/providers" and method == "POST":
        if forbidden_admin(): return True
        p = {k: b.get(k) for k in ("provider", "label", "provider_type", "base_url", "model")}
        p.update({"key_configured": bool(b.get("api_key")), "key_preview": None}); PROVIDERS.append(p)
        return J(201, {"ok": True, "config": p}) or True
    if path.startswith("/api/agent/llm/providers/"):
        pid = parts[5]; p = _find(PROVIDERS, "provider", pid)
        if not p: return J(404, {"ok": False, "error": f"unknown provider: {pid}"}) or True
        if method == "DELETE":
            PROVIDERS.remove(p); return J(200, {"ok": True, "deleted": True}) or True
        if method == "POST":
            p.update({k: v for k, v in b.items() if k in ("label", "provider_type", "base_url", "model")})
            if b.get("api_key"): p["key_configured"] = True
            return J(200, {"ok": True, "config": p}) or True
        return J(200, {"ok": True, "config": p}) or True
    if path == "/api/agent/llm/activate":
        return J(200, {"ok": True, "active": b.get("provider")}) or True
    if path == "/api/agent/llm/test":
        return J(200, {"ok": True, "reply": "pong（合成）"}) or True
    if path == "/api/agent/usage":
        return J(200, {"ok": True, "usage": {"turns": 12, "tokens": 34567, "note": "合成"}}) or True

    # sessions
    if path == "/api/sessions" and method == "GET":
        status = q.get("status", "active")
        lst = [s for s in SESSIONS.get(ws, []) if s["status"] == status]
        if sc.get("inbox") == "empty":
            lst = []
        return J(200, {"ok": True, "sessions": lst[: int(q.get("limit", 200))]}) or True
    if path == "/api/sessions" and method == "POST":
        s = {"session_id": "s_" + _sid(), "title": b.get("title") or "", "status": "active", "created_at": NOW, "updated_at": NOW, "metadata": b.get("metadata") or {}}
        SESSIONS.setdefault(ws, []).insert(0, s); MESSAGES[s["session_id"]] = []
        return J(201, {"ok": True, "session": s}) or True
    if len(parts) >= 4 and parts[2] == "sessions":
        sid = parts[3]; s = _find(SESSIONS.get(ws, []), "session_id", sid)
        if not s: return J(404, {"ok": False, "error": "session_not_found"}) or True
        if len(parts) == 4 and method == "GET": return J(200, {"ok": True, "session": s}) or True
        if len(parts) == 4 and method == "PUT":
            if "title" in b: s["title"] = str(b["title"])
            return J(200, {"ok": True, "session": s}) or True
        if len(parts) == 4 and method == "DELETE":
            SESSIONS[ws].remove(s); return J(200, {"ok": True, "deleted": True}) or True
        if len(parts) == 5 and parts[4] == "archive": s["status"] = "archived"; return J(200, {"ok": True, "session": s}) or True
        if len(parts) == 5 and parts[4] == "restore": s["status"] = "active"; return J(200, {"ok": True, "session": s}) or True
        if len(parts) == 5 and parts[4] == "messages": return J(200, {"ok": True, "messages": MESSAGES.get(sid, [])}) or True

    # runtime
    if len(parts) == 6 and parts[2] == "runtime" and parts[3] == "sessions" and parts[5] == "task-state":
        t = SESSION_TASKS.get(parts[4])
        return J(200, {"ok": True, "task_state": {"task": t} if t else None}) or True
    if path == "/api/runtime/tasks" and method == "GET":
        lst = [] if sc.get("inbox") == "empty" else RUNTIME_TASKS.get(ws, [])
        return J(200, {"ok": True, "tasks": lst, "count": len(lst)}) or True
    if len(parts) >= 5 and parts[2] == "runtime" and parts[3] == "tasks":
        t = _find(RUNTIME_TASKS.get(ws, []), "task_id", parts[4])
        if not t: return J(404, {"ok": False, "error": "task not found"}) or True
        tail = parts[5:] if len(parts) > 5 else []
        if not tail: return J(200, {"ok": True, "task": t}) or True
        if tail == ["events"]: return J(200, {"ok": True, "events": [{"type": "step_started", "step_id": "st1", "at": NOW}, {"type": "step_failed", "step_id": "st2", "at": NOW}]}) or True
        if tail == ["checkpoints"]: return J(200, {"ok": True, "checkpoints": [{"checkpoint_id": "cp1", "reason": "auto", "created_at": NOW}]}) or True
        if tail == ["checkpoint"] and method == "POST": return J(200, {"ok": True, "checkpoint": {"checkpoint_id": "cp_" + _sid()}}) or True
        if tail == ["cancel"]: t["status"] = "interrupting"; return J(200, {"ok": True, "status": "interrupting"}) or True
        if tail == ["resume"]: return J(200, {"ok": True, "status": "queued"}) or True
        if len(tail) == 3 and tail[0] == "steps" and tail[2] == "retry": return J(200, {"ok": True, "status": "queued"}) or True
        if tail == ["audit-report"]:
            return J(200, {"ok": True, "report": {"summary": "合成审计报告", "task_id": t["task_id"]}}) or True
    if path == "/api/runtime/trajectories":
        return J(200, {"ok": True, "trajectories": [{"trajectory_id": "traj_demo_1", "task_id": "task_demo_unknown", "created_at": NOW}]}) or True
    if path.startswith("/api/runtime/trajectories/"):
        return J(200, {"ok": True, "trajectory": {"trajectory_id": parts[4], "steps": [{"tool_id": "workspace.file.write", "status": "unknown"}]}}) or True
    if path == "/api/runtime/health":
        return J(200, {"ok": True, "status": "healthy（合成）", "components": {"jobs": "ok", "storage": "ok"}}) or True
    if path == "/api/runtime/summary":
        return J(200, {"ok": True, "tasks": len(RUNTIME_TASKS.get(ws, [])), "jobs": len(JOBS.get(ws, []))}) or True
    if path == "/api/runtime/selfcheck":
        return J(200, {"ok": True, "checks": [{"name": "storage", "ok": True}]}) or True

    # jobs
    if path == "/api/jobs" and method == "GET":
        if sc.get("jobs") == "empty": return J(200, {"ok": True, "jobs": []}) or True
        lst = JOBS.get(ws, [])
        if sc.get("jobs") == "mapping1": lst = [j for j in lst if j["job_id"] == "job_demo_failed_unknown"]
        return J(200, {"ok": True, "jobs": lst}) or True
    if path == "/api/jobs/batch-delete" and method == "DELETE":
        ids = sorted(b.get("job_ids") or [])
        if b.get("confirmation") != "DELETE JOBS " + ",".join(ids): return J(400, {"ok": False, "error": "job_batch_delete_confirmation_required"}) or True
        JOBS[ws] = [j for j in JOBS.get(ws, []) if j["job_id"] not in ids]
        return J(200, {"ok": True, "deleted": True, "job_ids": ids}) or True
    if path == "/api/jobs/worker/status":
        if forbidden_admin(): return True
        return J(200, {"ok": True, "worker": {"running": False, "note": "合成"}}) or True
    if path == "/api/jobs/worker/run-once":
        if forbidden_admin(): return True
        return J(200, {"ok": True, "processed": 0}) or True
    if len(parts) >= 4 and parts[2] == "jobs":
        jid = parts[3]; j = _find(JOBS.get(ws, []), "job_id", jid)
        if not j: return J(404, {"ok": False, "error": "job_not_found"}) or True
        if len(parts) == 4 and method == "DELETE":
            if b.get("confirmation") != f"DELETE {jid}": return J(400, {"ok": False, "error": "job_delete_confirmation_required"}) or True
            JOBS[ws].remove(j); return J(200, {"ok": True, "deleted": True}) or True
        if len(parts) == 4: return J(200, {"ok": True, "job": j}) or True
        if parts[4] == "cancel":
            CANCELLED_JOBS.add(jid)
            if j["status"] in {"queued", "running"}: j["status"] = "cancel_requested"
            return J(200, {"ok": True, "status": j["status"]}) or True
        if parts[4] == "retry":
            if (j.get("metadata") or {}).get("active_turn", {}).get("unknown_outcome"):
                return J(409, {"ok": False, "error": "unknown_outcome_requires_verification"}) or True
            j["status"] = "queued"; return J(202, {"ok": True, "queued": True, "job": j}) or True

    # runs / reports (A7)
    if len(parts) >= 5 and parts[2] == "workspaces" and parts[4] == "runs":
        if len(parts) == 5: return J(200, {"ok": True, "runs": [{"run_id": "run_demo_1", "status": "failed", "title": "整理周报", "created_at": NOW}]}) or True
        if len(parts) == 6: return J(200, {"ok": True, "run": {"run_id": parts[5], "status": "failed"}}) or True
        if parts[6] == "trace": return J(200, {"ok": True, "trace": [{"span": "model", "ms": 1200}, {"span": "workspace.file.write", "status": "unknown"}]}) or True
        # 基线 /runs/<id>/report 只有 POST（创建）；GET 与 Flask 一致返回 405。
        if parts[6] == "report" and method != "POST": return J(405, {"ok": False, "error": "method_not_allowed", "message": "该路径只有 POST（创建报告），阅读请用 /reports 与 /reports/<id>/content"}) or True
        if parts[6] == "report":
            rec = {"artifact_id": "rep_" + _sid(), "artifact_type": "report", "title": b.get("title") or "Run report", "run_id": parts[5], "sensitivity": "internal",
                   "lifecycle": "active", "created_at": NOW, "file_ext": ".md", "_content": "# " + (b.get("title") or "Run report") + "\n\n（合成报告正文）\n"}
            REPORTS.insert(0, rec)
            return J(200, {"ok": True, "status": "accepted", "artifact_id": rec["artifact_id"]}) or True
        if parts[6] == "artifacts": return J(200, {"ok": True, "artifacts": []}) or True
    if path == "/api/runs/recent": return J(200, {"ok": True, "runs": [{"run_id": "run_demo_1"}]}) or True
    if path == "/api/reports/create": return J(202, {"ok": True, "queued": True, "report_id": "rep_" + _sid()}) or True
    # 报告阅读（A7，基线 workspace_routes.py:489-505）：列表 {reports}；正文 {ok, content}，机密 / 已删除 / 敏感未声明 → 403
    if len(parts) == 5 and parts[2] == "workspaces" and parts[4] == "reports" and method == "GET":
        return J(200, {"reports": [{k: v for k, v in r.items() if not k.startswith("_")} for r in REPORTS if r["lifecycle"] != "deleted"]}) or True
    if len(parts) == 7 and parts[2] == "workspaces" and parts[4] == "reports" and parts[6] == "content" and method == "GET":
        r = _find(REPORTS, "artifact_id", parts[5])
        allow = q.get("allow_sensitive") == "1"
        if not r or r["sensitivity"] == "secret" or r["lifecycle"] == "deleted" or (r["sensitivity"] == "sensitive" and not allow):
            return J(403, {"ok": False, "error": "content not accessible"}) or True
        return J(200, {"ok": True, "content": r["_content"]}) or True

    # tools catalog / dry-run
    if path == "/api/tools/catalog":
        return J(200, {"ok": True, "tools": [{"tool_id": "workspace.file.write", "name": "写入文件", "description": "写入工作区文件（合成目录）", "side_effects": "workspace_write"},
                                              {"tool_id": "workspace.file.read", "name": "读取文件", "description": "只读", "side_effects": "none"}]}) or True
    if path == "/api/tools/dry-run":
        return J(200, {"ok": True, "dry_run": True, "executed": False, "plan": {"tool_id": b.get("tool_id"), "would_call_with": b.get("arguments") or {}}}) or True
    if path == "/api/workbench/skills":
        return J(200, {"ok": True, "skills": [{"extension_id": "demo.notes", "skill_id": "skill_summarize", "name": "资料汇总（合成）", "resources": [{"resource_id": "board-demo", "name": "演示看板（合成）"}], "selection_mode": "single"}]}) or True

    # storage
    if path == "/api/storage/files" and method == "GET":
        lc = q.get("lifecycle", "active"); qq = q.get("q", "")
        lst = [dict({k: v for k, v in f.items() if k != "content"}) for f in FILES.get(ws, []) if f["lifecycle"] == lc and qq.lower() in f["name"].lower()]
        return J(200, {"ok": True, "files": lst}) or True
    if len(parts) >= 5 and parts[2] == "storage" and parts[3] == "files":
        f = _find(FILES.get(ws, []), "file_id", parts[4])
        if not f: return J(404, {"ok": False, "error": "file_not_found"}) or True
        tail = parts[5] if len(parts) > 5 else ""
        if not tail and method == "GET": return J(200, {"ok": True, "record": {k: v for k, v in f.items() if k != "content"}}) or True
        if not tail and method == "PATCH":
            if b.get("name"): f["name"] = b["name"]
            if "folder" in b: f["folder"] = b["folder"]
            return J(200, {"ok": True, "record": {k: v for k, v in f.items() if k != "content"}}) or True
        if not tail and method == "DELETE":
            if q.get("confirm") != "true": return J(400, {"ok": False, "error": "confirm_required"}) or True
            f["lifecycle"] = "trash"; return J(200, {"ok": True}) or True
        if tail == "restore": f["lifecycle"] = "active"; return J(200, {"ok": True}) or True
        if tail == "content": return J(200, {"ok": True, "content": f.get("content", "")}) or True
        if tail == "inspect": return J(200, {"ok": True, "rows": 2, "columns": ["a", "b"], "note": "合成检查结果"}) or True
        if tail == "download": return J(501, {"ok": False, "error": "not_implemented_in_mock", "message": "mock 不提供文件下载"}) or True
    if path == "/api/storage/health": return J(200, {"ok": True, "health": {"missing": 0, "orphans": 1, "note": "合成"}}) or True
    if path in {"/api/storage/reconcile", "/api/storage/migration"}:
        return J(200, {"ok": True, "applied": b.get("apply") is True, "changes": [{"file_id": "file_demo_2", "action": "relink"}]}) or True
    if path == "/api/storage/sources":
        fp = q.get("filepath", "files/data")
        if fp == "files/data": return J(200, {"ok": True, "entries": [{"name": "reports", "path": "files/data/reports", "is_dir": True}, {"name": "data.csv", "path": "files/data/data.csv"}]}) or True
        return J(200, {"ok": True, "entries": [{"name": "weekly.md", "path": fp + "/weekly.md"}]}) or True
    if path == "/api/storage/sources/content": return J(200, {"ok": True, "content": "（合成）" + q.get("filepath", "")}) or True

    # knowledge
    if path == "/api/knowledge/sources" and method == "GET": return J(200, {"ok": True, "sources": KNOWLEDGE.get(ws, [])}) or True
    if path == "/api/knowledge/search":
        return J(200, {"ok": True, "results": [{"chunk_id": "ch1", "source_id": "ks_demo_1", "text": f"（合成）与「{q.get('q', '')}」相关的片段", "score": 0.8}]}) or True
    if path == "/api/knowledge/sources/from-artifact":
        s = {"source_id": "ks_" + _sid(), "title": "来自产出", "status": "pending"}; KNOWLEDGE.setdefault(ws, []).append(s)
        return J(200, {"ok": True, "source": s}) or True
    if path == "/api/knowledge/upload": return J(501, {"ok": False, "error": "not_implemented_in_mock", "message": "mock 不接收文件上传"}) or True
    if len(parts) >= 5 and parts[2] == "knowledge" and parts[3] == "sources":
        s = _find(KNOWLEDGE.get(ws, []), "source_id", parts[4])
        if not s: return J(404, {"ok": False, "error": "source_not_found"}) or True
        if len(parts) == 6 and parts[5] == "reindex":
            s["status"] = "indexing"  # 受理 ≠ 成功：回读会看到 indexing
            return J(202, {"ok": True, "accepted": True}) or True
        if method == "DELETE": KNOWLEDGE[ws].remove(s); return J(200, {"ok": True, "deleted": True}) or True
        return J(200, {"ok": True, "source": s}) or True

    # memory
    if path == "/api/memory/list": return J(200, {"ok": True, "records": MEMORY.get(ws, [])}) or True
    if path == "/api/memory/write":
        mid = str(b.get("memory_id") or ("mem_" + _sid()))
        if sc.get("conflict") == "memory":
            return J(409, {"ok": False, "status": "execution_unknown", "memory_id": mid, "error": "memory_write_unknown_readback_required"}) or True
        existing = _find(MEMORY.setdefault(ws, []), "memory_id", mid)
        if existing: return J(200, {"ok": True, "status": existing["status"], "memory_id": mid, "reconciled": True}) or True
        rec = {"memory_id": mid, "summary": b.get("title", ""), "content": b.get("content", ""), "status": "active", "scope": "workspace", "updated_at": NOW, "metadata": {}}
        MEMORY[ws].append(rec); return J(200, {"ok": True, "status": "active", "memory_id": mid}) or True
    if path == "/api/memory/confirm":
        m = _find(MEMORY.get(ws, []), "memory_id", b.get("memory_id"))
        if not m: return J(404, {"ok": False, "error": "memory_not_found"}) or True
        m["status"] = "active"; return J(200, {"ok": True}) or True
    if path == "/api/memory/batch-delete":
        if b.get("confirm") is not True: return J(400, {"ok": False, "error": "confirm_required"}) or True
        ids = set(b.get("memory_ids") or []); before = len(MEMORY.get(ws, []))
        MEMORY[ws] = [m for m in MEMORY.get(ws, []) if m["memory_id"] not in ids]
        return J(200, {"ok": True, "deleted_count": before - len(MEMORY[ws]), "requested": len(ids)}) or True
    if len(parts) == 4 and parts[2] == "memory" and method == "GET":
        m = _find(MEMORY.get(ws, []), "memory_id", parts[3])
        return (J(200, {"ok": True, "record": m}) if m else J(404, {"ok": False, "error": "memory_not_found"})) or True

    # approval extension
    if len(parts) >= 6 and parts[2] == "extensions" and parts[3] == "approval" and parts[4] == "operations":
        op = APPROVAL_OPS.get(parts[5])
        if not op: return J(404, {"ok": False, "error": "operation_not_found"}) or True
        if len(parts) == 7 and parts[6] == "decision":
            if sc.get("conflict") == "approval":
                op["status"] = "invalidated"; op["invalidated_reason"] = "设备配置已被其他会话修改（合成）"
                return J(409, {"ok": False, "error": "operation_invalidated", "operation": op}) or True
            op["status"] = "approved" if b.get("decision") == "approve" else "rejected"
            return J(200, {"ok": True, "operation": op}) or True
        return J(200, {"ok": True, "operation": op}) or True

    # ledger resolve
    if len(parts) == 6 and parts[2] == "admin" and parts[3] == "operation-ledger" and parts[5] == "resolve":
        op = _find(SHARED["LEDGER"].get(ws, []), "operation_id", parts[4])
        if not op: return J(404, {"ok": False, "error": "operation_not_found"}) or True
        if b.get("confirmation") != f"RESOLVE {parts[4]}" or not str(b.get("reason") or "").strip():
            return J(400, {"ok": False, "error": "resolve_confirmation_required"}) or True
        op["status"] = b.get("status"); op["resolution_reason"] = b.get("reason")
        return J(200, {"ok": True, "operation": op}) or True

    # admin: backups / production
    if path.startswith("/api/admin/backups") or path == "/api/admin/production":
        if forbidden_admin(): return True
        if path == "/api/admin/production": return J(200, {"ok": True, "checks": [{"name": "backups", "ok": True}], "note": "合成"}) or True
        if path == "/api/admin/backups" and method == "GET": return J(200, {"ok": True, "backups": BACKUPS}) or True
        if path == "/api/admin/backups" and method == "POST":
            bk = {"backup_id": "bk_" + _sid(), "created_at": NOW}; BACKUPS.insert(0, bk); return J(201, {"ok": True, "backup": bk}) or True
        if path == "/api/admin/backups/prune": return J(200, {"ok": True, "removed": []}) or True
        if parts[-1] == "restore":
            if b.get("confirmation") != "RESTORE": return J(409, {"ok": False, "error": "restore confirmation is required"}) or True
            return J(200, {"ok": True, "restored": parts[4], "note": "合成：不会真的恢复"}) or True

    # identity
    if path == "/api/identity/users" and method == "GET":
        if forbidden_admin(): return True
        return J(200, {"ok": True, "users": USERS}) or True
    if path.startswith("/api/identity/users/"):
        u = _find(USERS, "username", parts[4])
        if not u: return J(404, {"ok": False, "error": "user_not_found"}) or True
        if method == "DELETE": USERS.remove(u); return J(200, {"ok": True}) or True
        if b.get("role") not in {"viewer", "operator", "developer"}: return J(400, {"ok": False, "error": "ordinary_user_role_required"}) or True
        if not b.get("workspace_ids"): return J(400, {"ok": False, "error": "workspace_ids_required"}) or True
        u.update({"role": b["role"], "organization_id": b.get("organization_id") or "default", "workspace_ids": b["workspace_ids"], "enabled": b.get("enabled", True) is not False})
        return J(200, {"ok": True, "user": u}) or True
    # 组织与成员：与 backend/api/identity_routes.py:163-205、core/identity.py 同语义（合成数据）
    if path == "/api/identity/organizations":
        if forbidden_admin(): return True
        if method == "POST":
            oid = str(b.get("organization_id") or "").strip(); name = str(b.get("name") or "").strip()
            if not oid or not name: return J(400, {"ok": False, "error": "organization name is required"}) or True
            if _find(ORGS, "organization_id", oid): return J(400, {"ok": False, "error": "organization already exists"}) or True
            rec = {"organization_id": oid, "name": name[:120], "workspace_ids": []}
            ORGS.append(rec); return J(201, {"ok": True, "organization": rec}) or True
        return J(200, {"ok": True, "organizations": ORGS}) or True
    if len(parts) == 6 and parts[1:4] == ["api", "identity", "organizations"] and parts[5] == "memberships":
        if forbidden_admin(): return True
        org = _find(ORGS, "organization_id", parts[4])
        if method == "GET":
            if not org: return J(400, {"ok": False, "error": "organization not found"}) or True
            return J(200, {"ok": True, "memberships": [m for m in MEMBERSHIPS if m["organization_id"] == parts[4]]}) or True
        role = str(b.get("role") or "viewer")
        if role not in {"viewer", "operator", "developer"}: return J(400, {"ok": False, "error": "ordinary_user_role_required"}) or True
        username = str(b.get("username") or "").strip()
        if not org: return J(400, {"ok": False, "error": "organization not found"}) or True
        user = _find(USERS, "username", username)
        if not user: return J(400, {"ok": False, "error": "user not found"}) or True
        allowed = sorted(set(b.get("workspace_ids") or []))
        if not set(allowed).issubset(set(org.get("workspace_ids") or [])): return J(400, {"ok": False, "error": "workspace is not assigned to the organization"}) or True
        MEMBERSHIPS[:] = [m for m in MEMBERSHIPS if not (m["username"] == username and m["organization_id"] == org["organization_id"])]
        rec = {"username": username, "organization_id": org["organization_id"], "role": role, "workspace_ids": allowed}
        MEMBERSHIPS.append(rec)
        user.update({"organization_id": org["organization_id"], "role": role, "workspace_ids": allowed})
        return J(201, {"ok": True, "membership": rec}) or True

    # workspaces admin
    WORKSPACES = SHARED["WORKSPACES"]
    if path == "/api/workspaces" and method == "POST":
        wid = str(b.get("workspace_id") or "")
        if not wid: return J(400, {"ok": False, "error": "workspace_id required"}) or True
        WORKSPACES.append({"workspace_id": wid, "name": wid}); return J(200, {"ok": True, "workspace": {"workspace_id": wid}}) or True
    if path == "/api/workspaces/batch-delete":
        if b.get("confirm") is not True: return J(400, {"ok": False, "error": "confirm_required"}) or True
        ids = set(b.get("workspace_ids") or []); WORKSPACES[:] = [w for w in WORKSPACES if w["workspace_id"] not in ids]
        return J(200, {"ok": True, "deleted": sorted(ids)}) or True
    if len(parts) >= 4 and parts[2] == "workspaces":
        wid = parts[3]
        if len(parts) == 4 and method == "DELETE":
            if not (b.get("confirm") is True or q.get("confirm") == "true"): return J(400, {"ok": False, "error": "confirm_required"}) or True
            WORKSPACES[:] = [w for w in WORKSPACES if w["workspace_id"] != wid]; return J(200, {"ok": True}) or True
        tail = parts[4:] if len(parts) > 4 else []
        if tail == ["rename"]:
            w = _find(WORKSPACES, "workspace_id", wid)
            if w: w["workspace_id"] = b.get("new_workspace_id") or wid
            return J(200, {"ok": True}) or True
        if tail == ["state"]: return J(200, {"ok": True, "state": {"workspace_id": wid, "memory_enabled": True}}) or True
        if tail == ["settings"]: return J(200, {"ok": True, "workspace": {"workspace_id": wid, "memory_enabled": b.get("memory_enabled") is not False}}) or True
        if tail == ["storage", "health"]: return J(200, {"ok": True, "health": {"ok": True}}) or True
        if tail == ["selfcheck"]: return J(200, {"ok": True, "checks": [{"name": "workspace", "ok": True}]}) or True
        if tail in (["retention", "preview"], ["archive", "preview"]): return J(200, {"ok": True, "dry_run": True, "candidates": [{"path": "sessions/2026-09", "bytes": 1024}]}) or True
        if tail in (["retention", "apply"], ["archive", "apply"]):
            if not (b.get("dry_run") is False and b.get("confirm") is True): return J(400, {"ok": False, "error": "confirm_required"}) or True
            return J(200, {"ok": True, "applied": True}) or True
        if tail in (["retention", "audits"], ["archive", "audits"]): return J(200, {"ok": True, "audits": []}) or True
        if tail == ["archive", "items"]: return J(200, {"ok": True, "items": [{"month": "2026-09", "kind": "sessions", "name": "s_old"}]}) or True
        if tail == ["archive", "restore"]:
            if b.get("confirm") is not True: return J(400, {"ok": False, "error": "confirm_required"}) or True
            return J(200, {"ok": True}) or True

    # prompts / context / ecosystem
    if path == "/api/prompts": return J(200, {"ok": True, "prompts": [{"prompt_id": "system.default_agent", "title": "默认智能体提示词（合成）", "version": "1"}]}) or True
    if path.startswith("/api/prompts/"): return J(200, {"ok": True, "prompt": {"prompt_id": parts[3], "body": "（合成提示词）"}}) or True
    if path == "/api/context/status": return J(200, {"ok": True, "budget_tokens": 128000, "used_tokens": 2300, "note": "合成"}) or True
    if path == "/api/ecosystem/providers":
        if forbidden_admin(): return True
        return J(200, {"ok": True, "providers": [{"provider": "synthetic-hub"}]}) or True
    if path == "/api/ecosystem/import/preview": return J(200, {"ok": True, "preview": [{"skill": "summarize", "action": "create"}]}) or True
    if path == "/api/ecosystem/import/apply":
        if b.get("confirm") is not True: return J(400, {"ok": False, "error": "confirm_required"}) or True
        return J(200, {"ok": True, "applied": 1}) or True

    # workflows
    if path == "/api/workflow-templates": return J(200, {"ok": True, "templates": TEMPLATES}) or True
    if len(parts) == 5 and parts[2] == "workflow-templates" and parts[4] == "instantiate":
        w = {"workflow_id": "wf_" + _sid(), "name": b.get("name") or "来自模板", "steps": [], "updated_at": NOW}; WORKFLOWS.setdefault(ws, []).append(w)
        return J(201, {"ok": True, "workflow": w}) or True
    if path == "/api/workflows" and method == "GET": return J(200, {"ok": True, "workflows": WORKFLOWS.get(ws, [])}) or True
    if path == "/api/workflows" and method == "POST":
        w = {"workflow_id": "wf_" + _sid(), "name": b.get("name") or "", "steps": b.get("steps") or [], "updated_at": NOW}; WORKFLOWS.setdefault(ws, []).append(w)
        return J(201, {"ok": True, "workflow": w}) or True
    if len(parts) >= 4 and parts[2] == "workflows":
        w = _find(WORKFLOWS.get(ws, []), "workflow_id", parts[3])
        if not w: return J(404, {"ok": False, "error": "workflow not found"}) or True
        if len(parts) == 5 and parts[4] == "runs":
            if method == "GET": return J(200, {"ok": True, "runs": [r for r in WORKFLOW_RUNS.values() if r["workflow_id"] == w["workflow_id"]]}) or True
            if not b.get("enqueue"): return J(501, {"ok": False, "error": "not_implemented_in_mock", "message": "mock 只支持 enqueue 方式"}) or True
            job = {"job_id": "job_wf_" + _sid(), "job_type": "workflow_run", "status": "queued", "created_at": NOW, "metadata": {}}; JOBS.setdefault(ws, []).insert(0, job)
            return J(202, {"ok": True, "queued": True, "job": job}) or True
        if method == "DELETE":
            if b.get("confirm") != "delete": return J(400, {"ok": False, "error": "confirm_required"}) or True
            WORKFLOWS[ws].remove(w); return J(200, {"ok": True, "deleted": True}) or True
        if method == "PUT": w.update({k: v for k, v in b.items() if k in ("name", "steps", "description")}); return J(200, {"ok": True, "workflow": w}) or True
        return J(200, {"ok": True, "workflow": w}) or True
    if len(parts) >= 4 and parts[2] == "workflow-runs":
        r = WORKFLOW_RUNS.get(parts[3])
        if not r: return J(404, {"ok": False, "error": "workflow not found"}) or True
        if len(parts) == 5 and parts[4] == "cancel": r["status"] = "cancel_requested"; return J(200, {"ok": True, "run": r}) or True
        return J(200, {"ok": True, "run": r}) or True

    # network.operations extension（仅当 extensions=network_ready 时可用）
    if len(parts) >= 5 and parts[2] == "extensions" and parts[3] == "network.operations":
        if sc.get("extensions") != "network_ready":
            return J(503, {"ok": False, "error": "extension_unavailable", "message": "扩展不可用（合成）"}) or True
        return _net(J, method, parts[4:], q, b, sc) or True

    return False


def _net(J, method, p, q, b, sc):  # noqa: C901
    kind = p[0]
    simple = {"devices": "device_id", "connections": "connection_id", "skills": "skill_id", "scripts": "script_id"}
    if kind in simple:
        key = simple[kind]; lst = NET[kind]
        if len(p) == 1 and method == "GET": return J(200, {"ok": True, kind: lst})
        if len(p) == 1 and method == "POST":
            rec = dict(b); rec.pop("workspace_id", None); rec[key] = kind[:4] + "_" + _sid(); lst.append(rec); return J(201, {"ok": True, kind[:-1]: rec})
        rec = _find(lst, key, p[1])
        if not rec: return J(404, {"ok": False, "error": "not_found"})
        if kind == "connections" and len(p) == 3 and p[2] == "test":
            fp = "SHA256:synthetic-" + rec["connection_id"]
            if not rec.get("host_key_fingerprint"):
                if b.get("accept_host_key") and b.get("accepted_fingerprint") == fp:
                    rec["host_key_fingerprint"] = fp
                    return J(200, {"ok": True, "connection_ok": True, "fingerprint": fp})
                return J(200, {"ok": False, "requires_host_key_acceptance": True, "fingerprint": fp, "error": "host_key_unknown"})
            return J(200, {"ok": True, "connection_ok": True, "fingerprint": rec["host_key_fingerprint"]})
        if method == "DELETE": lst.remove(rec); return J(200, {"ok": True})
        if method == "PUT": rec.update({k: v for k, v in b.items() if k not in ("workspace_id", key)}); return J(200, {"ok": True, kind[:-1]: rec})
        return J(200, {"ok": True, kind[:-1]: rec})
    if kind == "inspections":
        lst = NET["inspections"]
        if len(p) == 1 and method == "GET": return J(200, {"ok": True, "inspections": lst})
        if len(p) == 1 and method == "POST":
            t = {"task_id": "insp_" + _sid(), "status": "queued", "connection_ids": b.get("connection_ids") or [], "created_at": NOW, "updated_at": NOW, "results": {}}
            lst.insert(0, t); return J(202, {"ok": True, "task": t})
        t = _find(lst, "task_id", p[1])
        if not t: return J(404, {"ok": False, "error": "inspection_not_found"})
        if len(p) == 2: return J(200, {"ok": True, "task": t})
        if p[2] == "cancel": t["status"] = "cancel_requested"; return J(200, {"ok": True})
        if p[2] == "evidence":
            devices = [{"connection_id": cid, "name": (t["results"].get(cid) or {}).get("name", cid), "status": (t["results"].get(cid) or {}).get("status", "unknown" if t["status"] == "unknown" else "pending"),
                        "error": (t["results"].get(cid) or {}).get("error", ""), "retryable": (t["results"].get(cid) or {}).get("status") != "succeeded" and t["status"] in {"failed", "partial", "cancelled"},
                        "failed_commands": [{"command": "show interfaces", "error_code": "timeout"}] if (t["results"].get(cid) or {}).get("status") == "failed" else []} for cid in t["connection_ids"]]
            return J(200, {"ok": True, "task": t, "presentation": {"kind": "network_inspection", "devices": devices}})
        if p[2] == "retry":
            if t["status"] == "unknown": return J(400, {"ok": False, "error": "inspection_outcome_unknown"})
            failed = [cid for cid in t["connection_ids"] if (t["results"].get(cid) or {}).get("status") != "succeeded"]
            nt = {"task_id": "insp_" + _sid(), "status": "queued", "connection_ids": failed, "retry_of_task_id": t["task_id"], "created_at": NOW, "updated_at": NOW, "results": {}}
            lst.insert(0, nt); return J(202, {"ok": True, "task": nt})
    if kind == "topologies":
        lst = NET["topologies"]
        if len(p) == 1:
            if method == "POST":
                nt = {"topology_id": "topo_" + _sid(), "name": b.get("name") or "新图纸", "description": b.get("description") or "", "version": 1,
                      "created_at": NOW, "updated_at": NOW, "nodes": b.get("nodes") or [], "links": b.get("links") or [], "groups": b.get("groups") or [], "canvas_items": b.get("canvas_items") or []}
                lst.append(nt); return J(201, {"ok": True, "topology": nt})
            return J(200, {"ok": True, "topologies": lst})
        t = _find(lst, "topology_id", p[1])
        if not t: return J(404, {"ok": False, "error": "topology_not_found"})
        if len(p) == 2:
            if method == "GET": return J(200, {"ok": True, "topology": t})
            if method == "DELETE": lst.remove(t); return J(200, {"ok": True})
            if method == "PUT":
                if sc.get("conflict") == "topology" or b.get("version") != t["version"]: return J(409, {"ok": False, "error": "topology_version_conflict"})
                for k in ("name", "description", "nodes", "links", "groups", "canvas_items"):
                    if k in b: t[k] = b[k]
                t["version"] += 1; t["updated_at"] = NOW; return J(200, {"ok": True, "topology": t})
        if p[2] == "overlay": return J(200, {"ok": True, "overlays": []})
        if p[2] == "annotations":
            a = NET["annotations"].setdefault(t["topology_id"], {"version": 1, "items": []})
            if method == "GET": return J(200, {"ok": True, "annotations": a})
            if sc.get("conflict") == "annotations" or b.get("version") != a["version"]: return J(409, {"ok": False, "error": "annotations_version_conflict"})
            a["items"] = b.get("items") or []; a["version"] += 1; return J(200, {"ok": True, "annotations": a})
        if p[2] == "revisions" and len(p) == 3: return J(200, {"ok": True, "revisions": NET["revisions"].get(t["topology_id"], [])})
        if p[2] == "revisions" and len(p) == 5 and p[4] == "diff": return J(200, {"ok": True, "diff": {"added_nodes": ["n3"], "removed_nodes": [], "note": "合成差异"}})
        if p[2] == "revisions" and len(p) == 5 and p[4] == "restore":
            if sc.get("conflict") == "topology" or b.get("version") != t["version"]: return J(409, {"ok": False, "error": "topology_version_conflict"})
            t["version"] += 1; return J(200, {"ok": True, "topology": t})
    if kind == "context":
        return J(200, {"ok": True, "observations": NET["observations"], "references": [], "regions": []})
    if kind == "observations" and len(p) == 2 and p[1] == "batch-delete":
        ids = set(b.get("observation_ids") or []); NET["observations"] = [o for o in NET["observations"] if o["observation_id"] not in ids]
        return J(200, {"ok": True, "deleted": len(ids)})
    return J(501, {"ok": False, "error": "not_implemented_in_mock", "message": "mock 未实现该扩展接口"})
