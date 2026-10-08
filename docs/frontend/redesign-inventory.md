# 联智中枢前端视觉重构 · 界面清单（权威范围表）

> PR #1 的唯一权威范围表：每个界面 ID 一行，状态 / 提交 / 截图逐行给出；统计由本表行直接计算，不合并条目、不估算百分比。

- 基线：main@74faf69；分支 `refactor/fe-visual-redesign`
- 状态：✅ 完成并验证 · ✅⚠️ 完成（高风险面，只改视觉，契约冻结）· ⬜ 未完成 · ⬜⚠️ 未完成且高风险 · — 无界面（纯重定向，不计入）
- 截图：同状态 before/after 存于评审 box `/workspace/lzcore/<目录>/shots/{before,after}/`（`pr1` = 第 1 批，`batchN` = 第 N 批），仓库不提交图片
- **统计（按下表计算）：界面 45 项（另 1 项纯重定向不计），已完成 45，未完成 0**


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
| B5 | Toast / 通知 | `components/ToastHost.tsx`、`styles/overlays.css` | ✅ | f2786e4 | `final/shots/after/b5-toast-light-1440.png`, `b5-toast-dark-1440.png`（成功）, `b5-toast-error-{light,dark}-1440.png`（失败，含 req_id） | role 随严重度。原先引用的会话删除截图是确认对话框而非 toast，已更正为真实 toast 截图（侧栏“新会话”真实流程；失败态为浏览器内把 POST /api/sessions 应答 500） |
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
| D3 | 消息流 / 流式输出 / 思考块 | `MessageRow.tsx`、`StreamingContent.tsx`、`ThinkingBlock.tsx`、`WorkbenchMessages.css` | ✅⚠️ | 5e3110c, 12e8864 | `batch7/after/01-streaming-*` | 第 7 批：流式行 + 进度胶囊、中性思考块；markdown 表格/代码横向滚动区可聚焦并有名称（12e8864）；streaming 状态机未动；思考块在线应用中不可达（`<think>` 在 store/transport 层已剥离），浏览器内验收未做，见“收尾边界” |
| D4 | 工具调用卡片 | `InlineToolCallCard.tsx`、`toolCallState.ts`、`WorkbenchTools.css` | ✅⚠️ | 5e3110c | `batch7/after/02-tools-complete-*`, `03-tools-open-*`, `06-tools-bottom-light-390.png` | 第 7 批：工具调用成组发丝线列表，失败/未知以左侧轨标示；≤760 名称独占首行；工具与绘图能力不过滤 |
| D5 | 审批（批准/拒绝） | `ApprovalActions.tsx` | ✅⚠️ | 5e3110c | `batch7/after/04-approval-*` | 第 7 批：审批卡头部/可聚焦命令块（待执行命令）/动作行，批准为主按钮，焦点顺序 = 视觉顺序；审批契约未动 |
| D6 | 任务进度 / 阶段 / 证据 | `TaskProgressPanel.tsx`、`TaskProgress*.css` | ✅⚠️ | 5e3110c | `batch7/after/02-tools-complete-light-1440.png`, `01-streaming-light-390.png` | 第 7 批：进度证据行全宽名称两行截断；≤620 进度面板紧凑不再占半屏；展示权威状态，无状态镜像 |
| D7 | 恢复执行 | `TaskResumeControl.tsx` | ✅⚠️ | 5e3110c | `batch7/after/05-resume-*` | 第 7 批：继续任务条进入阅读列，说明“未知写入只回查、不重放”；按钮/元数据/恢复契约未动 |
| D8 | 结果与阶段产出 | `ResultInline.tsx`、`StageOutputs.tsx`、`WorkbenchResults.css` | ✅ | 9fbe3ae, e3fc2a2, 12e8864 | `batch6/after/03-result-details-*`, `04-stage-output-open-*` | 第 6 批：结果单卡 + 发丝线分节，模型判断为唯一强调；阶段输出成组列表。结果开关名称改为取自可见内容（12e8864，单测同步） |
| D9 | 输入框 / 附件 / 文件库选择 | `WorkbenchComposer.tsx`、`components/FileLibraryPicker.tsx` | ✅⚠️ | 9fbe3ae, e3fc2a2 | `batch6/after/06-composer-attachments-*`, `07-file-library-*` | 第 6 批：附件托盘移入输入卡片；文件库为带框分隔列表（选中态来自 :has(input:checked)）；发送/停止状态未动；e2e 27/34 |
| D10 | 运行事件时间线 / 追踪详情 | `components/{RuntimeEventTimeline,TraceDetailPanel,TaskTrackingCard}.tsx` | ✅ | e3fc2a2, 7124695, 5e3110c | `batch6/after/05-timeline-*`, `batch7/after/07-runs-trace-*` | 时间线（第 6 批）+ 卡片状态投影 runCardStatus（7124695：进行中/完成/失败/未知/未载入不再误报“本轮完成”）+ TraceDetailPanel 行按钮/筛选 aria-pressed/搜索/可聚焦元数据（5e3110c）；TaskTrackingCard 同批 |

