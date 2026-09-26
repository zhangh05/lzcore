# LZCore 开发协作约定

本文件面向在此仓库修改代码的人和自动化代理。它描述现行约束，不替代代码、测试或部署配置。

## 命名

- 界面、报告和产品文档使用「联智中枢」。
- 框架和工程使用 `LZCore`。
- 仓库、配置、存储、部署和指标使用 `lzcore`。
- 不恢复已废弃的产品名、工具别名或兼容路径。

## 不可突破的边界

1. 内核保持领域中立。行业对象、厂商 CLI 和业务 UI 放在 `extensions/`。
2. 工具必须经 `ToolRuntimeClient.invoke()`。禁止直接调用 handler，绕过 manifest、调用方、授权、脱敏和审计。
3. 跨数据访问必须使用已验证的 `workspace_id`。前端不得伪造默认工作区。
4. 工具失败、任务结果和外部写入未知是不同状态。只读失败可在有证据目标时恢复。写入未知只能 read-back 或 reconcile，不能自动重放。
5. 网络配置范围由服务端在调用时按已发布 Skill 重新核定。设备账号决定命令最终权限。模型填写的 `action` 不能把配置命令变成只读。
6. 密钥、令牌、密码、私钥和原始敏感输出不得进入 Git、日志、trace、文档样例或浏览器持久化存储。
7. Markdown 只描述代码事实。改代码时同步改相关文档。不得为了迁就过时文档去改运行时。

## 主链路与归属

```text
HTTP / WebSocket
  -> backend/
  -> agent/app/
  -> agent/runtime/
  -> core/runtime_engine/
  -> core/tools/
  -> storage/、artifacts/、jobs/、observability/
```

- `backend/`：传输、认证、API。任务语义在 runtime。
- `core/runtime_engine/`：QueryLoop、目标、证据、`plan_goal_ids`、`goal_loop`、`runtime_recoveries` 和结果投影。
- `core/tools/`：canonical tool、manifest、policy、executor、redaction。当前注册表有 17 个通用工具。
- `extensions/`：扩展清单、业务工具、业务路由和扩展前端。
- `agent/capabilities/catalog.py`：能力目录，只供展示和推荐，不注册工具或授权。
- `jobs/`：作业模型和 worker。默认是文件锁队列；生产 Compose 可切换为 Redis 队列。不是 Celery。
- `storage/`：持久化边界。密钥优先进系统凭据库，没有系统凭据库时用 Fernet。`workspaces/`、`logs/`、`config/providers/` 是本机数据，不提交。
- `frontend/`：React 18、Vite、原生 CSS tokens、Zustand。浏览器不得复制服务端权限或终态判定。

## 修改检查

- 工具：更新 canonical registry、manifest、contract、policy、测试和必要文档。
- API：更新路由、前端调用、`docs/API.md` 和契约测试。
- 扩展：工具、路由、前端都留在扩展命名空间内。
- 状态机：覆盖创建、读取、更新、取消、终态、删除和恢复。
- 文档：每个路径、端点、环境变量和命令都要能在仓库里找到。

## 验证

```bash
python scripts/verify_docs_runtime_consistency.py
.venv/bin/pytest -q harness/test_goal_loop.py harness/test_docs_consistency_script.py harness/test_runtime_prompt_ssot.py
cd frontend && npm test -- --run && npm run build
```

不要把「测试通过」写成「页面、设备或外部系统已经验证」。
