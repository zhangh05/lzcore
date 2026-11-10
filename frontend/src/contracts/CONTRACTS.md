# frontend-next 阶段 0 契约（冻结）

基线：`f1664cea8560caf832c47ba19408e3c7f84964e0`。方案：`/workspace/lzcore-frontend-rebuild-plan.md` 第 1.1、3、4.4、4.5 节。
每条契约 = TypeScript 类型 + 纯函数 + 单测。改契约必须同时改单测，并说明理由。

| 契约 | 文件 | 单测 |
|---|---|---|
| 三层状态 / `outcomeState` | `outcomeState.ts` | `outcomeState.test.ts` |
| 未知态流程（核对 → 标记 → 续接） | `unknownFlow.ts` | `unknownFlow.test.ts` |
| 命名表 | `naming.ts` | `naming.test.ts` |
| 扩展注册表 | `extensions.ts` | `extensions.test.ts`、`test/shell.test.tsx` |
| 鉴权三态 | `auth.ts` | `auth.test.ts`、`test/shell.test.tsx` |
| 工作区选择 | `workspace.ts` | `reviewInbox.test.ts` |
| 待核对收件箱数据源 | `reviewInbox.ts` | `reviewInbox.test.ts`、`test/shell.test.tsx` |

## 1. 三层状态

1. **目标结论**（`execution_outcome` + 目标列表）→ `deriveGoalState` / `deriveJobGoalState`。只有 `complete` 的文案含「完成」。
   - 顺序：`pending` → `unknown` → 服务端结论 → `not_reported`。
   - `unknown` = `execution_outcome==="unknown"` **或**存在 `status!=="reconciled"` 的 `unknown_outcome`，与 `ok`、`errors` 无关。
   - 没有 `execution_outcome` 时是 `not_reported`（「结论未上报」），**不**用 `ok` 合成结论。
2. **工具尝试** → `deriveToolAttemptState`：旧 `toolCallState` 两道门（pending → unknown → ok → fail；unknown 需 `execution_outcome==="unknown"` 且事实未 reconciled，按 `call_id` 精确命中）。核心不识别任何扩展的证据格式。文案为「调用已返回 / 调用报错」，不写「完成」。
3. **传输回执** → `receiptLabel` / `jobQueueLabel` / `cancelLabel`：只写「已提交 / 已入队 / 已发送 / 已请求取消」。`job.status==="succeeded"` 只写「作业已结束」。只有服务端确认 `cancelled` 才写「已终止任务」。

## 2. 两条映射（方案 1.1）

- **映射一**：`job.status==="failed"` + `metadata.active_turn.unknown_outcome`（如租约过期）→ 目标为 unknown，`canOfferConfirmedJobRetry=false`。
- **映射二**：`ok:true`、无 `errors`、`result_summary.execution_outcome==="unknown"`、作业 `succeeded` → 目标为 unknown，显示「结果未知 · 需核对」；没有重试，动作只有核对 / 标记 / 续接。
- `canShowOneClickRetry()` 恒为 `false`。jobs 重试只在明确 failed 且非未知时，作为「重试作业（需确认）」出现，确认框（列出将重放内容）在阶段 3 实现。

## 3. 未知态流程

`needs_verification → verifying → verified_still_unknown → marking → mark_submitted → marked → resume_requested`。
- 必须先回读一次才能标记；标记需选择结果 + 非空依据 + 确认串 `RESOLVE <id>`（账本后端要求的确认串）。
- 标记被受理只是回执（`mark_submitted`），回读确认后才进入 `marked`。
- 续接只带 `{ resume_task_id }`。事件类型里没有 retry / resend / replan，运行时也会拒绝。

## 4. 命名表

工作台 · 任务 · 资料（文件 / 知识 / 记忆）· 工作流 · 扩展区 · 系统（系统状态 / 设置）。顶栏：工作区、全局搜索、待核对、头像菜单。
禁用旧别名：任务记录、任务与运行记录、运行记录、文件与数据、资料中心、数据管理、系统管理、长期记忆、网络设备与 Skill。
核心名词不含「网络 / 设备 / 拓扑 / 巡检 / 运维」；扩展页标题 = `扩展名 · manifest 路由名`。

## 5. 扩展注册表

`GET /api/extensions` → `deriveExtensionMounts`。可用性只看 `lifecycle.enabled`、`lifecycle.status==="ready"`、`metadata.minimum_role`。
`/extensions/**` 解析结果：`overview | loading | mounted | unavailable(原因) | not_installed(原因) | registry_error(原因)`，**没有 404**。
扩展前端模块（manifest `module`）阶段 6 挂载；核心不 import `extensions/**`（`npm run lint:core` 检查）。

## 6. 待核对收件箱

三类来源并行读取：
- `GET /api/workspaces/<ws>/review-items?status=pending`（按 artifact：`/api/workspaces/<ws>/artifacts/<id>/review-items`；标记：`PUT /api/review-items/<id>?workspace_id=&artifact_id=`）
- `GET /api/admin/operation-ledger?workspace_id=<ws>`：`planned / running / unknown / indeterminate / blocked` 计入
- `GET /api/runtime/tasks?workspace_id=<ws>`：按 `taskHasUnknown` 判定（`execution_outcome` / 未 reconcile 的 `unknown_outcome` / 会话 task-state 的 `unknowns` 非空）。**待确认**：基线的 durable TaskState 列表没有这些字段，真实后端下该来源可能恒为 0，阶段 3 须与后端确认字段来源。

某来源 403 或失败 → `incomplete=true`，徽标显示 `N+` 并列出原因，不能当成 0。每条只有「去核对」一个动作，深链到 `/review?ws=&source=&id=`。
