# 联智中枢（LZCore）

联智中枢是基于 LZCore 的企业运维工作台。它把对话任务、受治理的工具调用、工作区数据、作业、知识、记忆、扩展和审计放在同一条可追溯链路上。

产品名是「联智中枢」。框架名是 `LZCore`。仓库、配置、部署和指标使用 `lzcore`。

## 能做什么

- 在工作台里用已发布的 Skill 完成设备读取、巡检和配置。设备账号决定命令最终能否在设备上执行。
- 在网络拓扑页绘制独立图纸。每张图有一个自动生成的绘图 Skill，只读写这一张图，不连接真实设备。
- 登记设备、连接和观测。人可以在图纸节点上绑定已登记设备；画布只显示最近测试和最近观测，不表示当前正常。
- 管理知识、记忆、制品、作业和审计。行业能力通过扩展接入，不写进内核。

## 运行边界

权威任务状态是 `TaskState`，对外结果是 `AgentResult`。`execution_outcome` 表示用户目标是否完成，`tool_execution_outcome` 只描述本次工具尝试，二者不能混用。

一次任务没有累计墙钟上限。结束条件是目标完成、确定性无进展、结构性容量或用户取消。单次模型或工具调用仍可按协议超时。

所有工具经过统一治理网关（外部/审批经 `ToolRuntimeClient.invoke()`，模型编排经 `ToolRuntime.execute_node()`）：manifest、调用方、Skill 范围、执行、脱敏、审计。禁止直接调用 handler。跨数据访问必须带已验证的 `workspace_id`。

只读失败可以在有证据目标时恢复。外部写入结果未知时不自动重放，只能 read-back 或 reconcile。网络命令的只读/配置由服务端按命令文本分类，不信任模型填写的 `action`。

密钥优先放进系统凭据库（macOS 钥匙串、Windows DPAPI）。没有系统凭据库时才用 Fernet。明文不进入 Git、日志、trace 或浏览器持久化存储。

## 请求链路

```text
浏览器 / HTTP / WebSocket
  -> AgentApp
  -> SSOTRuntimeEngine（TaskState）
  -> QueryLoop（plan_goal_ids、goal_loop、runtime_recoveries）
  -> ToolRuntime / ToolRuntimeClient（core/tools/manifest_registry.py）
  -> canonical tool 或扩展工具
  -> storage、artifacts、jobs、AgentResult
```

主入口是 `POST /api/agent/message`。实时通道是 `ws://127.0.0.1:8011/ws/agent`。前端用 Zustand 展示服务端状态，不在浏览器里重建授权。

## 通用工具

数量由 `core.tools.tool_namespace.TOOL_NAMESPACE` 决定，当前 17 个。清单以 `/api/tools/catalog` 为准。

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| `agent.manage` | 委派子 Agent | 继承父任务工具面；父任务选了 Skill 时继承服务端重解析后的范围 |
| `browser.manage` | 浏览器自动化 | 需要页面状态或交互证据时使用 |
| `data.manage` | 内存中的解析、过滤、聚合、合并和渲染 | 不取外部事实，不作为持久存储 |
| `exec.run` | 本机 Shell / PowerShell / Python | Shell 拦截破坏性命令。Python 在回环开发环境默认本机子进程；非回环、登录、身份认证或显式强隔离时走 Docker，容器不可用则拒绝 |
| `knowledge.manage` | 检索、读取、导入、重建索引 | `import` / `reindex` 会改索引；检索结果可能过时 |
| `location.manage` | 地名、地址、坐标解析 | 通用地理编码，不是设备或机房台账 |
| `memory.manage` | 搜索和写入长期记忆 | 写入前经过 MemoryWriteGate；不存密钥 |
| `report.manage` | 保存和渲染报告 | 报告证明写了什么，不证明内容为真 |
| `skill.manage` | 发现、加载 Skill，调用已配置的 MCP | Skill 文本不是事实，也不能扩大授权 |
| `system.manage` | 运行诊断、审计、会话和本机时间 | 历史记录不是当前外部状态 |
| `text.analyze` | 脱敏、实体抽取、正则 | 匹配不是语义证明 |
| `web.manage` | 公开网页搜索和抓取 | 摘要不能代替打开后的页面 |
| `workspace.artifact` | 制品的列出、读取、保存 | 不是原始文件编辑 |
| `workspace.document.pdf.extract_text` | 提取工作区 PDF 文本 | 不保证版式；未读页不能当已分析 |
| `workspace.file` | 工作区文件和附件 | 禁止 `..` 和绝对路径离开工作区 |
| `workspace.filestore` | 托管文件引用和导入 | 不是原始文件编辑器 |
| `workspace.metadata.get` | 当前工作区身份和存储统计 | 不返回密钥 |

业务工具放在 `extensions/`。网络设备工具是 `network.operations.device.manage`。图纸工具是 `network.operations.topology`，且只对 `drawing:<topology_id>` Skill 开放。

## 本地启动

要求 Python 3.12+、Node.js 24 LTS、npm、`curl`、`lsof`。

```bash
bash start.sh
```

- 前端：`http://127.0.0.1:5273`
- 健康检查：`http://127.0.0.1:8011/api/health`

```bash
bash stop.sh
```

默认只监听 loopback。若监听局域网或公网，必须启用 API token、登录或 identity。无认证的非回环监听会被拒绝。

Windows 桌面程序见 [docs/WINDOWS.md](docs/WINDOWS.md)。生产 Compose 见 [docs/PRODUCTION.md](docs/PRODUCTION.md)。生产配置使用内置 worker、Redis 队列与事件总线、PostgreSQL 和 MinIO。本地 `deployment/compose.server.yml` 默认仍是文件系统队列。

## 文档

- [设计](DESIGN.md)
- [目录归属](STRUCTURE.md)
- [开发约束](AGENTS.md)
- [API](docs/API.md)
- [Loop](docs/LOOP_ENGINEERING.md)
- [扩展](docs/EXTENSIONS.md)
- [工作流](docs/WORKFLOWS.md)
- [前端](docs/FRONTEND.md)
- [生产部署](docs/PRODUCTION.md)
- [运维处置](docs/OPERATIONS_RUNBOOK.md)
- [审批扩展](docs/APPROVAL_EXTENSION.md)
- [记忆](docs/MEMORY_SUBSYSTEM.md)
- [Skill 与提示词](docs/SKILL_PROMPT_ARCHITECTURE.md)
- [组织与工作区](docs/TENANCY.md)
- [路线](docs/PLATFORM_ROADMAP.md)

## 提交前验证

运行时、工具或存储改动：

```bash
python scripts/verify_docs_runtime_consistency.py
.venv/bin/pytest -q harness/test_goal_loop.py harness/test_runtime_prompt_ssot.py
```

前端改动：

```bash
cd frontend && npm test -- --run && npm run build
```

测试通过不等于页面、设备或外部系统已经验证。
