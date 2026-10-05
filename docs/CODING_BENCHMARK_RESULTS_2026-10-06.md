# Ling-3.0-flash 大型工程压测（进行中）

目标是 NOC、RTS 各一轮，出现框架问题后修复再从零重跑。完整需求合同保留，基本功能、完整独立验收和视觉质量分别记录。tag、Release、Windows 下载包及服务器均不在本阶段更新。

压测使用 custom / Ling-3.0-flash / openai_compatible，单次输出预算在独立压测进程内为 8192；生产设置保持 4096。真实连接前置检查 READY。实现、准确候选 QA 和整合必须由实际 LZCore Coding Team 完成；不由压测者代写应用。专用 Lima VM lzcore-bench 复用现有镜像，只有 /tmp/lzcore-strict-workspaces 共享，工程容器没有仓库、Evaluator、宿主 HOME、凭据或 Docker Socket。

## 已结束的诊断轮次

NOC `large-20261006-ling-noc-1`：workspace `bench_noc_1bab5feb20`、session `bdfd87eb11cf4771`，基础源码提交 ee4229972267e2b10829f80de8ff9b464ecc7369。容器镜像 sha256:e15481d76d029df08e1897c0e6452e4b0ae12c0e3fd747483852ccd0f2aa1beb。报告目录保留在该轮次 reports 下。

- 实际 84 次模型调用；没有建立实现/QA 委派，没有 integrated 候选，正式工程没有源文件。
- 已发布目录确实包含 agent.manage 的 spawn/start/get/status/cancel/merge，以及 coding_agent/frontend_agent/qa_agent 和 coding_assignment。运行时身份也包含 source_mode=coordinator，用户完整请求明确要求委派。模型仍先尝试在只读父工程写文件、重新挂载，再在 /tmp 创建临时工程及尝试复制回父工程。只读策略拦截正确，不能为得到成功而赋予协调者写权限。
- 73 次 Shell 调用退出成功、2 次失败、1 次 workspace.file 写入被拦截。部分成功仅因为 Shell 最后 echo 或管道尾部退出 0，stderr 仍含真实失败；工具成功不是应用交付。
- 又发现真实框架缺陷：执行包装器、ToolExecutor、模型工具结果投影以及上下文归档的通用路径脱敏，会将容器内有效 /tmp 引用换成占位符。它会干扰后续检查和恢复，但不能解释模型从最初就没有遵循团队流程。保留混合原因，不把本轮归结为纯模型能力不足。
- 操作员停止无效偏离运行，最终 verdict 为 FAIL；独立业务验收没有执行，不能声称应用功能失败已逐项覆盖。协调者容器、网络和委派清理均确认完成，未知写入没有重放。旧入口的 SIGINT 抛出 KeyboardInterrupt，缺少完整 Agent 回合结果；原日志、操作账本、上下文归档和 operator_control.json 均保留。

## 框架修复和验证

路径公开例外由正在运行的服务端 DockerProjectEnvironment 绑定决定，不能来自模型参数或工具自报 isolation_level。仅 exec.run 的容器输出与相应原生调用/工具消息保留合法 tmpfs 引用；context_read 可回查同一证据。用户/系统消息、宿主绝对路径、越界路径、其他工具和凭据仍脱敏，关闭绑定不获得例外。原有源码所有权、schema、policy 和工具执行治理均保留。

真实专用容器验证经 ToolRuntime 执行、模型消息投影、窗口切换归档和受治理 context_read 回查，确认 /tmp 操作引用完整往返、宿主路径和合成凭据脱敏、清理完成。早期验证发现底层 Shell 包装器也先行脱敏，继续修复该实际调用链后才通过；不能只凭单个 redactor 单元测试宣称修复。

Benchmark 操作员信号现在接入既有 runtime cancel_check，按正常回合持久化、委派收尾和容器清理流程退出；operator_cancelled 与 deadline_reached 分开，取消不是能力通过。

原 Shell 测试只搜索源码中的脱敏赋值语句，改为执行真实子进程，确认 28000 字符非敏感输出完整、宿主路径和合成凭据被脱敏。团队请求等待测试不再要求工作线程必定在 10 ms 内完成准备，改为在返回同一 running/deferred 句柄后同步验证 worker 进入并保持存活，保留真实生命周期断言。

这一阶段后端全量 2116 通过、11 跳过，文档一致性与 CI 使用的 Ruff 检查通过；容器往返验证 PASS 并确认清理。前一提交 ee42299 的 GitHub CI 37351870465 全部九项成功，不能外推为本阶段新增源码的 CI 或大型业务验收。

本记录不是最终压测报告。修复后 NOC、RTS 的模型表现、源码指纹、准确候选 QA、整合、启动、独立行为验收、可操作性与清理将在各自实际完成后补充；未生成源码或未验证的项目不计通过。
