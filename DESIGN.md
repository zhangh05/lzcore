# LZCore 设计边界

联智中枢让模型规划工作，让运行时核验和执行。模型可以组合工具、改变策略、委派独立工作和编辑图纸；这些能力受已发布 schema、调用方、工作区和领域资源范围约束。提示词辅助决策，不承担鉴权或执行隔离。

## 模型、运行时与界面

```text
HTTP / WebSocket -> AgentApp -> SSOTRuntimeEngine -> QueryLoop
    -> ToolRuntime.execute_node / ToolRuntimeClient.invoke
    -> executor / 扩展 -> store / evidence -> AgentResult
```

`TaskState` 是服务端任务状态，`AgentResult` 是对外结果投影。会话消息、作业、工具结果和回合日志各自记录不同事实，不能相互冒充。前端使用 Zustand 缓冲和呈现状态；浏览器的流式状态不决定服务端任务成功。

`execution_outcome` 评估用户目标，`tool_execution_outcome` 记录工具尝试。替代证据补全目标后，失败尝试仍留在记录里，但不必让整轮失败。外部写入未知要 read-back/reconcile；不能因超时或断线重放。进程重启后没有可对账资源的旧操作可进入账本 `indeterminate`，表示无法确认，不是成功。

## 工具治理

- `core/tools/canonical_registry.py` 发布工具；`core/tools/manifest_registry.py` 声明治理合同。能力目录只推荐，不注册、不授权。
- 模型编排经过 `ToolRuntime.execute_node()`；外部调用和审批经过 `ToolRuntimeClient.invoke()`。不能直接调 handler。
- 参数、调用方、workspace_id、策略和扩展范围在服务端检查；执行结果经过脱敏、审计及账本记录。
- `/api/tools/dry-run` 是策略和元数据预览，不执行 handler；工具调用级 dry_run 只在声明支持时生效，不支持则拒绝。
- Shell/PowerShell 在宿主机执行并拦截破坏性命令；Python 根据隔离配置使用本地子进程或 Docker。要求强隔离时，容器不可用就拒绝。部署配置见 [生产运行](docs/PRODUCTION.md)。

网络语义属于 `extensions/network_operations/`：注册设备和连接由发布 Skill 实时核定，设备账号决定最终命令权限。命令分类以服务端 `command_semantics.py` 为准，不能靠填写 action 伪装只读。可选审批在执行前冻结调用；决策结果回到原 checkpoint，不制造新的用户回合。

## 上下文与目标

生产提示词入口是 `core/runtime_engine/prompt_contract.py`。工具定义走 Provider 原生 tools 字段；会话历史、知识、记忆、工具输出是证据，不能改写权限。文本边界减少角色混淆，不保证模型一定拒绝注入；实际副作用必须由网关约束。

QueryLoop 逐轮维护目标、证据和缺口。`goal_loop`、`plan_goal_ids` 与 `runtime_recoveries` 关联恢复工作，运行时核对证据再关闭目标。持续有进展的普通回合不按固定总轮数或累计墙钟截断；单次调用超时、上下文容量、取消和无进展检测仍存在。详细规则见 [Loop](docs/LOOP_ENGINEERING.md)。

历史和工具正文保持完整，不静默丢弃；超过模型容量时返回结构化容量错误。局部绘图上下文和差量收据是有明确完整度标识的投影，不能冒充完整图纸。更多提示词约束见 [提示词与 Skill](docs/SKILL_PROMPT_ARCHITECTURE.md)。

## 图纸与真实设备

图纸是独立资源。`drawing:<topology_id>` Skill 只读写当前图；真实设备绑定是用户维护的外部关联，不进入绘图提示词。节点、连线、位置、区域、标签和样式均可由 LLM 编辑，布局辅助不替代直接坐标控制。

持久化图纸版本是编辑基线。工具提交成功广播 topology_updated；本地已保存画布按版本采纳，未保存编辑按三方差量合并或提示冲突。收据证明服务器写入，不证明渲染视觉或真实网络。对象契约见 [API](docs/API.md)，显示与交互见 [前端](docs/FRONTEND.md)。

## 数据与验证

数据访问使用已验证的 workspace_id 和当前 storage principal；文件、PostgreSQL 和对象存储不是统一的“物理目录隔离”。密钥优先进入系统凭据库，不可用时用 Fernet；明文不得进入源码、日志或普通记录。

记忆经过 MemoryWriteGate。用户规则、模型待确认提案、知识文档和当前观测具有不同权威，不能混用；详见 [记忆](docs/MEMORY_SUBSYSTEM.md)。

验收要对应声明：单元测试验证逻辑，浏览器验证交互，Windows 原生 smoke 验证打包程序，实际设备/模型任务验证外部效果。测试通过不能代替后三者。历史审查是当时证据，不是当前合同。