## E. 资料中心

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| E1 | 数据概览 | `/data` `DataCenter.tsx` 概览 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | 统计条、最近数据可点开、健康/构成/归档 |
| E2 | 产出列表 + 详情 | `/data` 任务产出 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E3 | 关联表 | `/data` 数据关联 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E4 | 生命周期 | `/data` 归档与清理 | ✅ | db93d46 | `pr1/after/01-data-overview-dark-1440.png` | — |
| E5 | 文件空间（7 视图）、来源浏览、核对与备份、结构预览 | `/data?tab=files` `FileWorkspace/SourceBrowser/FileGovernance/FileInspection` | ✅ | 5c06970 | `pr1/after/02-data-files-dark-1440.png` | 全选三态、选择条、390px 列表完整显示 |
| E6 | 长期记忆（列表、展开详情、冲突复核、编辑、批量/单条永久删除） | `/memory` `MemoryPage.tsx` | ✅ | e17a1a1 | `pr1/after/10-memory-list-dark-1440.png` | 删除改为 ConfirmDialog |
| E7 | 知识库（列表、重命名、检索、导入） | `/knowledge` `KnowledgeLibrary.tsx` | ✅ | 003ad44, 0bbb6a0, 3420acf | `batch4/after/01-knowledge-dark-1440.png` | 第 4 批：列表主列 + 库状态/上传/导入侧栏 |

## F. 任务 / 系统

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| F1 | 任务记录（列表、筛选、批量、运行详情概览/事件） | `/runs` `pages/Operations/OperationsPage.tsx` | ✅ | 8020b00, 9a2c4e1, 003ad44 | `batch4/after/04-runs-dark-1440.png` | 第 4 批：任务卡片 + 详情面板；两处永久删除改为 ConfirmDialog |
| F2 | 系统状态（上下文运行时、写操作账本、用量、提示词库、数据策略、自检） | `/diagnostics` `pages/Diagnostics` | ✅⚠️ | 0aa89af, f7d4191, 3ea8649 | `batch5/after/01-diagnostics-standby-light-1440.png` | 第 5 批：状态横幅 + 计数条、带框分区、状态登记表、账本日志视图；对账 `prompt`+`confirm` → FormDialog（核对依据）+ ConfirmDialog，接口与参数不变，取消不发请求；只对账不重放。3ea8649（Codex 终审）：两步对账绑定打开时的工作区与页面生命周期，切换工作区/离开页面即取消，未发出的 resolve 不发，已发出的不重放，迟到的响应与 list(A) 不写入新范围 |
| F3 | 系统设置（模型服务商、协议、密钥、缓存、安全模式） | `/settings` `pages/Settings` | ✅⚠️ | eaad8c8, b2090b9, 933674f | `batch5/after/04-settings-dark-1440.png` | 第 5 批：分区导航（模型服务/长期记忆/外观/危险操作）、带框编辑器、外观（复用 UI store 主题/密度）、危险区；设置项/键/持久化/请求不变；密钥处理未动 |

## G. 网络运维扩展（`extensions/network_operations/frontend`，98 个文件）

