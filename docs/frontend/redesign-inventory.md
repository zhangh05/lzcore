# 联智中枢前端视觉重构 · 界面清单（权威范围表）

> PR #1 的唯一权威范围表：每个界面 ID 一行，状态 / 提交 / 截图逐行给出；统计由本表行直接计算，不合并条目、不估算百分比。

- 基线：main@74faf69；分支 `refactor/fe-visual-redesign`
- 状态：✅ 完成并验证 · ✅⚠️ 完成（高风险面，只改视觉，契约冻结）· ⬜ 未完成 · ⬜⚠️ 未完成且高风险 · — 无界面（纯重定向，不计入）
- 截图：同状态 before/after 存于评审 box `/workspace/lzcore/<目录>/shots/{before,after}/`（`pr1` = 第 1 批，`batchN` = 第 N 批），仓库不提交图片
- **统计（按下表计算）：界面 45 项（另 1 项纯重定向不计），已完成 29，未完成 16**：D3, D4, D5, D6, D7, D10, G1, G2, G3, G4, G5, G6, G7, G8, G9, G10（其中高风险 9 项）


## A. 基础设施（跨页面）

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| A1 | 语义 token 别名层 `--lz-*` | `frontend/src/styles/semantic.css` | ✅ | 4e272af | —（零视觉变化） | 纯别名，零视觉变化；`semanticTokens.test.ts` 守护 |
| A2 | 共享集合组件 | `frontend/src/components/ui/{StatStrip,SelectionBar,OperationResults,FilterSelect,FileKindBadge,InfoList}.tsx` + `collection.css` | ✅ | e9388b1 | `pr1/after/01-data-overview-dark-1440.png` | console 层；只用 `--lz-*`；后续批次复用 |
| A3 | 确认对话框 | `components/ConfirmDialog.tsx` / `PortalModal.tsx` | ✅ | e9388b1, 6c32ab3 | `batch2/after/14-session-delete-confirm-dark-1440.png` | 标题/正文 aria 关联，取消先聚焦，Esc 取消 |
| A4 | 基础控件 | `components/ui/{Button,Input,Select,Textarea,SearchInput,SegmentedControl,TabButton,FilterBar,FormField}.tsx`、`styles/primitives.css`、`forms.css` | ✅ | f2786e4 | `batch2/after/05-settings-dark-1440.png` | 第 2 批：token 调值 + Button loading/lg、表单控件状态、自绘复选/单选、开关、徽标 |
| A5 | 页面骨架/详情面板/表格/模态 | `components/ui/{PageHeader,DetailPanel,DataTable,ModalShell}.tsx` | ✅ | f2786e4, bf6b2d1 | `batch2/after/07-runs-dark-1440.png` | 第 2 批：DetailPanel 默认 h2（heading-order 已修）、表格、卡片、对话框层级 |
| A6 | 空/加载/错误/状态徽标 | `components/common.tsx`（EmptyState/LoadingState/Skeleton*）、`styles/feedback.css`、`status.css` | ✅ | f2786e4 | `batch2/after/10-not-found-dark-1440.png` | 第 2 批 |

