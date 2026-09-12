# 架构边界

LZCore 的边界由执行链路而非页面或提示词决定：`backend/` 接收请求，`agent/` 建立会话与 runtime，`core/runtime_engine/` 运行 QueryLoop，`core/tools/` 执行受治理工具，`storage/` 与相应 store 持久化事实。

## 运行时

`SSOTRuntimeEngine` 以 `TaskState` 保存一次任务的受信任状态，并投影为 `AgentResult`、消息、事件和运行记录。浏览器、对话历史和工具输出只能提供证据，不能修改服务端解析的 Skill 范围或恢复目标。恢复目标用于要求模型继续补证，不设重规划次数上限。运行时没有整轮累计时间预算；单次外部调用自身的超时作为工具事实返回。

运行时不以 token 预算截断模型可见的会话、工具输出或证据。若 provider 返回未完成输出，QueryLoop 把已接收内容保留在同一会话中并继续生成，直到获得完整的模型答复或用户取消。运行中产生的认知状态只会作为新的受信任消息追加，绝不回写到早期历史；这保持因果顺序，也保留稳定前缀的 provider 缓存机会。超大已脱敏消息以制品持久化时，后续会话会读取同一制品正文；制品不可读会显式标记，不能把历史伪装成空文本。

## 模型协议状态与公开历史

`LLMResponse.protocol` / `LLMMessage.protocol` 仅用于当前 QueryLoop 的 provider 协议回传，不属于公开消息 metadata。Anthropic Messages 的原始 content blocks（包括 thinking、signature 和 redacted_thinking）按顺序保留；流式响应重组文本、思考、签名和工具参数。OpenAI Chat Completions 兼容路径保留原始 content、reasoning_content 与 reasoning_details；MiniMax 的 reasoning_details 流按其累计快照协议处理。工具调用、参数纠错和继续生成时保留相应 assistant 正文及协议状态。公开文本仍经过隐藏推理过滤和脱敏。

跨用户轮次的公开历史包含已保存的 stage_outputs 和全部已保存的工具摘要，不再二次限制为 8 条或 300 字符。阶段输出不是原生推理块，工具摘要也不是完整工具协议记录。

当前原生协议状态仅在进程内的连续模型调用中使用；尚未接入跨轮次持久化、审批 checkpoint 恢复或 OpenAI Responses API。它不会写入会话消息、浏览器存储或运行日志。provider、endpoint 或 model 切换时不转发不兼容的私有状态，仍保留公开正文与工具调用。不能将此实现描述为跨会话完整推理恢复；此类恢复需要独立的私有存储生命周期。

## 工具

受信任提示词正文、Skill 约束和子 Agent 的角色/输出契约不按字符预算裁切；结构化认知提示保留全部动作和原因码列表。来源校验、data_only 包装、脱敏和工具权限保持不变。模型容量限制不能通过悄悄裁掉这些约束解决。

`workspace.file` 的 read 动作默认返回完整文本，不再因超过 1 MB 拒绝；需要分段时显式指定 offset（零起始行号）和 limit（行数），返回 next_offset、has_more、total_lines。list 动作按名称排序并使用 offset/limit 分页，每页最多 200 项；目录变动时调用方应重新遍历。路径越界检查、二进制拒绝和写入目录边界不变。附件解析仍受格式与解析器资源限制，明确报错而非假装返回完整内容。

工具通过 `ToolRuntimeClient` 统一进入 manifest、调用方检查、Skill 范围、executor 和审计。通用工具由 canonical registry 管理；扩展工具仍须使用同一执行边界。网络设备命令没有平台危险命令策略或配置写入开关，设备账号决定实际命令权限。

`extensions/approval/` 是可选的外部决定扩展。Skill 的 `approval_enabled=false` 时不会改变工具路径；为 `true` 时，核心 `execution_interceptor` 边界在实际执行前生成扩展拥有的 prepared-operation 记录和完整 QueryLoop checkpoint。记录覆盖精确参数和服务端范围版本，界面批准后仍会重新核验，再通过 `ToolRuntimeClient` 调用；同一决策集终态后，服务端用原 call id 的完整结果自动恢复 checkpoint。这个扩展不包含命令危险度分类、自动回滚、TTL 或第二个模型循环。

## 恢复

QueryLoop 只对可恢复的只读观察建立证据目标。`plan_goal_ids` 只关联替代调用，运行时还会校验能力和资源目标；正向 evidence claim 必须来自成功、已终止的结果。运行时不以总轮次或累计墙钟结束任务，但会识别确定性无进展：同一终态工具提案再次出现、provider 明确拒绝相同请求、或处理器已声明所需证据不可得时，任务转为结构化 blocked，而非重复发送相同输入。blocked 从不代表目标完成，保留完整证据并可在外部条件改变后由新请求继续。写入、取消、Skill 范围外调用和写入结果未知都不会触发平台自动重试；完整工具结果始终交回模型决定下一步。平台保留经过完整合同校验的 `runtime_recoveries`；网络 CLI 语义纠错使用模型可读反馈，由模型在下一轮选择动作。

## 委派

子 Agent 是同一运行时内的委派回合，不是低权限旁路。profile 表示任务分工；子 Agent 继承父 Agent 的完整工具面。若父 Agent 选中了 Skill，服务端在创建时重新解析 Skill 并继承父会话当前设备与连接切片，随后由同一 ToolRuntimeClient 再次执行范围检查。子 Agent 没有累计运行时间限制，支持显式用户取消。

## 数据与界面

所有数据操作验证 `workspace_id`。Zustand 仅管理前端状态；服务端才是权限、任务状态和审计事实来源。WebSocket、SSE 与 HTTP 返回的结果均以 `AgentResult` 及对应的运行时记录为准。
