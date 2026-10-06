# API：入口、资源和续流合同

本地默认 http://127.0.0.1:8011；生产代理同源 /api 与 /ws/agent。公开方法由 backend.main.create_app() 注册，内部 handler 不作为 API。下表是资源导航，详细字段以路由/schema 为准。

工作区字段可位于 path/query/JSON/multipart，统一服务端核验；多处值冲突返回 workspace_id_conflict，不执行路由。identity 下还需有效主体。结构化结果与操作账本决定重试安全，不能只看 HTTP 状态。

## 服务、认证与 Agent

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health`, `/api/ready`, `/api/version` | Liveness, readiness and version projection. |
| `GET` | `/api/metrics`, `/metrics` | JSON and Prometheus metrics. |
| `GET` | `/api/auth/status` | Safe current-session projection. |
| `GET` | `/api/local-token` | Local browser bootstrap with Host/Origin checks; authentication-enabled modes return 404 `local_token_unused`. |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Password-session lifecycle. |
| `GET` | `/api/auth/oidc/start`, `/api/auth/oidc/callback` | Optional OIDC flow. |
| `POST` | `/api/agent/message` | Run one Agent turn. |
| `GET` | `/api/agent/sse/stream/<session_id>` | Registered session SSE; live runtime producer is not connected. |
| `WS` | `/ws/agent` | WebSocket agent stream. One connection can subscribe, send and resume. |
| `GET` | `/api/agent/status`, `/api/agent/usage` | Agent status and usage projection. |
| `GET/POST/DELETE` | `/api/agent/llm/config` | LLM configuration lifecycle. |
| `GET` | `/api/agent/llm/providers`, `/api/agent/llm/providers/<provider_id>` | Provider catalog/detail. |
| `POST` | `/api/agent/llm/providers` | Add a named vendor with an explicit protocol and server-generated identity. |
| `POST/DELETE` | `/api/agent/llm/providers/<provider_id>` | Provider save/delete. |
| `POST` | `/api/agent/llm/activate`, `/api/agent/llm/test` | Activate or test an LLM configuration. |
| `GET` | `/api/agent/llm/status` | Safe LLM availability projection. |

HTTP message 带 session_id 和 client_request_id 时，实际 Agent 运行绑定已认领的 session job：阶段事件更新该回合，取消检查读取同一作业。回合结束恢复原事件回调，过期回调不更新后续请求。HTTP 响应仍是整轮结果，不因此提供 token 续流。

HTTP `/api/agent/message` 和 WebSocket `message` 均接受 `metadata.resume_task_id`。工作台“继续任务”先读取当前会话的 TaskState，再显式传该 ID；任务身份按认证主体、workspace、session 核对，缺失、跨会话或已被新任务替换的 ID 被拒绝。SSOT 在执行前重新核对并用 revision CAS 开始同一任务。显式续接不判断请求语言；只有未提供此字段时才使用自然语言续接 fallback。字段不授权工具、不自动恢复子任务，也不重放未知写入。WebSocket `type=resume` 仍只恢复传输日志，与任务续接不同。

Provider 的有界空响应重试及候选回退耗尽后，返回 `llm_empty_response`，用户目标记为失败；QueryLoop 不再无限重发。输出截断走原有续接，未完成的工具参数不执行，不能把截断或空响应记为成功。

### WebSocket 与持久回合

/ws/agent 接受 ping、message、resume。message 发起一次请求，resume 带 workspace_id/session_id/client_request_id/stream_seq，只读取 seq 大于游标的日志帧，不重新提交消息或执行工具。done/error 也占正文序号，心跳不入日志。

可重放帧先写 turn log，再发送。失败返回 replay_persist_failed，不制造内存序号。日志按认证主体的会话目录保存，请求完整 ID 的 SHA-256 为文件键；读写在跨平台锁下刷新共享尾部。

- 幂等重定向指向原 client_request_id，只是控制，不是新回合终态、不占正文序号。
- 请求已接受但首帧未出：resume_pending，保留关联并等待。
- 未知/过期目标：resume_not_found，不开 worker，不重跑工具。
- 终态生产者日志不完整：replay_interrupted，按会话消息/终态对账。
- 恢复先确认服务端消息；已终态覆盖本地 streaming，未终态才按游标补缺口。

启动及每 30 秒幂等修复缺失终态，按请求串行，不重执行工具。终态日志在答复消息已持久化后可七天清理，内存缓存同步清除，登记标记 replay-expired；幂等登记仍有既有有界窗口。

流式脱敏缓冲未完整秘密前缀，再公开/落盘。Redis 通知保留 username，用进程实例 ID 区分来源；LZCORE_EVENT_BUS_MODE/URL 控制既有事件总线，队列设置是兼容回退。

topology_updated 仅带 workspace_id/topology_id/version；job_updated 合并最新快照。前者提示读资源，不把整图塞进帧；后者不作为正文。Agent 会话 /api/agent/sse/stream/<session_id> 已注册但未接运行时生产者，其他 SSE 不受影响。

## 运行时、上下文与辅助模板

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/runtime/summary`, `/api/runtime/health`, `/api/runtime/selfcheck` | Runtime catalog and health/self-check. |
| `GET` | `/api/runtime/tasks`, `/api/runtime/tasks/<task_id>` | Durable runtime task list/detail. |
| `GET` | `/api/runtime/sessions/<session_id>/task-state`, `/api/runtime/sessions/<session_id>/coding-projects` | Principal/workspace-scoped generic task and project/phase facts; requires workspace_id. |
| `GET` | `/api/runtime/tasks/<task_id>/events`, `/api/runtime/tasks/<task_id>/checkpoints` | Task event and checkpoint history. |
| `POST` | `/api/runtime/tasks/<task_id>/cancel`, `/api/runtime/tasks/<task_id>/resume`, `/api/runtime/tasks/<task_id>/checkpoint` | Task lifecycle control. |
| `POST` | `/api/runtime/tasks/<task_id>/steps/<step_id>/retry` | Retry a safe failed step. |
| `GET/POST` | `/api/runtime/tasks/<task_id>/audit-report` | Read/create task audit report. |
| `GET` | `/api/runtime/trajectories`, `/api/runtime/trajectories/<traj_id>` | Runtime trajectory projections. |
| `POST` | `/api/context/build`, `/api/context/resolve`, `/api/prompts/render` | Governed context/prompt operations. |
| `GET` | `/api/context/status`, `/api/prompts`, `/api/prompts/<prompt_id>`, `/api/harness/status` | Context, prompt and harness projections. |

