# 真实 Agent 编码压测

`scripts/run_coding_benchmark.py` 通过生产 `AgentApp.submit_user_message`、QueryLoop 和 ToolRuntime 调用当前配置的真实 Provider。脚本不会复制凭据，不 mock LLM、不直接调用 handler、不替代 Agent 写应用。测试数据与工程放在单独的临时存储；不会更改用户工作区或开启通用私网/JavaScript 执行开关。

## 可重复运行

```bash
.venv/bin/python scripts/run_coding_benchmark.py --case counter --port 18731 --deadline 900
```

`counter` 验证工程创建、测试/构建和真实浏览器交互。`noc`、`rts` 是用户提供的大型网络控制台、RTS 要求的核心功能整理，保留经济/状态/故障/寻路/战斗等行为要求，不是原文件逐字副本；夹具另要求独立验收接口。它们是挑战任务，不能假设当前模型必然完成。

使用 `--output` 指定独立存储和报告目录，`--workspace-id` 指定测试工作区。恢复需显式提供同一 `--output --workspace-id --session-id`，可用 `--prompt` 提供事实反馈。新任务先检查端口空闲；恢复时仍需确认原服务属于测试工程。显式 deadline 发起取消，Provider/工具正在执行时可能延后收尾，不是强杀进程。

报告保存提示词与 SHA256、Provider 类型/模型/参数来源、Git 提交、已跟踪差量和未跟踪工程源码指纹、脱敏事件、结果及墙钟时间。`runtime_ok` 仅表示 Agent 回合结果，不表示应用满足任务。多次 Provider 请求的累计输入用量包含重复上下文，不能直接当作独立任务规模。

## 独立验收

```bash
.venv/bin/python scripts/evaluate_coding_benchmark.py --case counter \
  --project /tmp/benchmark/storage/bench/files/data/counter \
  --origin http://127.0.0.1:18731 --report /tmp/benchmark/independent.json
```

验收器不会修改生成应用。生成应用的 `npm test` 与生产构建单列记录，不能代替独立行为验收。Counter 独立浏览器检查 20 次加减、零下限、重置、刷新持久化和页面异常。NOC 单列清点库存、推进模拟、压力库存；RTS 独立引擎检查同 Seed/时间推进、可观测状态保存恢复、完整 Fog 保存与 100v100 的 10 秒模拟；单项有 30 秒墙钟限时。这不证明编队、choke、完整 AI/科技或长时间稳定性。RTS 和 NOC 页面启动检查单独标记 `browser_boot_only`，不能证明所有业务或游戏玩法。

完整大型基准逐项记录 PASS/FAIL/NOT VERIFIED。不能把自编测试、文件数、框架回合成功、截图或启动成功当作全部需求验收通过。未执行的功能和性能仍是 NOT VERIFIED。临时预览进程完成后按已核实的工程 PID 清理；不会终止用户既有服务。

## 框架回归

工程源文件原子创建、目录/主体归属、存在即拒绝覆盖、主/子 Agent 治理一致性见 `harness/test_workspace_source_creation.py`；新鲜观察、状态修订与显式纯计算复用见 `harness/test_observation_freshness.py`；精确预览授权、会话隔离、真实错误/网络观测和生命周期上限见 `harness/test_browser_preview_access.py`。Provider 错误安全诊断见 `harness/test_runtime_recovery_hardening.py`。
