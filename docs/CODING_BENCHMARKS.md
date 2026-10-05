# 真实 Agent 编码压测

`scripts/run_coding_benchmark.py` 通过生产 AgentApp、QueryLoop 和 ToolRuntime 调用当前真实 Provider。凭据按正常配置解析，不复制到工程容器、报告或临时测试配置。测试工程、会话及数据使用独立存储；不能用宿主受信任 Shell 冒充严格 Benchmark。

## 准备隔离运行环境

先在专用 Docker daemon 构建 `scripts/coding-runtime.Dockerfile`；构建上下文只放该 Dockerfile，不发送框架仓库。镜像只包含 Node/Python 运行时。服务端通过 `LZCORE_CODING_EXECUTION_IMAGE` 指定镜像（默认 `lzcore-coding-runtime:local`），启动时记录不可变 image ID。Docker CLI 默认从 PATH 查找；`LZCORE_CODING_DOCKER_COMMAND` 可指定 JSON argv，用于明确的本地 VM 客户端。该设置不是模型工具参数。

使用 VM/远程 daemon 时，`LZCORE_CODING_DOCKER_HOST_ROOT` 与 `LZCORE_CODING_DOCKER_GUEST_ROOT` 必须同时指定。VM 只能共享本轮 scratch 根，不能共享仓库、用户 HOME、Evaluator 或 Docker Socket。`--output` 必须位于该 scratch 根内。系统隔离不可用时拒绝运行，不回退宿主。

```bash
.venv/bin/python scripts/run_coding_benchmark.py --case counter --port 18731 \
  --output /tmp/lzcore-strict-workspaces/counter-round-1 --deadline 900
```

新任务检查端口未占用。恢复明确提供同一 `--output --workspace-id --session-id`，可用 `--prompt` 给真实失败反馈；旧容器及其所有后代必须已确认清理，新回合重新启动隔离环境。deadline 发出服务端取消；报告另外核验进程/网络/broker 清理，不把发出取消等同于清理完成。

每轮先通过生产 Provider 传输执行一次不带工具的连接探测，再启动隔离环境和工程任务。`preflight.json` 只记录公共厂商/模型、HTTP 状态与稳定阻塞类别，不保存凭据或响应正文。401/403、限流/额度、缺失配置或探测异常会产生 `status=BLOCKED` 的 `verdict.json` 并以退出码 2 结束；这表示工程任务尚未开始，不能统计为大型工程生成失败或通过。前置请求被接受只证明连接可用，不证明后续带工具请求、工程质量或业务验收成功。

`counter` 检查工程创建、测试、构建与真实浏览器交互。`noc`、`rts` 保留大型任务的业务、故障、经济、寻路与战斗要求，并声明独立验收 API。它们是挑战任务，不保证任意模型一定完成。测试脚本不得代替 Agent 实现应用，失败也不能通过降低合同变成 PASS。

## 独立验收与团队验收

运行脚本在项目容器仍存活时自动调用独立 Evaluator。生成工程的 npm test/build 在项目容器内执行；RTS 引擎和它的编译器在另一个无网络、只读工程挂载的 QA 容器中执行。可信宿主验收器只通过有大小和时间限制的 JSON RPC 接收观测，持有断言和随机场景；生成代码不能修改断言或读取验收程序。实现 Agent 看不到 Evaluator；宿主 Python/Node 不导入生成应用或它的依赖。

Evaluator 的独立调用必须提供服务端已建立的容器身份、镜像 ID、容器内工程路径及精确 loopback 预览，不能指定任意宿主工程执行。`--rounds` 默认 3（1–10），`--seed` 可重放随机目标/场景。生成应用的测试和生产构建独立单列，不代表业务正确。

| 类型 | 独立检查 |
| --- | --- |
| Counter | 20 次加减、零下限、Reset、刷新持久化、浏览器异常 |
| NOC | 50/300/80 基线库存、模拟推进；随机接口计数器/速率有效性；noBuffers/CRC/低带宽 HighPPS；告警去重/确认/恢复；实际依赖根因；配置修改/行 Diff/回滚/审计；viewer 服务端写权限；100/1000/500/10000 压力规模 |
| RTS | 随机 Seed 和 tick；保存恢复、完整 Fog；100v100 真实伤害/死亡及性能；200 群移/队列/性能；保存后的 RNG/AI/命令确定性接续；300 秒队列、投射物及死亡引用清理 |