### 任务结果与恢复

Agent, SSE, WebSocket and task-detail projections can contain server-generated
metadata. `execution_outcome` is the user-task result (`complete`, `partial`,
`failed` or `unknown`); `tool_execution_outcome` is the corresponding tool-attempt
result. `recovery_goals`, `recovery_goal_events` and `goal_loop` explain
goal-driven recovery when present.

A failed tool attempt alone does not determine the user-task result. `partial`
means some coverage is verified but required coverage remains blocked; `unknown`
means an external write or long-running work cannot yet be confirmed. Clients
must display these server values, not synthesize them.

`metadata.failure_attributions` 保存 `runtime.failure.v1` 观察：code/category/condition/stage/reference/detail/cause。工具失败、回合失败、已恢复的 Provider/只读重试失败均保留观察；未知错误归为 unknown，不强猜根因。`cause=unresolved` 不代表已证实模型或框架有缺陷。认证失败不等于密钥过期；HTTP 400、应用检查失败不等于模型能力不足。该字段不参与规划、权限、重试或验收。候选和评审记录另保存准确检查与资源事实的分类。

## 会话、运行与工作区

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/sessions` | Session list/create. |
| `GET/PUT/DELETE` | `/api/sessions/<session_id>` | Session detail/update/hard delete. |
| `GET` | `/api/sessions/<session_id>/messages`, `/api/sessions/default` | Durable messages/default session. |
| `POST` | `/api/sessions/<session_id>/archive`, `/api/sessions/<session_id>/restore` | Archive/restore a session. |
| `GET` | `/api/runs/recent`, `/api/runs/<run_id>` | Recent run list/run detail. |
| `GET/POST` | `/api/workspaces` | Workspace list/create. |
| `DELETE` | `/api/workspaces/<ws_id>` | Delete a workspace. |
| `POST` | `/api/workspaces/<ws_id>/rename` | Rename a workspace. |
| `GET` | `/api/workspaces/<ws_id>/state`, `/api/workspaces/<ws_id>/status`, `/api/workspaces/<ws_id>/history`, `/api/workspaces/<ws_id>/runs`, `/api/workspaces/<ws_id>/traces` | Workspace state/history/run/trace projections. |
| `GET` | `/api/workspaces/<ws_id>/runs/<run_id>`, `/api/workspaces/<ws_id>/runs/<run_id>/artifacts`, `/api/workspaces/<ws_id>/runs/<run_id>/trace` | One run and its evidence/trace projections. |
| `POST` | `/api/workspaces/<ws_id>/runs/<run_id>/report` | Create a run report. |
| `GET` | `/api/workspaces/<ws_id>/reports`, `/api/workspaces/<ws_id>/reports/<artifact_id>/content` | Report list/content. |
| `GET` | `/api/workspaces/<ws_id>/selfcheck`, `/api/workspaces/<ws_id>/storage/health` | Workspace checks. |
| `PUT` | `/api/workspaces/<ws_id>/settings` | Workspace settings. |
| `POST` | `/api/workspaces/batch-delete` | Explicit batch workspace deletion. |

Archive/retention routes are also workspace-scoped: `GET /api/workspaces/<ws_id>/archive/items`,
`/archive/preview`, `/archive/audits`, `/archive/audits/<audit_id>` and
`POST /archive/apply`, `/archive/restore`; retention has the analogous
`GET /retention/preview`, `/retention/audits`, `/retention/audits/<audit_id>`
and `POST /retention/apply` routes.

## 制品、知识、记忆与复核

Agent result metadata and persisted assistant-message metadata may include
`stage_outputs`: an ordered list of `{id, label, text}` containing public model
outputs from the turn. Clients preserve earlier stages as collapsible history;
`final_response` remains the authoritative final answer. Hidden reasoning is not
included. The field is optional for records produced by older versions.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/workspaces/<ws_id>/artifacts` | Artifact list/create. |
| `GET/DELETE` | `/api/workspaces/<ws_id>/artifacts/<artifact_id>` | Artifact detail/hard delete. |
| `GET` | `/api/workspaces/<ws_id>/artifacts/<artifact_id>/content`, `/api/workspaces/<ws_id>/artifacts/<artifact_id>/review-items`, `/api/workspaces/<ws_id>/artifacts/<artifact_id>/summarize` | Artifact content, review items and summary. |
| `POST` | `/api/workspaces/<ws_id>/artifacts/<artifact_id>/promote`; `/api/workspaces/<ws_id>/artifacts/upload`, `/api/workspaces/<ws_id>/artifacts/batch-delete` | Promote/upload/explicit batch delete. |
| `GET` | `/api/storage/overview`, `/api/storage/files`, `/api/storage/events` | Managed-file storage projections. |
| `DELETE` | `/api/storage/files/<file_id>` | Managed-file hard delete; metadata is returned by `/api/storage/files`. |
| `GET` | `/api/storage/files/<file_id>/content`, `/api/storage/files/<file_id>/preview`, `/api/storage/files/<file_id>/relations` | File content/preview/relations. |
| `GET` | `/api/knowledge/sources`, `/api/knowledge/search`, `/api/knowledge/chunks/<chunk_id>` | Knowledge sources/search/chunk. |
| `POST` | `/api/knowledge/upload`, `/api/knowledge/sources/from-artifact`, `/api/knowledge/sources/<source_id>/reindex` | Knowledge ingestion/reindex. |
| `GET/PATCH/DELETE` | `/api/knowledge/sources/<source_id>` | Knowledge source lifecycle. |
| `GET` | `/api/memory/status`, `/api/memory/list` | Governed memory projections. |
| `POST` | `/api/memory/search`, `/api/memory/write`, `/api/memory/confirm`, `/api/memory/reject`, `/api/memory/batch-delete` | Governed memory operations. |
| `DELETE` | `/api/memory/<memory_id>` | Memory hard delete. |
| `POST` | `/api/reports/create` | Create a report. |
| `PUT` | `/api/review-items/<item_id>` | Update a review item. |
| `GET/POST` | `/api/workspaces/<ws_id>/review-items` | Workspace review-item lifecycle. |