## B. 全局外壳

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| B1 | 顶栏分组导航 aria-expanded | `app/App.tsx` NavGroupItem、`styles/product-shell.css` | ✅ | 5c9f151 | `batch2/after/09-nav-menu-dark-1440.png` | 跟随菜单真实可见性；Esc 关闭 |
| B2 | 顶栏（品牌、分组导航、下拉菜单、功能描述、设置齿轮菜单、主题切换、退出） | `app/App.tsx` 顶栏、`product-shell.css` | ✅ | 5466236 | `batch2/after/09-nav-menu-dark-1440.png` | 品牌区 label-content-name-mismatch（基线已有）；不得删 `/topology` 内置入口与 nav.ts 网络快捷项 |
| B3 | 侧栏（工作区、新会话、最近会话、重命名、会话操作菜单、快捷操作、任务与运行记录） | `layouts/AppLayout.tsx`、`layouts/Sidebar.tsx`、`styles/sidebar.css` | ✅⚠️ | 5466236, c6c5d86 | `batch2/after/01-workbench-empty-dark-1440.png` | 会话切换 / `resume_task_id` 不可变；只改视觉 |
| B4 | 功能描述抽屉 / 能力中心 | `components/FeatureDescriptionDrawer.tsx`（内嵌 `pages/CapabilityCenter`） | ✅ | e3fc2a2 | `batch6/after/09-feature-drawer-light-1440.png`, `14-feature-drawer-light-390.png` | 第 6 批：抽屉头部 + 下沉底板 + 框卡；能力目录按抽屉宽度（容器查询）堆叠，修复 390 详情列被挤成单字宽 |
| B5 | Toast / 通知 | `components/ToastHost.tsx`、`styles/overlays.css` | ✅ | f2786e4 | `batch2/after/14-session-delete-confirm-dark-1440.png` | role 随严重度 |
| B6 | 错误边界 / 404 / 路由加载 | `components/ErrorBoundary.tsx`、`App.tsx` 404 hero、RouteFallback 骨架 | ✅ | bf6b2d1 | `batch2/after/10-not-found-dark-1440.png` | 路由加载骨架只继承 token |
| B7 | ≤760px 外壳 | `styles/responsive.css`、移动端导航 | ✅ | 5466236 | `batch2/after/21-drawer-open-dark-390.png` | 390px 顶栏按钮完整可见；抽屉为模态对话框 |

## C. 登录与账户

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| C1 | 登录页（密码、OIDC 入口、错误态） | `app/App.tsx` LoginScreen | ✅⚠️ | c32f78a | `batch2/after/11-login-dark-1440.png` | 鉴权/工作区隔离契约不变；e2e 28-login-cascade |
| C2 | 用户与权限（列表、账户信息、角色权限、无权访问） | `/users` `pages/UserManagement` | ✅ | 8020b00, 003ad44 | `batch4/after/02-users-dark-1440.png` | 第 4 批：头像/角色标签/阅读宽度；删除用户改为 ConfirmDialog |
| C3 | 重定向到 /users 或 /workbench | `/organizations` | — | — | — | 无界面 |