| ID | 界面 | 主要文件 | 状态 | 提交 | 截图（after） | 备注 |
|---|---|---|---|---|---|---|
| G1 | 网络设备（设备、连接、区域、证据环境、运行参考/最近观察/命令反馈批量删除） | `/extensions/network.operations/manage?tab=devices` `NetworkOperations.tsx` | ✅ | ec15203 | `batch8/after/01-devices-*`, `06-connections-*`, `03-context-*`, `04-device-editor-*` | 第 8 批：设备一行记录 + 连接披露内嵌下沉列表；状态胶囊中性 + 状态点，仅失败/待确认指纹/部分参考着色；区域管理字段组（区域名称、编辑区域 X/删除区域 X）；扩展路由/manifest/runtime/registry 契约未动 |
| G2 | Skill 管理（已发布 Skill、绘图 Skill、工具授权） | `…/manage?tab=skills` | ✅ | ec15203 | `batch8/after/02-skills-*`, `05-skill-editor-*` | 第 8 批：Skill 记录节奏、删除降为 danger-ghost；编辑器名称整行、“设备连接”空态说明；工具授权逻辑未动 |
| G3 | 拓扑图库 / 工作区框架 | `/topology` `TopologyPage.tsx`、`TopologyWorkspace`、`TopologyLibrary` | ✅⚠️ | e67db0e, c43596e | `batch9/after/02-library-*`, `01-workspace-*` | 第 9 批：图库设备符号块改为发丝线表面、选中=selected 态；/topology 路由与 nav 网络快捷项保留；≤760px 图库改为画布上方的抽屉（不再挤压画布、缩放条不再竖排），关闭按钮 + Esc + 焦点归还（c43596e） |
| G4 | 拓扑工具栏 | `TopologyHeaderToolbar/EditToolbar/PresentationToolbar/DisplayTools/ToolGroups` | ✅ | e67db0e | `batch9/after/01-workspace-*`, `11-view-mode-*`, `12-insert-menu-*`, `13-arrange-menu-*` | 第 9 批：选择模式提示与查看模式胶囊改中性；缩放胶囊统一字阶 + 等宽读数；工具组/编辑栏既有 token 样式经审视保留 |
| G5 | 画布与绘制 | `TopologyCanvasStage`、`NetOpsCanvas`、`useCanvas*`、`canvas*.ts`、`TopologyWhiteboard` | ✅⚠️ | e67db0e | `batch9/after/01-workspace-dark-1440.png`, `01-workspace-light-1440.png` | 第 9 批：节点/连线标签文字、标签底与描边在主题切换时解析 `--lz-color-*`（字面值仅作缺省）；连线描边色（e2e 30）、网格/叠加绘制、渲染与命中测试、canvas_items.item_id 区域身份均未动 |
| G6 | 节点/链路/区域/选择检查器 | `Topology*Inspector*.tsx` | ✅ | e67db0e, 0d54db9 | `batch9/after/03-node-inspector-*`, `04-link-inspector-*`, `05-region-inspector-*`, `06-selection-inspector-*` | 第 9 批：检查器字号下限 9.5px → 11px，28px 字段（lz 字段 token + 统一箭头 + 焦点环），类型胶囊中性，尺寸预设实线胶囊；宽度保持 240（定位常量）；头部动作 24px（WCAG 2.5.8 下限）让 10 字符设备名不再截断（0d54db9） |
| G7 | 拓扑对话框 | `Topology{Link,ManualNode,Region,Metadata,Revision,Conflict,EmptyCreate}Dialog.tsx`、`TopologyShortcutHelp` | ✅⚠️ | e67db0e, 0d54db9 | `batch9/after/08-metadata-dialog-*`, `10-revision-dialog-*`, `17-link-dialog-*`, `18-conflict-dialog-*`, `15-shortcut-help-*` | 第 9 批：对话框头部不再继承全局 24px 内缩（标题与字段对齐），去分隔线，幽灵关闭；图标关闭按钮与 3 个对话框获得可访问名称。冲突/修订行为冻结；冲突对话框未单独截图（状态未复现，单测覆盖其行为）。0d54db9：7 个拓扑对话框补齐模态键盘契约（打开即聚焦、Tab/Shift+Tab 不逃逸、Esc 执行原关闭动作、关闭后焦点归位；main 上均无）；快捷键帮助改用共享 PortalModal；冲突对话框已复现并截图（亮/暗 1440 + 390，axe 0；main 4/3/4），≤640 选项纵向排列不再重叠；冲突状态胶囊悬停不再降透明度 |
| G8 | 右键菜单 | `TopologyContextMenu.tsx`、`TopologyMenus.css` | ✅ | e67db0e | `batch9/after/07-context-menu-*`, `14-display-menu-*` | 第 9 批：审视后右键菜单/显示菜单沿用既有 token 样式，仅把 <11px 文字提到字阶下限 |
| G9 | 拓扑 Agent 面板 | `TopologyAgentPanel.tsx` | ✅⚠️ | 0bbb6a0, 3420acf, e67db0e, c43596e | `batch9/after/09-agent-panel-*` | “开启新会话”原生 confirm → ConfirmDialog（0bbb6a0），卸载时中止（3420acf）；头部小字提到字阶下限；会话/流式契约未动（e2e 27b）；≤760px 改为全宽面板（原约 165px 窄条），关闭按钮 + Esc + 焦点归还，输入框全宽、发送在下（c43596e） |
| G10 | 视图书签命名 | `useTopologyViews.tsx` | ✅ | 0bbb6a0, 3420acf | `batch9/after/16-bookmark-dialog-*` | window.prompt → FormDialog（0bbb6a0）；对话框绑定图纸 + 工作区 + 打开周期，切换/卸载即取消且不写入（3420acf，renderHook 回归） |

