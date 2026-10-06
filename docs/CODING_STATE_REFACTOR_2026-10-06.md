# Coding 状态合同重构核验：2026-10-06

本次按五项 P0 建议重构状态合同，保留模型的实现、规划和纠错选择。真实模型压测按用户要求停止；以下回归不代表 NOC、RTS 已完成业务验收。

## 已实现

| 问题 | 当前合同 | 关键源码 |
| --- | --- | --- |
| Candidate 状态组合复杂 | `CandidateState` 显式事件转换、证据引用、修订 CAS；候选源码、验证结果和执行资源事实封存，后续修订生成新身份 | `agent/runtime/durable/coding_state.py`、`storage/coding_state_store.py` |
| Resume 依赖文本猜测 | UI 读取当前 TaskState，传递 `resume_task_id`；HTTP、WebSocket 与运行时复核同一主体、工作区、会话和可恢复任务；缺失字段才走原自然语言 fallback | `backend/core/agent_contract.py`、`agent/runtime/task_state.py`、`frontend/src/pages/AgentWorkbench/components/TaskResumeControl.tsx` |
| 大型任务阶段事实随历史漂移 | Project/Phase 记录任务、依赖和候选/评审引用；按修订链末端计算当前候选，保留旧记录；模型每次调用获得变化后的事实，声明文本仍属于非可信任务数据 | `agent/runtime/durable/coding_project.py`、`core/runtime_engine/loop_model.py` |
| QA 与 Task 耦合 | Candidate 保存输出与发布状态，Review 保存精确候选绑定、判断和实际检查，Task 保存 worker 执行状态；已有 Task 字段保留为兼容投影，不能授予 QA 或整合成功 | `agent/runtime/durable/coding_reviews.py`、`agent/runtime/durable/coding_team.py` |
| 失败直接被归咎模型或框架 | 统一 `runtime.failure.v1` 观察分类，覆盖失败工具、Provider 尝试、验证、资源清理及持久化边界；未识别错误明确为 unknown，根因默认 unresolved | `core/runtime_engine/failure_attribution.py` |

阶段事实提供状态记录，不代替模型决定计划、调用节奏或回复格式，也不推断整项目业务完成。显式恢复目前选择该会话当前持久 TaskState，不是任意历史任务选择器。

## 安全恢复与独立核验

- 评审对象绑定候选完整源码指纹和变更指纹；并行 reviewer 的失败不能被另一个 PASS 覆盖。新的显式复核批次保留旧批次历史。
- 发布未收到确认时只核对事务日志和实际文件；全部为发布后内容才确认整合，全部为发布前内容才确认未应用，混合或外来修改保持未知，不重放写入。
- Project 索引失败记录为观察事实，不改写 worker 结果；只读投影可以发现已有封存对象，不能启动任务或执行工具。缺失证据明确显示不可用。
- 会话永久删除级联清除三类对象，并用同一会话锁和 tombstone 拒绝迟到写入。存储损坏不能默认为空记录。
- `scripts/benchmark_team_acceptance.py` 独立读取 Candidate/Review 与事务证据，核对所有接受评审、精确检查、完整源码树及实际发布结果；没有降低检查条件。这仍不等于应用业务验收。
- 401 记录认证拒绝，不推断密钥过期；HTTP 400 或应用构建失败不直接推断模型能力。历史报告没有被改写。

## 本机验证

| 验证 | 结果 |
| --- | --- |
| 全后端 `pytest -q harness` | 2284 通过、11 跳过 |
| 前端单元测试 | 408 通过，77 个文件 |
| 针对状态、项目、独立整合验收与归因的回归 | 108 通过（包含于全后端结果） |
| 浏览器刷新恢复、持久化、未知结果、传输与工作台回归 | 7 通过 |
| 浏览器显式恢复按钮 | 刷新后读取任务身份，发送一次带精确 `resume_task_id` 的请求；异步跨会话状态由组件回归覆盖 |
| 生产构建、类型检查、样式检查、文档一致性、静态错误检查 | 通过 |

浏览器验证使用隔离本机数据和模拟模型传输，没有调用真实模型。故障注入覆盖并行 CAS、评审记录落盘失败、丢失发布确认、外来源码修改、阶段索引滞后、父任务作用域和删除后的迟到写入。

## 发布边界

v3.3.15 tag 固定于 `de3064c85d37b7238c5a14b575a9aaa08d9b76c7`。原发布包已经完成该提交对应 CI、原生启动/安装验证及包摘要核对。用户随后授权保持 tag、从 main 重建 Release 包并加入本次 P0 重构：重建包的真实来源以 `windows-update.json.source_commit` 和 Release 说明为准，不能用 tag 指纹代替包指纹。新包必须另行完成该源码提交的 CI、Windows 原生验证和资产核对，不能复用原发布包的通过结果。同版本重建不触发应用内版本升级提示，需重新下载并安装或替换程序目录，保留用户数据。