## D. 工作台 / 会话（`/workbench`，`pages/AgentWorkbench`）

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| D1 | 工作台页头 | `WorkbenchHeader.tsx` | ✅ | 9fbe3ae, e3fc2a2 | `batch6/after/02-workbench-result-light-1440.png`, `08-header-collapsed-*` | 第 6 批：标题 + 模型状态胶囊；对话/时间线分段组（role=group）；进度开关强调态；独立 WorkbenchHeader.css |
| D2 | 空状态与快捷提示 | `WorkbenchEmptyState.tsx`、`WorkbenchQuickChips.ts` | ✅ | 9fbe3ae, e3fc2a2 | `batch6/after/01-workbench-empty-light-1440.png`, `11-workbench-empty-light-390.png` | 第 6 批：起点卡片（按钮名 = 标签不变，提示经 aria-describedby 关联）；独立 WorkbenchEmptyState.css |
| D3 | 消息流 / 流式输出 / 思考块 | `MessageRow.tsx`、`StreamingContent.tsx`、`ThinkingBlock.tsx`、`WorkbenchMessages.css` | ⬜⚠️ | — | — | streaming 状态机不动；不得引入第二份 task/state 镜像 |
| D4 | 工具调用卡片 | `InlineToolCallCard.tsx`、`toolCallState.ts`、`WorkbenchTools.css` | ⬜⚠️ | — | — | 保留完整工具与绘图能力，不做关键词过滤 |
| D5 | 审批（批准/拒绝） | `ApprovalActions.tsx` | ⬜⚠️ | — | — | 审批/取消/恢复契约冻结 |
| D6 | 任务进度 / 阶段 / 证据 | `TaskProgressPanel.tsx`、`TaskProgress*.css` | ⬜⚠️ | — | — | 展示权威状态（coding_state_store），缓存不决定业务状态 |
| D7 | 恢复执行 | `TaskResumeControl.tsx` | ⬜⚠️ | — | — | 结果未知的写操作只能重查/对账，绝不自动重放 |
| D8 | 结果与阶段产出 | `ResultInline.tsx`、`StageOutputs.tsx`、`WorkbenchResults.css` | ✅ | 9fbe3ae, e3fc2a2 | `batch6/after/03-result-details-*`, `04-stage-output-open-*` | 第 6 批：结果单卡 + 发丝线分节，模型判断为唯一强调；阶段输出成组列表。结果开关 aria-label 名称不匹配为 main 既有（单测依赖 getByLabelText） |
| D9 | 输入框 / 附件 / 文件库选择 | `WorkbenchComposer.tsx`、`components/FileLibraryPicker.tsx` | ✅⚠️ | 9fbe3ae, e3fc2a2 | `batch6/after/06-composer-attachments-*`, `07-file-library-*` | 第 6 批：附件托盘移入输入卡片；文件库为带框分隔列表（选中态来自 :has(input:checked)）；发送/停止状态未动；e2e 27/34 |
| D10 | 运行事件时间线 / 追踪详情 | `components/{RuntimeEventTimeline,TraceDetailPanel,TaskTrackingCard}.tsx` | ⬜ | e3fc2a2（部分） | `batch6/after/05-timeline-*`, `05b-timeline-open-*`, `13-timeline-light-390.png` | 部分：RuntimeEventTimeline 已重做（第 6 批，修复 runtime 层被 base 重置清空间距）；TraceDetailPanel、TaskTrackingCard 未做 → 保持未勾选 |

## E. 资料中心

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| E1 | 数据概览 | `/data` `DataCenter.tsx` 概览 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | 统计条、最近数据可点开、健康/构成/归档 |
| E2 | 产出列表 + 详情 | `/data` 任务产出 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E3 | 关联表 | `/data` 数据关联 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E4 | 生命周期 | `/data` 归档与清理 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E5 | 文件空间（7 视图）、来源浏览、核对与备份、结构预览 | `/data?tab=files` `FileWorkspace/SourceBrowser/FileGovernance/FileInspection` | ✅ | 5c06970 | `pr1/after/02-data-files-dark-1440.png` | 全选三态、选择条、390px 列表完整显示 |
| E6 | 长期记忆（列表、展开详情、冲突复核、编辑、批量/单条永久删除） | `/memory` `MemoryPage.tsx` | ✅ | e17a1a1 | `pr1/after/10-memory-list-dark-1440.png` | 删除改为 ConfirmDialog |
| E7 | 知识库（列表、重命名、检索、导入） | `/knowledge` `KnowledgeLibrary.tsx` | ✅ | 003ad44 | `batch4/after/01-knowledge-dark-1440.png` | 第 4 批：列表主列 + 库状态/上传/导入侧栏 |

## F. 任务 / 系统

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| F1 | 任务记录（列表、筛选、批量、运行详情概览/事件） | `/runs` `pages/Operations/OperationsPage.tsx` | ✅ | 8020b00, 9a2c4e1, 003ad44 | `batch4/after/04-runs-dark-1440.png` | 第 4 批：任务卡片 + 详情面板；两处永久删除改为 ConfirmDialog |
| F2 | 系统状态（上下文运行时、写操作账本、用量、提示词库、数据策略、自检） | `/diagnostics` `pages/Diagnostics` | ✅⚠️ | 0aa89af, f7d4191 | `batch5/after/01-diagnostics-standby-light-1440.png` | 第 5 批：状态横幅 + 计数条、带框分区、状态登记表、账本日志视图；对账 `prompt`+`confirm` → FormDialog（核对依据）+ ConfirmDialog，接口与参数不变，取消不发请求；只对账不重放 |
| F3 | 系统设置（模型服务商、协议、密钥、缓存、安全模式） | `/settings` `pages/Settings` | ✅⚠️ | eaad8c8, b2090b9, 933674f | `batch5/after/04-settings-dark-1440.png` | 第 5 批：分区导航（模型服务/长期记忆/外观/危险操作）、带框编辑器、外观（复用 UI store 主题/密度）、危险区；设置项/键/持久化/请求不变；密钥处理未动 |