## 原生对话框（来自源码 grep）
- 全部已替换。最终 grep（`frontend/src` + `extensions/*/frontend`，非测试文件）：`window.confirm|window.prompt|window.alert` 0 处；裸 `confirm(`/`prompt(` 均为导入的 ConfirmDialog / FormDialog；`alert(` 0 处。
- 第 4 批 UserManagement、OperationsPage ×2；第 5 批 Diagnostics prompt + confirm；第 2+3 批 Sidebar；0bbb6a0：KnowledgeLibrary 删除知识源、TopologyAgentPanel 开启新会话、useTopologyViews 保存视图（prompt → FormDialog）；3420acf：三者绑定打开时的作用域与打开周期（切换/卸载即取消，过期结果不写入）。

## 批次顺序
| 批 | 范围 | 清单项 | 主要风险/回归面 |
|---|---|---|---|
| 1 ✅ | 数据 + 记忆 + token 别名 + ConfirmDialog + 导航 aria-expanded | A1–A3, B1, E1–E6 | 已完成 |
| 2 ✅ | 基础控件与反馈原语迁移到 `--lz-*`：Button/Input/Select/…、PageHeader/DetailPanel/DataTable/ModalShell、空/加载/错误、Toast、ErrorBoundary/404/路由骨架 | A4–A6, B5, B6 | 全站可见；回归 e2e 21/26/29 视觉 spec；顺手修 DetailPanel heading-order |
| 3 ✅ | 全局外壳与登录：顶栏、侧栏、≤760 外壳、登录页（功能描述抽屉内部推迟到第 6 批） | B2, B3, B7, C1 | 会话切换/resume_task_id、鉴权、/topology 入口与网络快捷项保留；e2e 25/28 |
| 4 ✅ | 列表型管理页：知识库、用户与权限、任务记录（3 处 window.confirm → ConfirmDialog） | E7, C2, F1 | 已完成（@003ad44）；组件未拆分，请求未动 |
| 5 ✅ | 系统页：系统状态（写操作账本对账 prompt → 可访问表单对话框）、系统设置 | F2, F3 | 已完成（@eaad8c8）；只对账不重放；密钥处理未动 |
| 6 ✅ | 工作台外围：功能描述抽屉、页头、空状态、输入框/附件/文件库、结果与阶段产出、事件时间线（追踪详情未做） | B4, D1, D2, D8, D9（D10 部分） | e2e 25/27；发送/取消状态不变 |
| 7 ✅ | 工作台核心：消息流/流式、思考块、工具调用卡片、审批、任务进度、恢复执行 | D3–D7 | 最高风险：流式/审批/取消/恢复契约，权威状态投影，不建状态镜像 |
| 8 ✅ | 网络设备与 Skill 管理页 | G1, G2 | 扩展路由契约；2407 行单文件 |
| 9 ✅ | 拓扑外壳：图库/工作区、工具栏、检查器、右键菜单、对话框、Agent 面板（confirm）、视图书签（prompt） | G3, G4, G6–G10 | e2e 23/30–33；冲突/修订对话框 |
| 10 ✅（画布 token 并入第 9 批；Windows 原生验证未做） | 拓扑画布主题 token 与收尾全量走查，Windows 原生验证后转 Ready | G5 | canvas_items.item_id 区域身份、渲染/命中测试不动 |

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

