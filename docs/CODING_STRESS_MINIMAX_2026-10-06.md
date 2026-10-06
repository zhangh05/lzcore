# MiniMax-M3 大型工程压测续跑：2026-10-06

用户确认凭据恢复后重新验证真实请求，MiniMax-M3 / anthropic_messages 前置检查为 READY。保存配置单次输出 4096，首轮保持该值；后续 NOC 诊断仅在测试进程使用 16384，正常配置不改，实际请求被接受。凭据仅经正常配置解析在宿主 Agent 内使用，没有复制到工程容器或证据文件。完整 NOC、RTS fixture 均逐字保留并附加分阶段团队流程。当前没有完整大型业务 PASS。

复用专用 Lima VM，只共享 /tmp/lzcore-strict-workspaces。运行指定已有不可变镜像 sha256:343aee4bd516c3af0b0b27f35451f465020b057f12e9a87b0dc06c1dd4f5cebd，包含 Node 同版本头文件和原生编译工具链；不是旧 local 标签镜像。实际 coding/frontend/qa 角色、只读协调者、准确候选 QA、真实 merge 和独立 Evaluator 合同不变。

## NOC 首轮诊断

large-20261006-minimax-noc-1，启动源码 18aeb05f01912ee6a018ba36d130d8e7ccc12ca7，workspace bench_noc_ecb8c419e1，session 9477773750ab4bae，report 1d9b6a14ec。1108.57 秒，由操作员结束诊断；独立命名验收失败，完整业务未执行，委派/容器/网络清理均确认。

首个 coding_agent sub-04d6cb48 有 69 次记录的模型请求，留下 18 个源码文件（包含依赖锁文件）。依赖安装后，npm test 仍因没有测试文件退出 1，npm run build 因 Node 类型定义缺失 TS2688 退出 2。同一实现者得到真实检查反馈并继续纠错，但再次没有源码进展，最终 completion_repair_no_progress。还存在多套未验证的模块/导入一致性问题；没有独立 QA 或 integrated 应用，不能归结为单纯认证或框架环境故障。

协调者尝试新委派时发生 coding_source_contract_mismatch；原 get 已提供完整 assignment，拒绝保持了生成物合同。之后创建替代分支 sub-08d7c970，4 次模型请求、0 源文件，随后由操作员取消。取消控制准备时最后观察到首实现者已失败，但替代分支在信号送达前启动，故不能将其取消记作模型主动取消，也不能宣称父回合自然结束。父 Agent 共 17 次记录请求，原候选全部保留。

## 发现并修复的框架合同

真实执行记录两次把 /workspace/files/data/noc 放入 exec.run.working_dir，被路径治理拒绝。此前编码交接的 tool_path_bases 把 exec.run 基准标为 container_cwd，而原生工具参数要求 workspace-relative；Benchmark 辅助协调说明也含糊。这是共同路径语义冲突，不能只归责模型。

b692a5c1471461dbe341062471fbe447fdf9b233 从服务端执行绑定生成唯一 tool_path_bases，主运行时提示与 coding/frontend/QA 交接共用。working_dir_basis/working_dir 表示工作区相对参数，shell_path_basis/container_cwd 表示命令内部路径。原 cwd 描述保持实际容器目录；正确参数可直接经治理执行，绝对参数仍拒绝且不自动转换/重放。后续辅助说明同步区分两者，不删除需求。