## G. 网络运维扩展（`extensions/network_operations/frontend`，98 个文件）

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| G1 | 网络设备（设备、连接、区域、证据环境、运行参考/最近观察/命令反馈批量删除） | `/extensions/network.operations/manage?tab=devices` `NetworkOperations.tsx` | ⬜ | — | — | 扩展路由契约（manifest/runtime/registry）不变；2407 行 |
| G2 | Skill 管理（已发布 Skill、绘图 Skill、工具授权） | `…/manage?tab=skills` | ⬜ | — | — | — |
| G3 | 拓扑图库 / 工作区框架 | `/topology` `TopologyPage.tsx`、`TopologyWorkspace`、`TopologyLibrary` | ⬜⚠️ | — | — | `/topology` 内置入口（routes.tsx:55）本 PR 不删 |
| G4 | 拓扑工具栏 | `TopologyHeaderToolbar/EditToolbar/PresentationToolbar/DisplayTools/ToolGroups` | ⬜ | — | — | e2e 23/30/31/32/33 |
| G5 | 画布与绘制 | `TopologyCanvasStage`、`NetOpsCanvas`、`useCanvas*`、`canvas*.ts`、`TopologyWhiteboard` | ⬜⚠️ | — | — | 区域身份只认 `canvas_items.item_id`，节点 `region_id` 引用它；渲染/命中测试不动，只调主题色 token |
| G6 | 节点/链路/区域/选择检查器 | `Topology*Inspector*.tsx` | ⬜ | — | — | — |
| G7 | 拓扑对话框 | `Topology{Link,ManualNode,Region,Metadata,Revision,Conflict,EmptyCreate}Dialog.tsx`、`TopologyShortcutHelp` | ⬜⚠️ | — | — | 冲突/修订对话框涉及协同与版本恢复 |
| G8 | 右键菜单 | `TopologyContextMenu.tsx`、`TopologyMenus.css` | ⬜ | — | — | — |
| G9 | 拓扑 Agent 面板 | `TopologyAgentPanel.tsx` | ⬜⚠️ | — | — | “开启新会话”用原生 `confirm` → ConfirmDialog；会话/流式契约不变 |
| G10 | 视图书签命名 | `useTopologyViews.tsx` | ⬜ | — | — | 原生 `window.prompt` → 可访问输入对话框 |

## 剩余原生对话框（来自源码 grep）
- ~~`pages/UserManagement/UserManagement.tsx:117` confirm~~ → 第 4 批已改为 ConfirmDialog
- ~~`pages/Operations/OperationsPage.tsx:475, 492` confirm~~ → 第 4 批已改为 ConfirmDialog
- ~~`pages/Diagnostics/Diagnostics.tsx:342` prompt、`:344` confirm~~ → 第 5 批已改为 FormDialog + ConfirmDialog
- `extensions/network_operations/frontend/components/TopologyAgentPanel.tsx:191` confirm
- ~~`layouts/Sidebar.tsx` 会话永久删除 confirm~~ → 第 2+3 批已改为 ConfirmDialog
- `extensions/network_operations/frontend/components/useTopologyViews.tsx:89` prompt
- `pages/KnowledgeLibrary/KnowledgeLibrary.tsx:141` 删除知识源用的裸 `confirm(...)`（全局 window.confirm，未导入 ConfirmDialog）——第 4 批的 grep 只查了 `window.confirm`，漏掉了它；E7 视觉已完成，但这处原生对话框仍待替换（需 await + 取消不发请求 + 单测断言原生未调用）