Artifact hard deletion removes the artifact's live references from both run records
(`artifact_refs`) and run artifact indexes before removing its metadata. Execution
summaries and traces remain as history. Missing references left by older versions
can be detached with `storage.run_artifact_store.remove_artifact_from_all_runs`
after verifying the artifact is absent and backing up the affected run records;
selfcheck continues to report other missing references.

## 作业

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/jobs` | Job list/create. |
| `GET/DELETE` | `/api/jobs/<job_id>` | Job detail/hard delete. |
| `DELETE` | `/api/jobs/batch-delete` | Explicit batch job deletion. |
| `POST` | `/api/jobs/<job_id>/cancel`, `/api/jobs/<job_id>/retry` | Cancel/retry. |
| `GET` | `/api/jobs/<job_id>/events`, `/api/jobs/<job_id>/logs`, `/api/jobs/<job_id>/artifacts` | Job evidence projections. |
| `POST` | `/api/jobs/worker/run-once` | Run one worker iteration (admin only in identity mode). |
| `GET` | `/api/jobs/worker/status` | Worker status (admin only in identity mode). |

Job deletion is hard deletion. The JSON body must contain the explicit
`workspace_id` and `confirmation: "DELETE <job_id>"`. Queued or running jobs
return conflict; cancel and wait for a terminal state first.

## 工具与扩展

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tools/catalog`, `/api/tools/permissions` | Canonical tool catalog/permission projection. |
| `POST` | `/api/tools/dry-run` | Side-effect-free policy and invocation metadata preview; it does not call the handler. |
| `GET` | `/api/capabilities`, `/api/workbench/skills` | Capability catalog and server-projected workbench Skills. |
| `GET` | `/api/extensions`, `/api/extensions/repository` | Installed extension and repository catalog. |
| `POST` | `/api/extensions/<extension_id>/enable`, `/api/extensions/<extension_id>/disable`, `/api/extensions/<extension_id>/migrate`, `/api/extensions/<extension_id>/uninstall` | Extension lifecycle. Mutating calls require loopback or an authenticated caller (`remote_admin_write_denied` otherwise). |
| `GET` | `/api/extensions/<extension_id>/quota` | Extension quota projection. |
| `POST` | `/api/extensions/repository/publish`, `/api/extensions/repository/<extension_id>/<version>/install` | Package publishing/install. |

