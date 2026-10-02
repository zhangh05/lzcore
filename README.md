# 联智中枢（LZCore）

企业运维工作台：用对话驱动受治理工具，管理任务、设备、独立网络图纸、知识、记忆和可追溯证据。产品名为「联智中枢」，框架为 LZCore，配置和部署使用 lzcore。

## 开始使用

本地源码环境需要 Python 3.12+、Node.js 24 LTS、npm、curl 和 lsof。

```bash
bash start.sh
# 前端 http://127.0.0.1:5273
# 后端 http://127.0.0.1:8011/api/health
bash stop.sh
```

默认监听 loopback。非回环监听必须启用 API token、登录或 identity；具体环境配置见 [生产运行](docs/PRODUCTION.md)。Windows 用户可选 [便携版或安装版](docs/WINDOWS.md)，不需安装源码开发环境。

## 工作方式

- 工作台选择发布的网络 Skill，按需连接其范围内的设备，读取、巡检或配置。服务端逐调用校验范围；设备账号决定最终命令权限。
- 拓扑页每张图有独立 drawing Skill，支持节点增删、位置、属性、区域、连线、接口及样式。图纸不是实时资产，图上绑定设备只显示最近测试/观测。
- 知识说明来源内容；记忆保存受治理规则和经验，不冒充当前设备状态。任务、制品、记录和审计保留实际证据。

```text
POST /api/agent/message 或 /ws/agent
  -> AgentApp -> SSOTRuntimeEngine -> QueryLoop
  -> ToolRuntime / ToolRuntimeClient -> 工具或扩展
  -> store、证据与 AgentResult
```

TaskState 负责服务端任务控制；execution_outcome 表示用户目标，tool_execution_outcome 表示工具尝试。页面和 Zustand store 只投影。普通回合持续有进展时不按固定总轮数截断；单次超时、容量、无进展和取消仍有明确处理。未知外部写入先 read-back/reconcile，不自动重放。

所有工具经过 core/tools/manifest_registry.py 对应治理网关；workspace_id 和认证主体在服务端核验。密钥优先进入系统凭据库，不可用时用 Fernet；不得进入源码、普通日志或浏览器持久化存储。

## 工具导航

公共清单以 /api/tools/catalog 和注册表为准，不在文档复制版本易漂移的数量。

| 类别 | canonical ID | 作用 |
| --- | --- | --- |
| 执行与委派 | agent.manage、exec.run、browser.manage | 独立任务、受控脚本和浏览器交互 |
| 研究与定位 | web.manage、location.manage | 搜索/抓取、天气、地理编码 |
| 结构化处理 | data.manage、text.analyze | 解析、合并、计算、脱敏与匹配 |
| 工作区 | workspace.metadata.get、workspace.file、workspace.filestore、workspace.artifact | 身份、文件、托管引用和制品 |
| 文档 | workspace.document.pdf.extract_text、report.manage | PDF 提取和报告产出 |
| 知识与规则 | knowledge.manage、memory.manage、skill.manage | 检索、受治理记忆和 Skill/MCP |
| 诊断 | system.manage | 本机事实、运行与审计 |

扩展拥有业务工具，例如 network.operations.device.manage 与 network.operations.topology。提示词指导如何选择；原生 schema 和服务端策略决定能否执行。

## 按问题读文档

| 问题 | 文档 |
| --- | --- |
| 设计和源码边界 | [DESIGN](DESIGN.md)、[目录](STRUCTURE.md)、[源码入口](docs/architecture/README.md) |
| LLM 效率和准确性 | [提示词与 Skill](docs/SKILL_PROMPT_ARCHITECTURE.md)、[Loop](docs/LOOP_ENGINEERING.md) |
| API/数据 | [API](docs/API.md)、[接入合同](docs/backend/API_CONTRACT.md)、[存储](docs/storage/STORAGE_BOUNDARIES.md) |
| 知识与记忆 | [记忆](docs/MEMORY_SUBSYSTEM.md) |
| 领域开发 | [扩展](docs/EXTENSIONS.md)、[工作流](docs/WORKFLOWS.md)、[审批](docs/APPROVAL_EXTENSION.md) |
| UI 和 Windows | [前端](docs/FRONTEND.md)、[桌面发行](docs/WINDOWS.md) |
| 部署和事故 | [生产运行](docs/PRODUCTION.md)、[处置手册](docs/OPERATIONS_RUNBOOK.md)、[身份](docs/TENANCY.md) |
| 协作与规划 | [AGENTS](AGENTS.md)、[路线](docs/PLATFORM_ROADMAP.md) |

历史 review/design QA 是当时证据，不作为当前接口或发布验收。

## 修改后验证

```bash
.venv/bin/python scripts/verify_docs_runtime_consistency.py
.venv/bin/pytest -q harness/test_runtime_prompt_ssot.py harness/test_prompt_system_contract.py harness/test_goal_loop.py
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

按变更补充相关契约和真实运行验证。测试通过不等于用户 Windows、实际设备或真实模型任务已验收。