## 批次顺序
| 批 | 范围 | 清单项 | 主要风险/回归面 |
|---|---|---|---|
| 1 ✅ | 数据 + 记忆 + token 别名 + ConfirmDialog + 导航 aria-expanded | A1–A3, B1, E1–E6 | 已完成 |
| 2 ✅ | 基础控件与反馈原语迁移到 `--lz-*`：Button/Input/Select/…、PageHeader/DetailPanel/DataTable/ModalShell、空/加载/错误、Toast、ErrorBoundary/404/路由骨架 | A4–A6, B5, B6 | 全站可见；回归 e2e 21/26/29 视觉 spec；顺手修 DetailPanel heading-order |
| 3 ✅ | 全局外壳与登录：顶栏、侧栏、≤760 外壳、登录页（功能描述抽屉内部推迟到第 6 批） | B2, B3, B7, C1 | 会话切换/resume_task_id、鉴权、/topology 入口与网络快捷项保留；e2e 25/28 |
| 4 ✅ | 列表型管理页：知识库、用户与权限、任务记录（3 处 window.confirm → ConfirmDialog） | E7, C2, F1 | 已完成（@003ad44）；组件未拆分，请求未动 |
| 5 ✅ | 系统页：系统状态（写操作账本对账 prompt → 可访问表单对话框）、系统设置 | F2, F3 | 已完成（@eaad8c8）；只对账不重放；密钥处理未动 |
| 6 ✅ | 工作台外围：功能描述抽屉、页头、空状态、输入框/附件/文件库、结果与阶段产出、事件时间线（追踪详情未做） | B4, D1, D2, D8, D9（D10 部分） | e2e 25/27；发送/取消状态不变 |
| 7 | 工作台核心：消息流/流式、思考块、工具调用卡片、审批、任务进度、恢复执行 | D3–D7 | 最高风险：流式/审批/取消/恢复契约，权威状态投影，不建状态镜像 |
| 8 | 网络设备与 Skill 管理页 | G1, G2 | 扩展路由契约；2407 行单文件 |
| 9 | 拓扑外壳：图库/工作区、工具栏、检查器、右键菜单、对话框、Agent 面板（confirm）、视图书签（prompt） | G3, G4, G6–G10 | e2e 23/30–33；冲突/修订对话框 |
| 10 | 拓扑画布主题 token 与收尾全量走查，Windows 原生验证后转 Ready | G5 | canvas_items.item_id 区域身份、渲染/命中测试不动 |

## 第 2+3 批记录（@e984ca8）
- 新增：Ctrl/⌘K 快速跳转（只读/导航）、账户菜单 + 显示密度（UI store `density`，只改间距）、外框 + 页面纸张、侧栏会话筛选
- 检查：vitest 85/445，e2e dev 98，生产子集 68，axe 40 状态 0 critical/serious
- 截图：/workspace/lzcore/batch2/shots/{before,after}/；工具：/workspace/lzcore/batch2/tools/{shots2,seed2,axe2}.mjs
- 推迟：功能描述抽屉内部（第 6 批）
- 评审后加做（@1c05526、@c6c5d86）：工作台对话表面视觉初版（760 阅读列、表格/代码框、输入框卡片、进度栏时间线）放在 `pages/AgentWorkbench/WorkbenchSurface.css`（pages 层）；第 6/7 批并回组件样式。侧栏会话按日分组。页面标题 22/30。
- 检查 @c6c5d86：vitest 85/446，e2e dev 98，生产子集 68，axe 40 状态 0 critical/serious；CI @e984ca8 9/9 通过