## 第 7 批及评审修复记录（@0bbb6a0 → @5e3110c）
- `refactor(dialogs)` 0bbb6a0：最后 3 处原生对话框（KnowledgeLibrary 删除、TopologyAgentPanel 开启新会话、useTopologyViews 保存视图）→ ConfirmDialog / FormDialog；取消不发请求。
- `fix(timeline)` 7124695（评审缺陷 1）：`runCardStatus(group)` 投影——流式=本轮进行中、执行结果未知=本轮结果未知、ok=本轮完成、失败/消息 error=本轮失败、无回复=尚无回复、无结果=结果未载入；新增 runtimeTimelineStatus.test.tsx（7 例，旧代码 3 failed）。
- `fix(dialogs)` 3420acf（评审缺陷 2）：confirm/promptForm 接受 `signal`；书签对话框属于打开时的图纸 + 工作区 + 打开周期，切换/卸载即中止且不写入；拓扑新会话、知识源删除同样绑定（renderHook 图纸切换 / 工作区切换 / 卸载回归）。
- `fix(a11y)` 12e8864：结果开关名称取自可见内容；markdown 表格滚动区与代码块可聚焦且有名称。
- `style(workbench)` 5e3110c：D3–D7、D10（WorkbenchRun.css 14.3 KB，workbench 层；TraceDetailPanel.css 重写，console 层）。
- 检查：typecheck 0；lint:styles 72；vitest 受影响 17 文件 108 例；e2e 02/10/11/14/17/21/23/24/25/27/29 dev 44 passed（3.9m）、production（去掉仅 dev 的 24 首例）42 passed（1.5m）；axe 17 状态 0（main 24）；键盘 + 减少动态 9 PASS / 1 SKIP（思考块在最终回复中被剥离，状态无法构造）。
- 截图：`/workspace/lzcore/batch7/shots/{before,after}/`；工具：`batch7/tools/{shots7,kb7}.mjs`。CI：@3420acf run 37803648977 9/9；@5e3110c run 37805631849 9/9。

## 第 8 批记录（@ec15203）
- G1/G2：设备/Skill/证据环境/编辑抽屉；证据登记表拆到 NetworkContext.css（16 KiB 上限）。
- 检查：typecheck 0；lint:styles 73；lint:tokens 312/6 warn（基线）；vitest networkOperations + extensionRegistry 26 例；e2e 14/21/22/26 dev 16 passed（3.7m）、production 16 passed（1.1m）；axe 17 状态 0（main 同状态 14，均为既有品牌区）；键盘 + 减少动态 12/12。
- 截图：`/workspace/lzcore/batch8/shots/{before,after}/`（各 17）；工具：`batch8/tools/{seed8.py,shots8.mjs,kb8.mjs}`。CI：@ec15203 run 37807968826 9/9。

## 第 9 批记录（@e67db0e）
- G3–G10（含 G5 画布标签主题 token）；见上表备注。
- 检查：typecheck 0；lint:styles 73；lint:tokens 312/6 warn；vitest 拓扑/网络 23 文件 154 例；e2e 22/23/26/27/30/31/32/33 dev 52 passed（4.4m）、production 52 passed（2.4m）；axe 38 状态 1（快捷键帮助亮色：遮罩下的顶栏文字对比度，遮罩造成，非本批新增）vs main 36 状态 111（canvas/参考线 aria-prohibited-attr、隐藏测试钩子按钮无名称、对话框无名称、品牌区）；键盘 + 减少动态 10/10。
- 截图：`/workspace/lzcore/batch9/shots/{before,after}/`；工具：`batch9/tools/{seed9.py,shots9.mjs,kb9.mjs,montage.py}`。