检查只证明表内具体命题。NOC 全部图表、RCA 场景、进程重启与 UI 重连，以及 RTS 全部 choke/编队/AI 经营/科技/胜败，仍需独立逐项验证；不能把界面启动说成全部业务/玩法验收。`scripts/benchmark_coverage.py` 维护实际命名检查和未覆盖需求，Evaluator 与最终 verdict 共用这一份范围核对。验收记录缺失、任务类型不符、检查遗漏/重复、未知检查、非法状态或任一检查失败均不能通过；报告内自报 PASS 不能覆盖这些事实。

现有 NOC、RTS 命名检查即使全部成功，也只能得到 `INCOMPLETE`，保留 `full_benchmark_acceptance=NOT VERIFIED` 和具体 `unverified_requirements`；少于三轮还会标出稳定性验证不足。新增独立行为检查并完成完整合同之前，不得清空未覆盖需求。Counter 的三个命名检查覆盖其有限合同，仍可在回合、团队门禁和清理全部通过后得到 PASS，不能外推至大型应用。独立 Evaluator 的退出码分别为 PASS=0、FAIL=1、INCOMPLETE=2；运行入口仅在最终总体 PASS 时退出 0，前置认证阻塞单独退出 2。

配置 Diff 验收用实际替换、删除和新增内容重建原版/新版，不能只寻找一个添加标记；回滚审计必须来自本轮新增记录。发生写入响应丢失时先回查，拒绝覆盖不属于本轮的配置，回滚响应未知只读回查，不重放写入。

`--require-coding-team` 另外要求：同父任务/会话的真实实现任务，准确候选的独立 QA，验证命令真实成功，事务实际 integrated，父文件内容与已验候选一致。主 Agent 绕过团队直接重写父文件，或只声称合并成功，均不能通过。可用 `--prompt` 明确要求按该流程委派。

## 证据与回归

运行 Agent 时的 SIGINT/SIGTERM 接入同一 runtime cancel_check，回合结果记录 operator_cancelled，再按原流程取消委派和核验清理。操作员取消与 deadline_reached 分开记录，不把中止算成能力验收成功，也不重放未知写入。

报告保存脱敏提示词、Provider 公共字段、Git 提交、已跟踪差量/未跟踪源码指纹、事件、运行结果、独立结果、清理结果。`agent_turn_ok` 只是 Agent 回合/传输结果（旧报告字段为 `runtime_ok`）；最终 `verdict.json` 独立核定命名验收、团队门禁与确认清理，任何失败或未知清理都为 FAIL。累计 Provider 输入包含重复上下文，不是任务唯一内容规模。用户 output、凭据及配置不进入源码指纹目录。

`verify_benchmark_evaluator.py` 三个随机 Seed 证明生成引擎无法篡改宿主断言或读取验收程序，包含只读的 0600 源码。两种真实内核检查已加入 CI。

`verify_coding_isolation.py` 经真实 ToolRuntime 压测越界、符号链接、受限出站、后台后代超时及关闭后迟到调用。`test_project_changes_stress.py` 重复竞争整合，断点恢复、候选变化、QA 失败、身份跨越和取消另见 `test_coding_team.py`。310 轮窗口测试是确定性 Provider 与真实 QueryLoop/ToolRuntime，不是 310 次真实模型交付。

历史结果见 [2026-10-04](CODING_BENCHMARK_RESULTS_2026-10-04.md)，保留原失败与验证边界。本轮最终结果单独留证，不覆盖历史记录。

本轮架构、重复压力与真实模型结果见 [2026-10-05](CODING_BENCHMARK_RESULTS_2026-10-05.md)，包括失败、修复依据和未验证范围。

Ling-3.0-flash 后续运行及归因见 [2026-10-06（进行中）](CODING_BENCHMARK_RESULTS_2026-10-06.md)。