## 第 4 批记录（@003ad44）
- 提交：`fix(palette)` 3ec14ca（评审 P1：快速跳转会话结果只属于当前打开周期 + 当前工作区，取消/过期请求不写当前结果，选择时再次核对标签；新增 e2e 37c）；`refactor(confirm)` 8020b00（3 处原生 confirm → ConfirmDialog，语义不变）；`fix(a11y)` 9a2c4e1（任务卡片去掉嵌套 role=button）；`style(management)` 003ad44（知识库/用户/任务记录视觉）。
- 检查：vitest 86/455，e2e dev 99（8.2m），生产子集 68 + 生产模式 37/03/10/16/17/04/05，axe 36 状态 0 critical/serious。
- 截图：/workspace/lzcore/batch4/shots/{before,after}/；工具：/workspace/lzcore/batch4/tools/{shots4,seed4,axe4}.mjs
- CI：@3ec14ca 9/9 通过（run 37781705555）；@003ad44 9/9 通过（run 37785012688）

## 第 5 批记录（@eaad8c8 → @933674f）
- 提交：`feat(diagnostics)` 0aa89af（新增 `components/FormDialog.tsx` 的 `promptForm()` + `<FormDialogHost/>`，与 ConfirmHost 并列挂载；账本对账的 `window.prompt` + `window.confirm` → 表单对话框 + ConfirmDialog，`operationLedgerApi.resolve(ws, id, status, reason)` → `list(ws)` 参数不变，任一步取消不发请求）；`style(diagnostics)` f7d4191（状态横幅、分区、状态登记表、账本日志视图、390px；提示词表格滚动区可聚焦）；`feat(settings)` eaad8c8（分区导航、带框编辑器、外观、危险区）。
- 检查：vitest 88/468，e2e dev 99（8.5m），生产子集 68（3.2m）+ 生产模式 12/12b/12c/12d/18/37/37b/37c/03/10/16/17（12 passed），axe 25 状态 0 critical/serious（main 同页基线 8 屏 20 条）。
- 截图：/workspace/lzcore/batch5/shots/{before,after}/；工具：/workspace/lzcore/batch5/tools/{seed5.py,shots5.mjs,axe5.mjs,axe5-before.mjs}
- 评审修复：`fix(settings)` b2090b9（分区导航跟随真实滚动容器 + 吸顶偏移 + 断点切换；减少动态下瞬时跳转并聚焦标题；`utils/motion.ts` 承载既有 reduced-motion 契约，turnTransport 同义替换；e2e 38 新增，旧代码 5 failed/1 passed）；`style(settings)` 933674f（390 长期记忆状态不换行）。
- CI：@eaad8c8 9/9 通过（run 37790570211：vitest 88/468、dev 99、生产子集 68）。
- 剩余原生对话框：`TopologyAgentPanel.tsx:191` confirm（G9）、`useTopologyViews.tsx:89` prompt（G10，可直接复用 FormDialog）——第 9 批。


## 第 6 批记录（@9fbe3ae → @e3fc2a2）
- `refactor(fe/workbench)` 9fbe3ae：WorkbenchSurface.css 拆回各组件样式表（workbench 层；必须压过 typography 的 markdown 细化与 CJK kicker 字距留在所属文件内的 pages 块）。证据：22 个状态（亮/暗 1440 + 390）全量计算样式快照前后 0 差异。
- `style(workbench)` e3fc2a2：B4、D1、D2、D8、D9 与 D10 的时间线部分（见上表备注）。
- 检查（仅受影响项）：typecheck 0；lint:styles 71；lint:tokens 312/6 warn（基线）；vitest 受影响 11 文件 58 例；e2e 02/11/17/20/25/26/27/29/34/37 dev 20 passed（1.9m）、production 20 passed（49.3s）；axe 24 个截图状态 critical/serious 11（main 同状态 26），无新增；键盘 + 减少动态 11/11。
- 截图：`/workspace/lzcore/batch6/shots/{before,after}/`（同状态 24 张/侧）；工具：`batch6/tools/{shots6,kb6,diff6.py,inv.py}`。
- 计数更正：此前写的「25/45」把第 2+3 批的 B4 计入完成，但 B4 当时为 ⬜；按行实际为 24/45（剩 21）。本批后按行计算为 29/45（剩 16）。