## 390 窄屏修复记录（@c43596e）
- 两处既有缺口（main 与 0d54db9 均存在）：拓扑 Agent 面板在 390 宽只有约 165px（桌面的 `min(400px,42vw)` 规则优先级高于 900 断点覆盖）；图库保留 252px 网格列，把画布挤窄，缩放条“适配/全景导航”竖排。
- 修复（仅表现层，≤760px 生效）：Agent 面板 = 全宽面板（inset 0），头部“关闭绘图对话”；图库 = 画布上方抽屉 `min(320px, 100% - 40px)`，画布保持全宽，“关闭设备库”；`useTopologyNarrowSheet` 打开时焦点进关闭按钮、Esc 关闭、关闭后焦点回到工具栏触发按钮；缩放条按钮 nowrap。绘制、`canvas_items.item_id`、会话/工具契约、渲染/命中检测未动。
- 桌面不变：01/02/09 的亮/暗 1440 与 01 亮 390 重拍，与既有 after 逐像素 0 差异；1440 下关闭按钮不可见、面板宽 400、打开时不移动焦点。
- 检查：typecheck 0；lint:styles 73；lint:tokens 312/6 warn；vitest 全量 93 文件 493 例；e2e 22/23/26/27/30/31/32/33 dev 53 passed（4.3m）、production 53 passed（2.3m）；新增 e2e 33h（旧代码 1 failed：找不到“关闭设备库”）；`batch9/tools/narrow.mjs` 亮/暗 390 共 36 项 PASS（面板宽 390 ≥ 视口−32、输入框 344px、发送在输入框下方、抽屉 320px 画布 390px、缩放条 5 个按钮高 28px、Esc/关闭按钮/焦点进出），axe 4 个状态 0。
- 截图：`final/shots/after/batch9-02-library-{light,dark}-390.png`、`batch9-09-agent-panel-{light,dark}-390.png`；对比 `final/compare/batch9-02-library-light-390.png`、`batch9-09-agent-panel-light-390.png`（main / 0d54db9 / c43596e 三联）。0d54db9 的旧 390 图保留在 `batch9/shots/after-0d54db9-390/`。

## 收尾边界
- PR 规模（Codex 更正）：按 REST 分页统计，d8d09d0 时为 140 个文件 / 41 个提交（`gh pr view` 的 files 最多返回 100 条，不能用来计数）。
- **待 Windows 原生验证**：`scripts/windows_desktop_smoke.py` 未运行；CI 的 windows-smoke 是脚本/路由测试（run 37812880728：92 passed / 1 skipped），不等价于原生桌面验证。PR 保持草稿。
- 思考块（D3 的一部分）：在线应用里不可达——历史消息经 `stores/workbench.ts` 的 `sanitizeAssistantText`、流式经 `realtime/turnTransport.ts` 的 `filterStreamingThink` 去掉 `<think>`，`MessageRow` 拿不到思考内容；注入含 `<think>` 的历史后 3 个视口均无 `.thinking-disclosure`。因此浏览器内键盘/视觉验收未做；组件为原生 button + aria-expanded/aria-controls，单测只覆盖点击切换。
- 快捷键帮助的 axe serious（第 9 批）不是误报：旧遮罩把顶栏压暗到 3.88:1，但顶栏仍可点击、可 Tab 到达，且帮助没有 role=dialog。已在 0d54db9 改用共享 PortalModal，复测 axe 0、焦点不逃逸。
- 冲突对话框：0d54db9 前未复现；现由 `batch9/tools/conflict.mjs`（拦住界面的保存请求，先用 API 写入远端改动，界面写入得 409 后进入三方合并）复现，三视口截图 + axe + 键盘均已做。
