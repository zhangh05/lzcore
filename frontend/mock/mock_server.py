#!/usr/bin/env python3
"""frontend-next 本地 mock 后端（只绑 127.0.0.1，全部数据为合成数据）。

- 不连接任何真实后端，不读凭据、会话或 output/。
- 端口：MOCK_PORT（默认 19001）；拒绝 8011 / 5273。
- 场景开关：启动环境变量（MOCK_LOGIN / MOCK_AUTH_STATUS / MOCK_EXTENSIONS / MOCK_INBOX / MOCK_LEDGER /
  MOCK_TURN / MOCK_JOBS / MOCK_ADMIN / MOCK_CONFLICT），
  或运行时 `GET /__mock/scenario?login=required` / `POST /__mock/scenario {"login":"required"}`。

场景取值：
  login        disabled（默认，本地开发模式直接进壳）| required（需要登录）| sso（需要登录 + oidc_enabled）
  auth_status  ok（默认）| error（/api/auth/status 返回 500，用于演示「服务器错误」）
  extensions   mixed（默认：一个可用 + 一个不可用带原因 + 一个无界面；network.operations 不可用 → 其接口 503）
               | network_ready（network.operations 可用，挂载扩展页）| none（未安装任何扩展）| error（目录 500）
  inbox        data（默认）| empty（所有来源都为空）
  ledger       ok（默认）| forbidden（账本 403，演示「部分来源不可读」）
  turn         complete（默认）| partial | unknown | mapping2（ok=true 无 errors 但 unknown）| error | slow（WS /ws/agent 的回合结局）
  jobs         data（默认）| mapping1（只剩 job failed + active_turn.unknown_outcome）| empty
  admin        ok（默认，platform_admin）| forbidden（管理接口 403）
  conflict     none（默认）| topology | annotations | approval（409 operation_invalidated）| memory（409 execution_unknown）
阶段 2–6 的接口实现见 mock_phase2.py；未实现的接口（上传、下载、GET 运行报告、非入队的同步工作流运行等）一律 501。
runtime tasks 按真实后端形状返回，不含 execution_outcome 等结论字段（不伪造）。
演示账户（仅 login=required/sso 时）：demo / demo-pass；用户名 server-error 触发 500。
"""
from __future__ import annotations

import json
import os
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mock_phase2  # noqa: E402
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
FORBIDDEN_PORTS = {8011, 5273}

SCENARIO_KEYS = {
    "login": {"disabled", "required", "sso"},
    "auth_status": {"ok", "error"},
    "extensions": {"mixed", "none", "error", "network_ready"},
    "inbox": {"data", "empty"},
    "ledger": {"ok", "forbidden"},
}
SCENARIO_KEYS.update(mock_phase2.PHASE2_SCENARIO_KEYS)
SCENARIO = {
    "turn": os.environ.get("MOCK_TURN", "complete"),
    "jobs": os.environ.get("MOCK_JOBS", "data"),
    "admin": os.environ.get("MOCK_ADMIN", "ok"),
    "conflict": os.environ.get("MOCK_CONFLICT", "none"),
    "login": os.environ.get("MOCK_LOGIN", "disabled"),
    "auth_status": os.environ.get("MOCK_AUTH_STATUS", "ok"),
    "extensions": os.environ.get("MOCK_EXTENSIONS", "mixed"),
    "inbox": os.environ.get("MOCK_INBOX", "data"),
    "ledger": os.environ.get("MOCK_LEDGER", "ok"),
}
for _k, _v in SCENARIO.items():
    if _v not in SCENARIO_KEYS[_k]:
        sys.exit(f"[mock] invalid {_k}={_v}; allowed: {sorted(SCENARIO_KEYS[_k])}")

SESSIONS: dict[str, str] = {}
DEMO_USER, DEMO_PASS = "demo", "demo-pass"
NOW = "2026-11-09T06:00:00-08:00"

WORKSPACES = [
    {"workspace_id": "ws-demo-1", "name": "演示工作区 A", "organization_id": "org-demo", "is_default": False},
    {"workspace_id": "ws-demo-2", "name": "演示工作区 B（无待核对）", "organization_id": "org-demo", "is_default": False},
]