`network.operations` owns its namespaced business objects:

| Method | Path |
| --- | --- |
| `GET/POST` | `/api/extensions/network.operations/regions`, `/api/extensions/network.operations/devices`, `/api/extensions/network.operations/connections`, `/api/extensions/network.operations/skills`, `/api/extensions/network.operations/scripts`, `/api/extensions/network.operations/inspections`, `/api/extensions/network.operations/topologies` |
| `PUT/DELETE` | `/api/extensions/network.operations/regions/<region_id>` |
| `GET/PUT/DELETE` | `/api/extensions/network.operations/devices/<device_id>`, `/api/extensions/network.operations/connections/<connection_id>`, `/api/extensions/network.operations/skills/<skill_id>`, `/api/extensions/network.operations/scripts/<script_id>`, `/api/extensions/network.operations/topologies/<topology_id>` |
| `GET` | `/api/extensions/network.operations/topologies/<topology_id>/overlay` |
| `GET/PUT` | `/api/extensions/network.operations/topologies/<topology_id>/annotations` |
| `PUT/DELETE` | `/api/extensions/network.operations/topologies/<topology_id>/nodes/<node_id>/binding` |
| `DELETE` | `/api/extensions/network.operations/topologies/<topology_id>/nodes/<node_id>` |
| `GET` | `/api/extensions/network.operations/topologies/<topology_id>/revisions` |
| `GET` | `/api/extensions/network.operations/topologies/<topology_id>/revisions/<revision_id>/edit` |
| `GET` | `/api/extensions/network.operations/topologies/<topology_id>/revisions/<revision_id>/diff` |
| `POST` | `/api/extensions/network.operations/topologies/<topology_id>/revisions/<revision_id>/restore` |
| `POST` | `/api/extensions/network.operations/connections/<connection_id>/test`, `/api/extensions/network.operations/inspections/<task_id>/cancel`, `/api/extensions/network.operations/inspections/<task_id>/retry` |
| `GET` | `/api/extensions/network.operations/inspections/<task_id>`, `/api/extensions/network.operations/inspections/<task_id>/evidence` |
| `GET` | `/api/extensions/network.operations/context` |
| `POST` | `/api/extensions/network.operations/references/<reference_id>` with `action=confirm|invalidate` |
| `DELETE` | `/api/extensions/network.operations/observations/<observation_id>`, `/api/extensions/network.operations/observations/batch-delete`, `/api/extensions/network.operations/references/<reference_id>`, `/api/extensions/network.operations/references/batch-delete`, `/api/extensions/network.operations/command-experience/<experience_id>`, `/api/extensions/network.operations/command-experience/batch-delete` |