两个新增回归先复现交接缺口，修复后相关 146 项通过。后端全量 2219 通过/11 跳过；前端 404 项、生产构建、文档一致性与 Ruff 检查通过。真实独立内核控制通过受治理文件/exec 工具读取同一文件，验证默认/显式工作目录、错误绝对参数不执行、提示投影一致及清理。该控制不是生成应用 PASS。对应 [CI 37442107089](https://github.com/zhangh05/lzcore/actions/runs/37442107089) 九项全部成功。

另一个共同结果投影缺陷：首实现者的实际 errors 为 completion_repair_no_progress，但父任务 summary 统一写成 Subagent LLM call failed。后续修复复用现有 errors 生成失败摘要，不另造错误分类器；QA 仍保留准确结构化 verdict，未知结果与取消终态不改变。不得将实现停滞、认证、余额、QA 拒绝混为同一模型能力结论。三个新增反例先复现旧摘要问题，修正后相关 140 项通过；后端全量 2222 通过/11 跳过，文档一致性与 Ruff 检查通过；[CI 37443287452](https://github.com/zhangh05/lzcore/actions/runs/37443287452) 九项全部成功。

## 后续真实候选与运行时回归

NOC 同会话诊断 report 7e064dff87，源码 69e75c5、输出预算 16384。协调者先创建新候选 sub-1407cf8d，没有立即按指令继承原候选；新候选实际通过 npm test/build。随后 sub-bd37ab33 正确继承原 sub-04d6cb48 的 18 文件，但未通过检查。没有准确 QA 或整合，不能把这个过程算成原候选修订通过或重复稳定性通过。

其中 NOC 的 better-sqlite3 测试在 Statement 析构时以 RemoveEnvironmentCleanupHook / env != nullptr 崩溃。独立隔离控制不使用生成应用或 SQLite，只编译经典 ObjectWrap 模块，Node 24.21 镜像同样退出 134，确认共享运行时有缺陷；[Node 上游回归](https://github.com/nodejs/node/issues/65446) 也说明同版本头文件与运行时并不能排除它。其他源码、测试、类型依赖失败不能全部由这个问题解释。

RTS report 5312746772，源码 b692a5c、输出预算 4096。模型明确发出删除自己引擎源码的命令，反复重写，后来写入测试、页面和启动脚本。最终检查仍失败；没有准确 QA 或 integrated 应用。其 TypeScript/测试错误不被混为 NOC 的原生崩溃。

共享 Dockerfile 改为 Node 22.23.3 LTS 的固定版本与多架构摘要，保持完整原生编译工具链和隔离能力。新镜像为 sha256:28f719ca8f8af79cacbd36308697ec913dec4dfed5ed6c82098abc50846da722。新增经典模块 GC/退出探针，补齐原来仅用 N-API SQL 成功验证的缺口。最初探针每次分配都新建 ObjectTemplate，在 32 MiB 堆下产生 OOM，首次 Node 22 控制失败，记录保留；修正为正常的单一构造器后仍维持 300000 次分配和相同堆限制。修正探针在旧 Node 24 镜像仍复现原清理断言，在新镜像三次正常退出。最终三轮完整隔离验证全部通过，包括原生源码编译、SQL、只读源码、网络边界、构建快照、独立验收、预览转发及后代/容器清理。相关 73 项回归、文档一致性和改动脚本 Ruff 检查通过。这些是运行时验证，不是大型应用验收。

为应用经过验证的新镜像，操作员通过正常取消门结束两轮旧进程；NOC 1055.02 秒，RTS 2231.01 秒。当时仍有实现者在运行，取消属于操作员动作，不能记为模型自然失败。两轮独立命名验收 FAIL、完整业务 NOT VERIFIED；所有候选保留，委派、容器与网络清理确认。此前已归档首轮快照冻结，续跑证据分开，模型调用同时区分当前轮次和累计记录。

## 继续执行与边界

下一轮须在新镜像和最新源码上继续真实团队闭环，使用新端口和新报告。继承已知候选必须有明确修订来源，不把未知写入重放，也不把同会话修订算成从零稳定性复测。结束记录只归档已完成且清理确认的报告。

现有命名验收还保留 NOC 16 类、RTS 18 类完整覆盖缺口。缺少 integrated 应用时的验收失败不表示已经逐项测过这些业务。局部引擎、browser_boot_only、自测、CI、角色回合成功都不代替完整验收；阶段成功也不等于总目标完成。历史 Ling 和早期 MiniMax 401 失败不被覆盖，本批尚无完整 NOC/RTS PASS。

[结构化证据及实际源码指纹](CODING_STRESS_MINIMAX_EVIDENCE_2026-10-06.json) · [完整验收合同与覆盖边界](CODING_BENCHMARKS.md) · [共享执行合同](architecture/CODING_RUNTIME.md)。本批新修复仅提交到 main，既有 tag 与发布包不变。