EXTENSIONS = [
    {
        "extension_id": "demo.notes", "name": "演示笔记", "version": "0.1.0",
        "description": "合成的可用扩展，用于验证注册表挂载。", "capabilities": [], "tools": [],
        "frontend_routes": [{"path": "/extensions/demo.notes/board", "label": "笔记看板", "description": "合成扩展页面", "icon": "document", "order": 10}],
        "workflow_templates": [], "permissions": [], "metadata": {"minimum_role": "viewer"}, "source": "bundled",
        "lifecycle": {"extension_id": "demo.notes", "enabled": True, "status": "ready", "failure_count": 0, "last_error": ""},
    },
    {
        "extension_id": "network.operations", "name": "网络扩展（合成）", "version": "0.0.0-mock",
        "description": "合成的不可用扩展（仅 mock 数据，不加载任何真实扩展代码）。", "capabilities": [], "tools": [],
        "frontend_routes": [{"path": "/extensions/network.operations/manage", "label": "网络设备", "description": "合成", "icon": "probe", "order": 30}, {"path": "/extensions/network.operations/topology", "label": "网络拓扑", "description": "合成", "icon": "network", "order": 31}, {"path": "/extensions/network.operations/skills", "label": "网络 Skill", "description": "合成", "icon": "spark", "order": 32}],
        "workflow_templates": [], "permissions": [], "metadata": {"minimum_role": "viewer"}, "source": "bundled",
        "lifecycle": {"extension_id": "network.operations", "enabled": True, "status": "failed", "failure_count": 3, "last_error": "依赖未就绪（合成原因）"},
    },
    {
        "extension_id": "approval", "name": "审批", "version": "0.1.0", "description": "无前端界面的扩展（合成）。",
        "capabilities": [], "tools": [], "frontend_routes": [], "workflow_templates": [], "permissions": [],
        "metadata": {}, "source": "bundled",
        "lifecycle": {"extension_id": "approval", "enabled": True, "status": "ready", "failure_count": 0, "last_error": ""},
    },
]

REVIEW_ITEMS = {
    "ws-demo-1": [
        {"item_id": "review_demo_01", "workspace_id": "ws-demo-1", "artifact_id": "artifact-demo-a", "title": "报告结论需人工确认",
         "severity": "warning", "category": "manual_review", "reason": "合成：报告中有一条结论缺少证据引用。", "status": "pending", "updated_at": NOW},
        {"item_id": "review_demo_02", "workspace_id": "ws-demo-1", "artifact_id": "artifact-demo-b", "title": "导出文件字段缺失",
         "severity": "error", "category": "data_quality", "reason": "合成：导出表格缺少必填列。", "status": "pending", "updated_at": NOW},
        {"item_id": "review_demo_03", "workspace_id": "ws-demo-1", "artifact_id": "artifact-demo-a", "title": "已处理的审阅项",
         "severity": "info", "category": "manual_review", "reason": "合成：已接受。", "status": "accepted", "updated_at": NOW},
    ],
    "ws-demo-2": [],
}

LEDGER = {
    "ws-demo-1": [
        {"operation_id": "op_demo_unknown_01", "status": "unknown", "canonical_tool": "workspace.file.write", "task_id": "task_demo_unknown",
         "result_summary": "合成：写入请求已发出，回执丢失。", "updated_at": NOW},
        {"operation_id": "op_demo_indet_02", "status": "indeterminate", "canonical_tool": "external.http.post",
         "result_summary": "合成：对端返回无法判定。", "updated_at": NOW},
        {"operation_id": "op_demo_ok_03", "status": "succeeded", "canonical_tool": "workspace.file.write", "result_summary": "合成：已确认。", "updated_at": NOW},
    ],
    "ws-demo-2": [],
}

# 阶段 2–6 最小修复：0–1 版的 TASKS 带有 execution_outcome / unknown_outcome，基线后端的 durable TaskState 并没有这些字段。
# 运行时任务现在由 mock_phase2.RUNTIME_TASKS 按真实字段提供；未知项只来自会话 task-state。


mock_phase2.SHARED.update({"LEDGER": LEDGER, "WORKSPACES": WORKSPACES})


def ws_known(ws: str) -> bool:
    return any(w["workspace_id"] == ws for w in WORKSPACES)