Device, connection and Skill deletion are
their domain lifecycle operations; Skill selection is only an authorization
scope and performs no device I/O. `/context` only returns bounded source-labelled
history, references and advisory syntax outcomes; it performs no network I/O.
Inspection completion creates an Observation and may create a candidate
Reference. Only a complete candidate can be explicitly confirmed.

可选审批扩展的资源入口：

| Method | Path |
| --- | --- |
| `GET` | `/api/extensions/approval/operations`, `/api/extensions/approval/operations/<operation_id>` |
| `POST` | `/api/extensions/approval/operations/<operation_id>/decision` |

审批开关、冻结与恢复合同见 [审批](APPROVAL_EXTENSION.md)。

### 图纸选择、读取与修改

canvas_selection 含 node_ids/link_ids/group_ids/canvas_item_ids，服务端核对存在性，失效 ID 在 canvas_selection_unavailable，不复制客户端标签。用户原话单独传递。发送前确认本地保存，带发送时 drawing_version；保存响应丢失先读回，已提交则采纳，不确定则保留编辑并要求确认，不自动重放。

network.operations.topology 仅 read/patch。read 无范围返回全图；指定 node_ids/link_ids/canvas_item_ids 或 query 返回匹配子图，query 是名称/标签/ID 大小写不敏感子串，保留显式 ID。同名需确认后编辑。include_neighbors 默认 true，包含邻接、固定联动成员及区域。局部结果 snapshot_complete=false、缺失 ID 和全图 counts，不能替换完整画布。

自动选区上下文额外邻居最多 40 节点/80 链路；选中和联动成员保留。这只是自动上下文边界，显式局部/完整读取不受该限制。

patch 使用稳定 ID，保留未点名对象；旧显式 version 冲突，省略版本按锁内当前状态提交。未知链路端点原子拒绝；显式删节点同时删关联链路。默认收据含实际 changes（upsert/removed IDs/名称描述差量）、version/counts/changed/估算 feedback，snapshot_complete=false；response_detail=full 或 read 才取完整图。无变化保留版本且不广播。

- node_updates 控制属性/x/y，canvas_item_updates 控制位置/尺寸/内容，link 更新控制端点、接口和样式；节点 labels 保留。
- translate={node_ids?,canvas_item_ids?,dx,dy,include_members?} 相对移动；至少指定节点或图元。include_members=true 连同容器成员移动，默认只移动边框且关闭 auto_fit；固定联动组同步平移；显式成员坐标优先，清 lock_group 分离，删除/脱离清孤立组。
- layout 可选 grid/radial，支持 node_ids/preserve_node_ids/origin/spacing_x/spacing_y，间距至少 140。显式坐标优先，保护成员等于保护其联动组，组按刚体移动；前端自动布局也保留组相对位置和固定区域。
- 区域唯一身份是 canvas_items.item_id，节点 region_id 引用它，null 解除归属。名称仅用于展示，zone/group_id/group_updates/groups/zones/remove_group_ids 区域写入路径已移除；未知引用报错，不自动生成框。节点和图元 x/y 均为中心坐标。auto_fit=true 才按绑定成员包围；手工几何关闭 auto_fit，删除框解除成员归属。
- feedback 采用估算节点几何和有限重叠样本，完整度明确；不是视觉或真实网络验收。

页面基于最后确认基线三方合并。非重叠本地编辑可合并，同字段/删改/依赖链路冲突需解决。变更卡标显示/待处理、移除对象和差量，可聚焦/撤销；撤销保留后来无关字段，重叠则拒绝。卡片默认折叠，与对话分区；从后端有界 revision 恢复，保存结构与几何变化，保留最近 40 个版本。列表 activity 返回差量摘要、来源与时间；edit 只读接口按需返回 changed objects 的 before/after，供前端安全撤销，不替换整图。旧版本仅有快照的历史继续可读取/恢复，新增变化才有撤销差量。

