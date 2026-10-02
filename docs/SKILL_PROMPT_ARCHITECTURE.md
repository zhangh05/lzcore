# 提示词与 Skill：装配、权威和维护

生产工具回合的唯一静态合同在 `core/runtime_engine/prompt_contract.py`。
本文解释真实装配路径；工具参数以发布 schema 为准，权限以运行时和扩展为准。

## 来源与用途

| 来源 | 注入路径 | 用途 |
| --- | --- | --- |
| RUNTIME_SYSTEM_PROMPT | QueryLoop 系统消息 | 通用身份、工具使用、目标、证据、回答 |
| 原生工具定义 | Provider tools 字段 | 函数名、参数、动作和结果绑定合同 |
| TrustedPromptItem | runtime_guidance | 服务端时间、状态、附件、Skill、目标等指导 |
| 网络 Skill | extensions/network_operations/skill_prompt.py | 设备范围、命令与配置工作流 |
| 绘图 Skill | extensions/network_operations/topology_skill.py | 当前图纸、选区、编辑及几何合同 |
| 辅助模板 | prompts/registry.yaml、prompts/templates/ | 解释、知识问答、结果摘要与记忆提案 |

生产消息顺序是：runtime_identity、conversation_history（如有）、governed_context（如有）、可信指导、current_user_request。稳定前缀不包含本轮历史、当前时间或选区。动态状态必须保留真实数值，不能为了缓存固定它们。

只有服务端创建的类型化 TrustedPromptItem 能进入可信指导。其内部的设备名称、图纸描述、Skill 自有说明仍可能来自用户；嵌套数据标识不能把这些文字提升为系统政策。外部文档中的指令不授权执行工具。

## 数据边界的作用和限制

保留提示词专用标签时，对插入数据中的同名开闭标签进行转义，避免伪造 current_user_request/runtime_guidance 等边界。普通 `<`、`>`、`&`、管道和 CLI 文本不被全部 HTML 转义，避免破坏技术语法。

模板先解析作者写的语法，再替换数据，插入的 `{{...}}`、`{%...%}` 保持字面内容，不进行二次渲染。解析器支持变量、简单 if/else、列表 for 和 allowlisted summary_only/upper 过滤器；不是 Jinja2，也不执行 Python 表达式。无效模板明确失败，不选用另一个任务模板。

辅助解释模板的固定规则放在 system 消息，provided_context 与 current_user_request 放在 user 消息，当前请求不重复注入。记忆反思单独提供 system 合同和 JSON experience payload。模板的完整 render 文本仍可由 API 检查。

这些做法减少角色混淆，**不构成模型侧绝对隔离或安全保证**。权限、路径、调用方和实际执行必须由治理代码核验。脱敏也是独立链路，不能靠一句“不要输出密钥”保证安全。

## 能力、效率和准确性

- 通用系统提示只保留跨领域规则；网络配置、绘图坐标和区域归属放在对应扩展。规则明确一次，动态反馈只补当前缺口。
- 能力手册帮助选工具，不过滤工具、不替代模型规划。保持原生 schema、直接坐标、设备增删、连线与完整读取能力。
- 当前选区使用服务器校验的对象和邻接。局部上下文显式标注完整度；需要缺失事实时使用局部/完整 read，不把部分图当整图。
- patch 默认差量收据减小整图重复输入，完整 read/response_detail=full 保留。一次成功收据足够时不额外重复读取；冲突、未知写入和缺失基线才对账。
- 历史、记忆正文和普通工具结果不静默截断；上下文预算用于容量判定和统计。超过供应商容量返回结构化错误。
- 模型配置由 provider 配置解析，QueryLoop 不覆盖温度。Prompt 改写不能暗中启用更昂贵的思考或缩小工具面。

缓存信息在 `agent/llm/prompt_assembly.py`：稳定系统提示和工具定义指纹、动态层估算、Provider 缓存策略及 usage。Anthropic 显式缓存、OpenAI 自动缓存、兼容端点的实际支持不同；前缀相同不保证所有 Provider 命中。诊断只记录指纹和统计，不记录原始私密提示。

## 辅助任务的输出合同

| task | 回答依据与输出 |
| --- | --- |
| assistant_chat | 非工具对话；不模拟实时观测 |
| response_compose | 终态/覆盖/复核/未知写入；自然答复 |
| context_qa | 同一上下文的追问；历史不冒充新检查 |
| result_summarize | 保留执行、恢复和覆盖状态 |
| job_failure_explain | 最后确认阶段、原因证据和重试安全性 |
| artifact_summary_explain | 来源、范围、完整度；不冒充已读全文 |
| report_summary | 采样时间、失败与未覆盖对象 |
| manual_review_explain | 对象、原因和可关闭复核的具体检查 |
| knowledge_answer | 只用 knowledge_hits；引用 artifact_id/chunk_id |
| memory_consolidation | JSON 操作数组；待确认提案、不设任意条数上限 |

模板注册版本用于诊断，不是产品版本或 Git tag。max_context_chars、Top-K 等不同设置职责不同：模板预算不裁数据，检索策略仍可选择相关命中，供应商容量仍受限制。

## 改写与验收

1. 先查实际调用点，区分生产系统、动态指导、工具 schema 和辅助模板。
2. 保留授权、未知写入、任务追踪、完整度和引用规则；不以删能力换短文本。
3. 核对同名对象、失效选区、版本冲突、截断调用、历史追问、部分成功和提示注入边界。
4. 运行提示词/绘图/记忆契约测试及文档校验；变更 Provider 请求形状时检查缓存和协议测试。
5. 记录静态字符/估算 token 变化；真实 LLM 的首轮成功率、修正次数和任务耗时需要同模型同任务样本评估，不能由文本变短推断。

现行入口见 [文档索引](../README.md)，网络与图纸字段见 [API](API.md)。