class Handler(BaseHTTPRequestHandler):
    server_version = "lzcore-next-mock/0.2"
    protocol_version = "HTTP/1.1"  # WebSocket 升级要求 HTTP/1.1

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("[mock] %s %s\n" % (self.command, self.path))

    # ── helpers ──
    def _json(self, status: int, body, headers: dict | None = None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _session_user(self) -> str:
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "mock_session" and v in SESSIONS:
                return SESSIONS[v]
        return ""

    def _login_enabled(self) -> bool:
        return SCENARIO["login"] in {"required", "sso"}

    def _authorized(self) -> bool:
        return not self._login_enabled() or bool(self._session_user())

    # ── routing ──
    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_PUT(self):  # noqa: N802
        self._route("PUT")

    def do_DELETE(self):  # noqa: N802
        self._route("DELETE")

    def do_PATCH(self):  # noqa: N802
        self._route("PATCH")

    def _route(self, method: str):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        parts = path.split("/")

        if path == "/__mock/scenario":
            updates = dict(q) if method == "GET" else (self._body() or {})
            for k, v in updates.items():
                if k in SCENARIO_KEYS and v in SCENARIO_KEYS[k]:
                    SCENARIO[k] = v
            if updates.get("reset_sessions") in {"1", True}:
                SESSIONS.clear()
            return self._json(200, {"ok": True, "scenario": SCENARIO, "allowed": {k: sorted(v) for k, v in SCENARIO_KEYS.items()}})
        if path == "/__mock/health":
            return self._json(200, {"ok": True, "mock": True})

        if path == "/ws/agent" and method == "GET":
            if not self._authorized():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            if mock_phase2.ws_handshake(self):
                self.close_connection = True
                try:
                    mock_phase2.ws_loop(self, SCENARIO)
                except (ConnectionError, OSError):
                    pass
                return
            return self._json(400, {"ok": False, "error": "websocket_upgrade_required"})

        if not path.startswith("/api/"):
            return self._json(404, {"ok": False, "error": "mock_only_serves_api"})

        if path == "/api/auth/status" and method == "GET":
            if SCENARIO["auth_status"] == "error":
                return self._json(500, {"ok": False, "error": "mock_internal_error"})
            user = self._session_user()
            login = self._login_enabled()
            return self._json(200, {
                "ok": True, "login_enabled": login, "authenticated": bool(user),
                "username": user, "role": "admin" if user else "",
                "organization_id": "org-demo" if user else "", "workspace_ids": [w["workspace_id"] for w in WORKSPACES] if user else [],
                "home_workspace_id": "ws-demo-1" if user else "", "identity_enabled": False,
                "oidc_enabled": SCENARIO["login"] == "sso", "platform_admin": bool(user),
                "auth_type": "session" if user else "none",
            })
        if path == "/api/auth/login" and method == "POST":
            if not self._login_enabled():
                return self._json(404, {"ok": False, "error": "login_disabled", "message": "Login is not enabled on this server.", "status": 404})
            body = self._body()
            username, password = str(body.get("username", "")), str(body.get("password", ""))
            if username == "server-error":
                return self._json(500, {"ok": False, "error": "mock_internal_error"})
            if username == DEMO_USER and password == DEMO_PASS:
                sid = secrets.token_hex(16)
                SESSIONS[sid] = username
                return self._json(200, {"ok": True, "username": username, "role": "admin"},
                                  {"Set-Cookie": f"mock_session={sid}; Path=/; HttpOnly; SameSite=Lax"})
            return self._json(401, {"ok": False, "error": "unauthorized", "message": "Invalid username or password"})
        if path == "/api/auth/logout" and method == "POST":
            return self._json(200, {"ok": True}, {"Set-Cookie": "mock_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"})
        if path == "/api/auth/oidc/start":
            return self._json(501, {"ok": False, "error": "mock_oidc_not_implemented", "message": "mock 不实现 OIDC 流程"})

        if not self._authorized():
            return self._json(401, {"ok": False, "error": "unauthorized"})

        if path == "/api/workspaces" and method == "GET":
            return self._json(200, {"workspaces": WORKSPACES})
        if len(parts) == 5 and parts[2] == "workspaces" and parts[4] == "status" and method == "GET":
            ws = parts[3]
            if not ws_known(ws):
                return self._json(404, {"ok": False, "error": "workspace_not_found"})
            return self._json(200, {"ok": True, "workspace_id": ws, "status": "ready"})

        if path == "/api/extensions" and method == "GET":
            if SCENARIO["extensions"] == "error":
                return self._json(500, {"ok": False, "error": "mock_extension_catalog_failed"})
            catalog = [] if SCENARIO["extensions"] == "none" else EXTENSIONS
            if SCENARIO["extensions"] == "network_ready":
                catalog = [dict(e, lifecycle=dict(e["lifecycle"], status="ready", last_error="")) if e["extension_id"] == "network.operations" else e for e in EXTENSIONS]
            return self._json(200, {"ok": True, "extensions": catalog, "count": len(catalog)})

        # review-items
        if len(parts) == 5 and parts[2] == "workspaces" and parts[4] == "review-items" and method == "GET":
            ws = parts[3]
            if not ws_known(ws):
                return self._json(400, {"ok": False, "error": "invalid_workspace_id"})
            items = [] if SCENARIO["inbox"] == "empty" else REVIEW_ITEMS.get(ws, [])
            status = q.get("status")
            if status:
                items = [i for i in items if i["status"] == status]
            return self._json(200, {"ok": True, "items": items, "count": len(items), "workspace_id": ws})
        if len(parts) == 7 and parts[2] == "workspaces" and parts[4] == "artifacts" and parts[6] == "review-items":
            ws, aid = parts[3], parts[5]
            items = [] if SCENARIO["inbox"] == "empty" else [i for i in REVIEW_ITEMS.get(ws, []) if i["artifact_id"] == aid]
            return self._json(200, {"ok": True, "items": items, "count": len(items), "workspace_id": ws, "artifact_id": aid})
        if len(parts) == 4 and parts[2] == "review-items" and method == "PUT":
            ws, aid, item_id = q.get("workspace_id", ""), q.get("artifact_id", ""), parts[3]
            body = self._body()
            status = str(body.get("status") or "")
            if status not in {"pending", "accepted", "ignored", "modified"}:
                return self._json(400, {"ok": False, "errors": ["invalid_status"]})
            for item in REVIEW_ITEMS.get(ws, []):
                if item["item_id"] == item_id and item["artifact_id"] == aid:
                    item.update({"status": status, "user_note": str(body.get("user_note") or ""), "updated_at": NOW})
                    return self._json(200, {"ok": True, "item": item})
            return self._json(404, {"ok": False, "errors": ["item_not_found"]})

        # operation ledger (admin)
        if path == "/api/admin/operation-ledger" and method == "GET":
            if SCENARIO["ledger"] == "forbidden":
                return self._json(403, {"ok": False, "error": "forbidden"})
            ws = q.get("workspace_id", "")
            if not ws_known(ws):
                return self._json(400, {"ok": False, "error": "invalid_workspace_id"})
            ops = [] if SCENARIO["inbox"] == "empty" else LEDGER.get(ws, [])
            if q.get("status"):
                ops = [o for o in ops if o["status"] == q["status"]]
            counts: dict[str, int] = {}
            for o in ops:
                counts[o["status"]] = counts.get(o["status"], 0) + 1
            return self._json(200, {"ok": True, "operations": ops, "count": len(ops), "counts": counts, "maintenance": {}})

        # 阶段 2–6 接口（会话、运行时任务、作业、资料、系统、工作流、扩展、WebSocket 之外的全部 HTTP）
        if mock_phase2.handle(self, method, path, parts, q, SCENARIO):
            return

        return self._json(501, {"ok": False, "error": "not_implemented_in_mock", "path": path,
                                "message": "frontend-next mock 未实现该接口。"})


def main():
    port = int(os.environ.get("MOCK_PORT", "19001"))
    if port in FORBIDDEN_PORTS:
        sys.exit(f"[mock] refusing port {port}: 8011 is the product backend, 5273 is the product frontend port")
    server = ThreadingHTTPServer((HOST, port), Handler)
    sys.stderr.write(f"[mock] listening on http://{HOST}:{port} scenario={SCENARIO}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