容器/图元删除使用 remove_canvas_item_ids；保留设备和连线、解除成员区域关联。remove_node_ids 删设备及其关联连线。显式区域几何默认固定；auto_fit=true 才随成员包围，同名容器以 ID 区分。图纸改名同步绑定会话的资源元数据与自动生成标题，用户自定义标题保留。

### Provider 配置

Anthropic 接入模板不预填模型 ID，添加时填写当前账户或网关提供的模型；已保存的显式模型配置保持原值。

厂商身份与名称、协议独立。`POST /api/agent/llm/providers` 接受 `label`、`provider_type=openai_compatible|anthropic_messages`、`base_url`、`model` 和其余配置字段，返回 201 与服务端生成的 `provider_<uuid>`；同名或同协议可添加多家。GET 列表合并内置与已保存厂商，`templates` 只提供无密钥的接入默认值，前端不维护第二份厂商名单。保存、激活、连接测试、任务路由和实际生成共享这一配置目录。显式协议决定传输，不由厂商名称或地址猜测；旧配置缺少协议时兼容推断并在后续保存时写入。

列表和模板返回的配置必须包含有效的 `provider_type`。前端遇到缺失或未知协议时明确提示重启服务，停止显示和提交猜测的协议；不把旧后端缺少字段误显示为 OpenAI 兼容。更新本地代码后须先运行 `./stop.sh` 再运行 `./start.sh` 完整重启，单独运行 `./start.sh` 会复用仍在运行的后端进程。

厂商记录在 `LZCORE_CONFIG_DIR/providers`；未设置时使用仓库 `config/providers`。新增和已有记录使用同一密钥后端，API 不返回明文密钥或 secret_ref。新增厂商不借用其他厂商的环境密钥。连接测试可测试管理员的未保存协议/地址/模型/密钥草稿，`clear_api_key=true` 明确以无密钥测试；普通用户仍只能测试已保存配置。测试不保存或切换当前厂商。保存保留配置，激活切换当前厂商；显式关闭当前配置不会回退到其他厂商。DELETE 内置厂商恢复默认，DELETE 新增厂商移除配置及密钥；删除当前新增厂商返回 409，先切换后再删除。模型协议的本地 HTTP/SSE 合同检查不代表所有第三方厂商都已完成真实服务验收。

保存/激活支持 top_p=null 或 0<值<=1，null 省略请求字段；thinking=provider_default|adaptive|disabled。MiniMax-M3 使用 Anthropic Messages 思考配置，M3.1 拒绝 disabled。新 MiniMax 默认 temperature=1/max_tokens=8192，其他初始值 0.2/4096；既有显式值保留，QueryLoop 不另覆盖。配置改写不暗中开启思考或扩大模型窗口。

## 工作流、身份与管理

### 上下文接续与证据回查

QueryLoop 在完整工具交互边界建立模型窗口归档，原始用户约束保留，任务、目标与未知执行状态随新窗口继续。归档在当前主体/工作区/会话的 `sessions/<session_id>/context_epochs` 中持久化，包含 SHA256 与父归档引用；归档失败不会替换当前窗口，也不会重放工具。系统提示词、工具定义、输出预留和安全余量共同计入模型容量；单独的初始用户约束已超过容量时明确停止。

