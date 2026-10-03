# 运行时架构

本文用于定位实现，不重复设计原则。设计边界见 [DESIGN](../DESIGN.md)，端点见 [API](API.md)，运行控制见 [Loop](LOOP_ENGINEERING.md)。

## 调用链与所有权

| 层 | 实现 | 职责 |
| --- | --- | --- |
| 接入 | backend/main.py、backend/api/、backend/ws/agent_ws.py | 认证、工作区校验、HTTP/WebSocket 传输 |
| 应用 | agent/app/、agent/runtime/ssot_runtime.py | 会话、运行上下文、TaskState 与结果投影 |
| 循环 | core/runtime_engine/query_loop.py | 模型调用、计划、证据、goal_loop、runtime_recoveries |
| 执行 | core/tools/manifest_registry.py、core/tools/ | schema、caller、policy、executor、脱敏、审计 |
| 领域 | extensions/ | 业务对象、驱动、工具、路由和 UI 贡献 |
| 持久化 | storage/、artifacts/、jobs/ | 记录、制品、工作区数据、队列及生命周期 |
| 界面 | frontend/ | React、Zustand、交互与服务端状态投影 |

业务逻辑不得通过 backend 直接执行工具 handler。两个治理入口服务不同调用方，底层共享 manifest 和执行合同，不是两套授权。

## 模型请求装配

稳定系统提示和工具定义组成可缓存前缀；时间、任务、历史、Skill、证据和用户输入随回合装配。QueryLoop 的普通 planner、continuation、response 阶段使用同一生产提示词。辅助解释与记忆整理使用已注册模板，不替换生产工具循环。

Provider 适配保留其支持的协议块供当前循环继续推理：Anthropic content/thinking/signature，兼容协议 reasoning 字段，以及 MiniMax 累积流处理。公开 stage_outputs 只保存公开模型文本，不能用于重建未公开的推理。输出截断时未完成的工具 JSON 不执行，下一轮需重新发完整调用。

## 实时与记录

`/ws/agent` 接受 ping/message/resume。可重放帧先落入会话 turn_logs，再按 seq 发送；resume 读取已保存序号之后的帧，不创建工具执行。幂等重定向、认证错误、resume_pending 等控制响应不占正文序号。

turn_logs 记录回合帧，session job 记录阶段，会话消息/run 记录终态和证据。三者是不同投影；启动和周期收尾修复缺失终态，记为中断，不补造成功或重跑未知写入。topology_updated 只广播资源 ID 与版本；job_updated 是任务快照。

Agent 会话 SSE 路由已注册，但没有接入运行时生产者。其他 SSE 功能不受此限制。不要把它作为与 WebSocket 等价的续流路径。

## 数据与部署

默认文件记录和文件锁队列；生产 profile 可使用 PostgreSQL、S3、Redis 队列及事件总线。仍使用文件的数据需要共享卷和可靠锁，不能仅增加进程就声称支持任意多节点。生产 Compose 配置 `LZCORE_EVENT_BUS_MODE: redis`。

系统凭据库优先；Fernet 是回退存储方案，不代表所有环境都只靠环境主密钥。任务恢复、备份和资源删除走 store/API 生命周期，不能清目录模拟完成。配置与发布检查见 [PRODUCTION](PRODUCTION.md)。

## 工具中间证据的保留

扩展工具通过注册契约 evidence_retention 声明中间结果保留方式（durable 为默认，turn 为当前回合）。QueryLoop 将完整且脱敏的结果放入证据账本；turn 不额外生成 FileStore 任务产出文件，不限制工具完整读取、模型上下文或正式导出。网络拓扑工具声明 turn，图纸与修订仍由领域存储持久化。其他工具的大结果默认仍保存为 tool_evidence。

再次使用 turn 工具时，按当前主体和工作区清理此前自动生成的缓存：只匹配 runtime_tool_evidence、tool_evidence、隐藏标记和相同 producer_id，且必须有已结束的运行记录、未晋升、未复用的独占文件。运行中、未知/待审批、缺失结束记录、知识引用、正式报告和用户文件均保留。沿用产出删除流程解除运行索引和文件引用，保留执行历史；不会扫描或批量删除工作区中的其他文件。
