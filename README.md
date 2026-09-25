# 联智中枢（LZCore）

> **企业级认知智能运维与网络协同内核 · Next-Generation Enterprise Cognitive AIOps & Network Intelligence Platform**

[![Release](https://img.shields.io/badge/Release-v3.1.0-blue.svg)](https://github.com/zhangh05/lzcore/releases/tag/v3.1.0)
[![Python](https://img.shields.io/badge/Python-3.12%2B-brightgreen.svg)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Frontend](https://img.shields.io/badge/Frontend-React%20%7C%20Vite%20%7C%20CSS%20Tokens%20%7C%20Zustand-61dafb.svg)](https://react.dev/)
[![Architecture](https://img.shields.io/badge/Architecture-SSOT%20Runtime%20%7C%20Zero--Trust-orange.svg)](#系统端到端架构与执行链路)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#双模交付架构)

---

## 平台定位与使命

**联智中枢（LZCore）** 是面向复杂企业 IT 基础设施、多厂商网络拓扑与关键生产系统的**自主认知智能运维平台**。

在传统自动化或简单包装的大模型 Agent 方案中，模型往往直接裸露于脆弱的脚本环境，面临“幻觉导致误操作、写入结果无法确认、会话历史截断丢失因果、权限边界模糊失控”等致命隐患。

联智中枢从底层重塑了企业级智能体的运行契约：
- **受治理的确定性执行**：大语言模型负责意图理解、证据链推理与目标规划；底层运行时接管所有工具 Schema 校验、权限沙箱、凭证隔离、外部写入对账与审计记录。
- **全生命周期可追溯**：将对话式任务、工具调用轨迹、网络拓扑观测、离线作业队列、长效知识与情景记忆统合于单一可信事实源（SSOT）链路中。

> **命名规范声明**：
> - **联智中枢**：面向最终用户与运维专家的产品标准名称。
> - **LZCore**：平台核心框架与工程架构代号。
> - **lzcore**：用于代码仓库命名、配置文件、容器镜像、部署工程与指标度量前缀。

---

## 四大核心架构准则

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │                           联智中枢 核心原则                           │
  ├───────────────────┬───────────────────┬───────────────────┬───────────┤
  │   1. SSOT 认知闭环 │  2. 确定性工具治理 │ 3. 证据驱动目标自愈│4. 零信任隔离│
  │                   │                   │                   │           │
  │  单事实源权威驱动  │  拒绝裸调用与旁路  │  解耦任务与工具成败 │ 多租户隔离│
  │  因果流不可篡改    │  只读/配置语义校验 │  只读断言闭环推进  │ 凭据信封加密│
  └───────────────────┴───────────────────┴───────────────────┴───────────┘
```

1. **单一事实源（SSOT）认知运行时**：
   任务的权威状态由服务端的 `TaskState` 唯一确权，并向外投影为标准化 `AgentResult`。前端、历史记录、知识库检索与外部工具输出统一被视为只读证据（`data_only`），绝不可反向劫持系统提示词或伪造权限。
2. **零越权工具治理网关**：
   内核绝不为特定业务保留非受控的后门工具。所有能力均由 `ToolRuntimeClient` 统一调度，经由 Manifest 清单、调用方门禁、Skill 授权切片、动态参数脱敏与审计总线全流程防护。
3. **任务目标与工具执行严格正交**：
   单次工具执行异常（`tool_execution_outcome`）不等于用户任务失败（`execution_outcome`）。当遇到只读异常时，引擎启动目标驱动自愈循环（`goal_loop` 与 `runtime_recoveries`），通过备用只读证据链实现任务达成；对于未知写入，绝不盲目重放，保持真实状态交由回读核验。
4. **严格多租户与端到端凭据防护**：
   所有跨数据交互强制绑定并校验 `workspace_id`，杜绝租户数据越权与污染。敏感账密采用工业级 `Fernet` 信封加密机密存储，运行日志与传输流全链路自动脱敏，保障生产环境核心资产安全。

---

## 系统端到端架构与执行链路

联智中枢将用户请求、多模态输入与网络事件转化为具备防御纵深的认知推理闭环：

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                         接入层 (Access Layer)                           │
 │  现代 Web 界面 (Zustand 响应式状态) │ WebSocket 实时流 │ RESTful API 契约 │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │ /api/agent/message & ws://
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      认知核心层 (Cognitive Engine)                      │
 │                                                                        │
 │   ┌────────────────────────────────────────────────────────────────┐   │
 │   │ AgentApp & SSOTRuntimeEngine                                   │   │
 │   │ 保持因果一致性，维护权威 TaskState，聚合记忆与上下文          │   │
 │   └───────────────────────────────┬────────────────────────────────┘   │
 │                                   │                                    │
 │                                   ▼                                    │
 │   ┌────────────────────────────────────────────────────────────────┐   │
 │   │ QueryLoop 认知循环 (推理规划 -> 依赖绑定 -> 目标自愈)           │   │
 │   │ · plan_goal_ids 驱动证据补全 · 支持长时间任务无墙钟截断        │   │
 │   └───────────────────────────────┬────────────────────────────────┘   │
 └───────────────────────────────────┼────────────────────────────────────┘
                                     │ 受控调用
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      治理网关层 (Tool Governance)                       │
 │  ToolRuntimeClient 统一网关 (core/tools/manifest_registry.py)          │
 │  ├─ 1. Schema 契约校验 (Function Calling 严格约束)                    │
 │  ├─ 2. Caller Gate 身份鉴权 (租户 workspace_id 隔离)                  │
 │  ├─ 3. Skill Scope 范围核定 (设备账号真实授权)                         │
 │  ├─ 4. 安全执行沙箱 (命令语义分类 / Docker 容器隔离 / 路径逃逸防御)  │
 │  └─ 5. 敏感信息脱敏与审计总线 (Redaction & Audit Ledger)               │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      持久化与服务层 (Storage & Bus)                     │
 │  Canonical Stores │ Artifacts 仓库 │ 异步作业队列 │ 事件总线 / Redis   │
 └────────────────────────────────────────────────────────────────────────┘
```

---

## 通用工具命名空间矩阵

平台通用 Canonical Tools 注册表由 `core.tools.manifest_registry.py` 严格维护。当前标准运行时内建提供 **17** 个高内聚、受治理的通用能力工具（查询接口可通过 `/api/tools/catalog` 获取最新动态清单）：

| 工具标识符 (Namespace) | 权限动作类别 | 安全防护等级 | 职责概述与核心边界 |
| :--- | :--- | :--- | :--- |
| `agent.manage` | Agent 协同 | 中 | 启动、调度和监控子 Agent 委派任务；严格继承父任务切片与上下文契约 |
| `browser.manage` | 网页/DOM操作 | 中 | 受控自动化无头浏览器，支持网页导航、快照与结构化内容提取 |
| `data.manage` | 数据治理 | 低 / 只读 | 多维数据集过滤、合并、聚合与转换计算，保障内存运算安全 |
| `exec.run` | 宿主执行 | 高 / 审计拦截 | 执行受限主机 Shell、PowerShell 或沙箱化 Python 脚本，严禁破坏性指令 |
| `knowledge.manage` | 知识库管理 | 中 / 读写（按 action 区分） | 知识检索、分片读取与知识库导入/重索引（import/reindex 修改索引） |
| `location.manage` | 通用地理位置解析 | 低 / 只读 | 通用地名、街道地址、经纬度坐标解析与批量地理编码转换 |
| `memory.manage` | 记忆演进 | 中 / 写入门禁 | 长期经验总结、核心偏好沉淀与语义事实管理，由 MemoryWriteGate 防火墙过滤 |
| `report.manage` | 报告交付 | 低 / 生成写入 | 聚合巡检证据与分析结论，生成标准化 Markdown/HTML 交付物报告 |
| `skill.manage` | 技能与MCP管理 | 中 / 执行（execute） | 检索、加载与检查通用 Skill 规范，调用受信任的外部 MCP 工具 |
| `system.manage` | 平台宿主观测 | 低 / 只读 | 获取主机系统负载、运行时生命周期、系统时间与环境真实基线事实 |
| `text.analyze` | 结构化文本挖掘 | 低 / 无副作用 | 对日志文本、配置差分进行模式提炼、正则抽取与统计学分析 |
| `web.manage` | 外部网络互联 | 低 / 网络只读 | 遵循合规策略的外网搜索引擎查询与网页静态事实提取，自动声明引用出处 |
| `workspace.artifact` | 制品管理 | 中 / 隔离写入 | 工作区制品文件的写入、元数据提取与版本封存，防范大文件溢出 |
| `workspace.document.pdf.extract_text` | 文档解析 | 低 / 内存只读 | 安全提取 PDF 架构文档与厂商手册文本切片，拒绝二进制执行 |
| `workspace.file` | 工作区文件系统 | 高 / 路径越界防御 | 工作区边界内文本文件读写与局部 Patch，禁止 `..` 遍历与绝对路径逃逸 |
| `workspace.filestore` | 文件存储索引 | 中 / 原子索引 | 工作区资产文件的原子入库、Hash 校验与生命周期索引对账 |
| `workspace.metadata.get` | 环境元数据 | 低 / 只读 | 读取当前工作区上下文配置、租户环境标识及全局元数据信息 |

> **扩展开发规范**：新增特定行业与业务专属能力必须遵循 [扩展开发规范](docs/EXTENSIONS.md)，作为 Extension 插件注册，严禁擅自绕过 Canonical 治理网关。

---

## 双模交付架构

平台支持**企业级分布式云原生集群**与**单兵/离线便携式桌面应用**双模部署形态，适配从大规模数据中心到涉密隔离机房的多样化生产诉求。

### 模式 A：Windows 桌面独立版应用 (Desktop Standalone)
- **免环境依赖**：针对无法连接外网或安装庞大开发工具链的运维现场，预制独立执行环境，单文件即可启动运行。
- **本地回环安全**：原生绑定 `127.0.0.1` 环回接口，内建轻量化工作进程（Embedded Worker）与原生 GUI 壳体（基于 pywebview / Windows Edge WebView2），开箱即用。
- **预制工作区骨架**：安装包已预置纯净合规的 `workspaces/` 与 `config/` 结构，个人隐私拓扑零泄露。
- 详见：[Windows 本地运行与打包指南](docs/WINDOWS.md)。

### 模式 B：云原生生产集群 (Cloud-Native Server)
- **分布式高可用架构**：采用容器化部署，解耦 Web 接口层、内置任务 Worker 进程、Redis 事件总线、PostgreSQL 持久化数据库与 MinIO 兼容分布式对象存储。
- **生产级可观测性**：开箱即用集成 Prometheus 指标暴露、Alertmanager 告警路由与 Grafana 全维度大屏。
- 详见：[生产部署与运行指南](docs/PRODUCTION.md) 与 [运维处置手册](docs/OPERATIONS_RUNBOOK.md)。

---

## 快速上手与运行验证

### 1. 本地开发者环境启动

**环境要求**：
- **运行环境**：Python 3.12+、Node.js 24 LTS、npm。
- **系统工具**：`curl` 与 `lsof`。

```bash
# 启动本地开发服务栈（自动完成依赖安装与端口就绪探针）
bash start.sh
```

**默认网络端点**：
- **前端工作台**：`http://127.0.0.1:5273`
- **后端健康就绪检查**：`http://127.0.0.1:8011/api/health`
- **实时事件通道**：`ws://127.0.0.1:8011/ws/agent`

**停止本地服务**：
```bash
bash stop.sh
```

> **安全网络准入规则**：启动脚本默认严密绑定本地 Loopback 回环地址。若配置监听局域网或公网 IP，系统强制要求开启 API Token、身份认证中心或 OIDC 联合登录；未经认证的公网监听请求将被安全内核坚决拒绝。

---

## 质量防护网与契约测试

平台践行严格的契约化驱动开发（Contract-Driven Development），每次提交前须运行相应的自动化校验套件：

```bash
# 1. 验证文档与底层运行时表面的因果一致性 (SSOT 规范检测)
python scripts/verify_docs_runtime_consistency.py

# 2. 运行认知核心与目标驱动 Loop 单元/契约测试
.venv/bin/pytest -q harness/test_goal_loop.py harness/test_runtime_prompt_ssot.py

# 3. 前端界面自动化测试与构建校验
cd frontend && npm test -- --run && npm run build
```

---

## 平台文档全景导航

| 领域维度 | 核心文档索引 | 重点内容概述 |
| :--- | :--- | :--- |
| **架构总纲** | [架构设计与底层实现 (DESIGN.md)](DESIGN.md) | SSOT 引擎、状态机、多模型协议、工具网关与存储全貌 |
| **工程约定** | [协作约定与规范底线 (AGENTS.md)](AGENTS.md) | 面向人类与 AI 助理的工程边界、命名规范与交付标准 |
| **目录拓扑** | [源码结构与模块归属 (STRUCTURE.md)](STRUCTURE.md) | 源码分层结构、模块权责边界与禁止引入的陈旧路径 |
| **认知闭环** | [目标驱动 Loop Engineering](docs/LOOP_ENGINEERING.md) | 复杂多轮推理、证据声明、断言门禁与自动恢复算法 |
| **提示词与Skill**| [Skill 与提示词架构](docs/SKILL_PROMPT_ARCHITECTURE.md) | SSOT 提示词装配流、数据注入防护与领域扩展沙箱 |
| **接口规范** | [RESTful & WS API 参考手册](docs/API.md) | 详尽端点契约、请求参数模型与状态码响应规范 |
| **前端体系** | [前端工作台架构白皮书](docs/FRONTEND.md) | React 18、原生 CSS Tokens、Zustand、拓扑白板与流式渲染 |
| **插件生态** | [业务扩展开发规范](docs/EXTENSIONS.md) | 模块化插件创建、自定义 Tool Manifest 与路由注册 |
| **业务工作流** | [任务编排与业务工作流](docs/WORKFLOWS.md) | 声明式任务拓扑、自动化批量任务编排与作业模板 |
| **生产发布** | [生产部署与集群编排](docs/PRODUCTION.md) | Docker Compose 编排、TLS 证书网关与集群高可用 |
| **运维保障** | [系统运维与应急处置 Runbook](docs/OPERATIONS_RUNBOOK.md) | 备份恢复、存储垃圾清理、安全应急演练与故障诊断 |
| **风险控制** | [变更审批流扩展](docs/APPROVAL_EXTENSION.md) | 关键配置写入操作的人工审批拦截、状态冻结与恢复 |
| **认知记忆** | [多层记忆子系统](docs/MEMORY_SUBSYSTEM.md) | 核心规则、经验案例、语义事实的分层存储与遗忘机制 |
| **租户安全** | [多租户与组织隔离](docs/TENANCY.md) | workspace_id 隔离、RBAC 角色权限与存储路径沙盒 |
| **未来演进** | [平台演进路线图](docs/PLATFORM_ROADMAP.md) | 长期功能规划、分布式架构演进与前沿特性展望 |

---

<p align="center">
  <b>联智中枢（LZCore）</b> · 赋能数字基础设施自主认知与精准运维
</p>