`system.manage(action=context_index, checkpoint_id?, offset?, limit?)` 未指定 checkpoint 时分页发现当前会话的归档，指定 checkpoint 时分页列出消息索引；`context_read(checkpoint_id, message_index, char_offset?, char_limit?)` 回查消息的明确文本范围，返回下一范围游标和校验值。调用方不能读取其他会话归档；归档内容是已脱敏的非可信历史数据，不是新指令。`char_limit` 为 1–32000，默认 8000。运行记录公开 `context_epochs` 和接续错误，不把窗口接续说成历史删除或完整业务验收。

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/workflows` | Workflow list/create. |
| `GET/PUT/DELETE` | `/api/workflows/<workflow_id>` | Workflow lifecycle. |
| `GET/POST` | `/api/workflows/<workflow_id>/runs` | Workflow runs. |
| `GET` | `/api/workflow-runs/<run_id>`, `/api/workflow-templates` | Run/template projections. |
| `POST` | `/api/workflow-runs/<run_id>/cancel`, `/api/workflow-templates/<template_id>/instantiate` | Cancel/instantiate. |
| `GET/POST` | `/api/identity/users`, `/api/identity/organizations`, `/api/identity/organizations/<organization_id>/memberships` | Identity lifecycle. |
| `PUT/DELETE` | `/api/identity/users/<username>` | User update/delete. |
| `GET` | `/api/admin/production`, `/api/admin/backups`, `/api/admin/operation-ledger` | Administrator projections. |
| `POST` | `/api/admin/backups`, `/api/admin/backups/prune`, `/api/admin/backups/<backup_id>/restore`, `/api/admin/operation-ledger/<operation_id>/resolve` | Verified administration actions. Mutating calls require loopback or an authenticated caller (`remote_admin_write_denied` otherwise). |

The operation ledger uses `planned`, `running`, and `unknown` only for records
that still have a live reconciliation path. On backend restart, an unresolved
record from the previous process without a durable linked resource becomes the
terminal `indeterminate` state. This preserves uncertainty for audit without
reporting the record as actively pending forever.

## 错误投影

应用定义的 API 错误返回 JSON，通常含 `ok: false` 和稳定错误标识；个别路由还会
附带安全的校验详情。调用方不应依赖未记录的错误详情字段。

```json
{ "ok": false, "error": "invalid_workspace_id" }
```

重试先核对执行状态、幂等和未知写入；不要把错误响应当作操作未发生。

## 补充入口

其余已注册入口如下；字段和授权以路由/schema 为准。

| Method | Path |
| --- | --- |
| `POST` | `/api/ecosystem/import/apply` |
| `POST` | `/api/ecosystem/import/preview` |
| `GET` | `/api/ecosystem/providers` |
| `GET` | `/api/workspaces/<ws_id>/archive/items` |
| `POST` | `/api/workspaces/<ws_id>/archive/apply` |
| `GET` | `/api/workspaces/<ws_id>/archive/audits` |
| `GET` | `/api/workspaces/<ws_id>/archive/audits/<audit_id>` |
| `GET` | `/api/workspaces/<ws_id>/archive/preview` |
| `POST` | `/api/workspaces/<ws_id>/archive/restore` |
| `GET` | `/api/workspaces/<ws_id>/jobs` |
| `GET` | `/api/workspaces/<ws_id>/jobs/<job_id>` |
| `POST` | `/api/workspaces/<ws_id>/retention/apply` |
| `GET` | `/api/workspaces/<ws_id>/retention/audits` |
| `GET` | `/api/workspaces/<ws_id>/retention/audits/<audit_id>` |
| `GET` | `/api/workspaces/<ws_id>/retention/preview` |

### 图纸批注

`GET /api/extensions/network.operations/topologies/<topology_id>/annotations?workspace_id=...` 返回 `{ok, annotations: {version, strokes, notes}}`。`PUT` 使用相同路径，JSON 中显式传 `workspace_id`、上次读取的 `version`、`strokes` 和 `notes`；成功后批注版本加一。版本冲突返回 409，缺少图纸返回 404，非法坐标、形状或过大内容返回 400。批注按用户和工作区隔离，独立于图纸版本；图纸硬删除时同时删除其批注。

区域存储 schema_version=3：旧 v1/v2 记录首次读取或启动迁移时先保存 topology_region_backups 原始备份，再把唯一可解析的旧归属转成 region_id。旧逻辑分组框转换为同 ID 的 canvas_items，旧左上角坐标转换为中心坐标。同名歧义或不存在的归属保持未归属，region_migration_issues 提示人工确认。只在迁移阶段解析旧名称；新写入不使用兼容身份。历史快照恢复也先迁移；旧差量撤销用完整快照补足区域上下文后转换，不把未变框的成员误判成无归属。groups 在旧响应结构中保留为空数组。并发删框与新增成员归属会提示依赖冲突；既有归属解除时保留独立的节点位置编辑。

feedback.regions 提供 members、unassigned_node_ids、missing_region_refs、outside_members、empty_region_ids、overlapping_region_pairs 和 identical_region_pairs；区域重叠和未归属可能是用户意图，不能自动当错误修改。所有几何反馈基于保守 140×110 节点范围，标题预留 24；真实文字宽度、连线路由和视口仍需渲染验收。区域感知布局保持固定边框与显式坐标，不足以容纳成员时不挤压节点。

区域重叠/相同几何 pairs 最多返回 50 对，同时返回 overlapping_region_count、identical_region_count 和 region_pairs_complete；计数不截断。

## Coding Team

`agent.manage` 提供 spawn/start/list/get/status/cancel/merge/reconcile。角色含 coding_agent/frontend_agent/qa_agent；角色提示不注册工具或授予权限。编码 spawn 必须带 `coding_assignment`：project_dir（files/data 下工程）、responsibilities（明确文件/目录前缀，`.` 为整个工程）、depends_on（同父任务前置 subtask_id）、validation_commands（1–12 个程序及字面参数）、review_subtask_id（QA 必需）。无领域 Skill 绑定的编码任务才可创建独立工程副本，不能静默扩大 Skill 范围。

`coding_assignment.phase_id` 可声明阶段归组，省略时按实现任务分配；QA 和源码修订默认继承目标阶段。Project 保存声明、依赖和 Task/Candidate/Review 引用，不生成计划或权限。`agent.manage(get).domain_state` 返回独立 candidate/review/project 事实。旧 `coding.phase`、QA/检查/资源/发布字段已删除，`coding` 仅含 `coding.assignment.v2` 执行参数；源码候选及发布由 CandidateState FSM 管理，QA 裁决、检查及资源由 Review 对象管理，Task 只表示 worker 生命周期。所有接受的并行 reviewer 都必须通过；一次 PASS 不能覆盖同批 reviewer 的失败。新显式复审保留旧记录。正式状态、事件、旧记录迁移与未知发布回查详见 `docs/architecture/CODING_RUNTIME.md`。

`agent.review` 是独立 QA 的裁决保存工具，输入 review 包含 schema=coding.qa_review.v1、verdict=pass/fail/unknown、scope、blocking_findings 和完整 report。仅 subagent caller 可调用，服务端核对活动 QA 环境与会话并绑定准确候选；实现者、父任务、其他会话及关闭环境不能代交裁决。它不修改或发布源码，最终文字回复可自由表达。缺少裁决或阻断发现仍不能整合，实际检查未知仍禁止重放。

`agent.manage(action="reconcile", subtask_id=...)` 对 EXECUTION_UNKNOWN 的实现或 QA 任务显式回查。当前调用必须属于同一父任务/会话；服务端核对停止的 worker、原 Docker daemon 的资源身份（含一次性验证容器）与候选源码摘要。回查成功将 Candidate 置为 review_incomplete，允许新的准确 QA 或源码修订；不重放旧调用、不改写旧 Review/check 结果，也不授予通过。资源仍在、daemon 不可达/不匹配、源码变化或旧记录缺少可信资源身份时继续阻塞。已确认的资源清理可使用原封存证据。生产者的未知完成检查需要新 QA 实际执行完整合同后才能接受。

父 task/session 从服务器调用身份继承；模型不能伪造。start/merge 均核对当前父身份。merge 可省略 parent_task_id，存在可信父身份时由服务器推导；模型指定冲突身份即拒绝。生命周期 task_status 与工具调用 status 分开：实现回合 succeeded 时 Candidate 可仅为 ready，独立 QA 后为 accepted，实际发布成功才 integrated。依赖等待的 Task 保持 created；start 启动满足前置依赖的原任务。

QA 必须验证准确候选、源码不变、命令实际成功；merge 检查 QA 与候选摘要，并以真实父文件基线比较后发布。冲突保留原文件；结果 unknown 仅回查事务，不自动覆盖或重新执行写入。主任务取消继承到子任务，取消注册按认证主体的实际存储路径隔离。详情见 [Coding Runtime](architecture/CODING_RUNTIME.md)。

工程源码分类由 `coding_assignment.generated_paths` 显式声明可再生输出路径（例如 `["dist"]`），默认空。`build/`、`dist/` 或嵌套同名目录本身不构成生成物身份；构建脚本属于源码。快照、QA、候选摘要、事务整合和团队验收使用同一份合同，QA 从实现任务继承且不能另行削弱。项目根、路径越界及项目配置文件不能被声明为排除输出。

子任务总生命周期与工具请求等待分开：`background=false` 最多等待 15 秒，仍在执行就返回同一任务句柄；不会因外层请求超时取消有效工作。`get/status` 查看持久化状态，`start` 仅启动前置依赖已满足的 created 任务。取消同时通过实时信号和主体/工作区范围内的持久化标记传播，跨进程可见。压测结束取消、等待并核验其全部委派分支清理，清理未知不能计为通过。
