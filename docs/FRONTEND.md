# 前端：状态、画布与交互

React 18、TypeScript、Vite、Zustand 和 Phosphor Icons。入口 frontend/src/app/App.tsx，导航 frontend/src/config/nav.ts；frontend 收集用户意图并投影服务端事实，不能复制授权或把本地 sending 判成服务端终态。

## 页面与归属

| 页面 | 路由 | 主要内容 |
| --- | --- | --- |
| 工作台 | /workbench | 会话、Skill、工具、公开阶段、答复和进度 |
| 任务 | /runs | 运行列表、事件、证据和终态操作 |
| 资料 | /data、/knowledge、/memory | 文件、知识与长期记忆 |
| 设备 | /extensions/network.operations/manage?tab=devices | 注册设备、连接；tab=context 查看观测/基准 |
| Skill | /extensions/network.operations/manage?tab=skills | 发布 Skill 的资源与工具范围 |
| 图纸 | /topology | 画布、节点、链路、图元、版本和绘图对话 |
| 系统 | /diagnostics、/settings、/users | 健康、模型、身份和设置 |

功能描述是顶栏抽屉；/capabilities 重定向至工作台。设备与 Skill 使用带 tab 的独立 routeKey；筛选、弹窗和 URL 状态不互相泄漏。扩展路由由 frontend_routes 注册，视觉和交互复用平台组件。

## 传输与会话

应用级 turnTransport 持有 /ws/agent，页面只订阅。切页保持回合及缓冲；退出登录或切换用户/工作区释放旧所有权，后台任务不因路由切换取消。帧按 workspace/session/client_request_id 路由，旧身份回调不能回写新 store。

streamSeq 与完整 streamDraft、过滤状态一起持久化；游标不能越过尚未缓存的字符。新回合与恢复共用 reducer。恢复先 mergeFromBackend：服务端终态消息优先于本地 streaming，确认终态后退出传输所有权；未终态才 resume。2.5 秒查询是断线终态兜底，不是正文或图纸主通道。

工具/模型阶段切换前提交显示缓冲，避免串字或丢字。stage_outputs 保留公开阶段，旧阶段可折叠；末尾与最终答复相同只省略重复显示，不删记录。公开阶段不含隐藏推理，旧版本缺失内容无法从最终答复恢复。

TaskProgressPanel 使用当前活跃回合与服务端终态投影，不能被旧 result 或缓存事件提前结束。toolCallState.ts 区分成功、失败和未知；未给调用标识时不猜哪条写入未知。

## 画布与 Agent 协作

绘图输入保留用户原话，选区和发送时 drawing_version 单独传递。发送前确认本地保存，响应丢失先对账；不能自动重放不确定保存。

服务器校验 ID 并提供局部对象、联动组、邻接和完整度。LLM 可以直接增删/移动/编辑节点、连线、标签和图元；局部 read、query 与差量收据减小重复上下文，不限制完整读取和合法大批次。

topology_updated 只携资源 ID/version。画布以最后确认版本对账：已保存则采纳；非重叠本地编辑三方合并；同字段、删除/编辑和依赖链路冲突要明确解决。snapshot_complete=false 不能替换完整画布。图纸变化记录默认折叠、与消息独立，读取后端最近保存的 revision 摘要（包含几何编辑），重开仍可见。变更卡标明已显示/待处理、差量和移除对象，可聚焦及按需读取差量撤销；撤销拒绝覆盖后来的重叠改动。

固定联动组按整体移动；明确成员坐标优先，解除 lock_group 才独立。布局保护组内相对位置与固定区域。区域 auto_fit=true 随成员包围，显式手工几何默认固定。同名区域按 ID 区分；Agent 可删边框而保留设备、只挪边框或连同成员平移；批注独立版本保存。工具保存成功和几何 feedback 不能代替视觉验收。

接口使用 Cytoscape 原生端点标签：平行线控制点间距 144，裁剪曲线 22%/78% 位置按弧长换算偏移；拖动、布局或链路变化更新几何，平移缩放不改变图纸位置，自环保留原生端点偏移。性能策略减少拖动重复计算；大图流畅度仍需目标硬件评测。

## 身份与异步

登录采用 HttpOnly Cookie；临时 token 只用 sessionStorage，不进 URL/localStorage/日志/构建变量。VITE_API_BASE 决定 API 与实时 origin；本地 token 探测合并并发并缓存 local_token_unused，临时故障可重试。fetch SSE 保留跨分片 CRLF、事件名、多行数据和 ID；Agent 会话 SSE 未接入生产者。

异步详情核对请求序号和资源 ID，旧返回不能覆盖新选择。附件失败保留草稿和失败项，仅移除成功上传项。删除保留各资源原有硬删除及确认语义。

## 视觉和可访问性

Token 在 frontend/src/styles/tokens.css。深浅主题复用语义色，正文 14px、常规操作 13px，技术元数据可用 11px。页面不再使用全局 CSS zoom；原生 DPI 与浏览器缩放按平台处理，画布仍按实际渲染比例换算指针坐标。间距、字号、圆角、控件、焦点、移动触摸目标消费共享 Token，不硬编码第二品牌色。

样式所有权依次是 Token（tokens.css，含排版节奏）、基础控件（primitives.css）、共享组件基础（patterns.css）、应用壳（product-shell.css）、共享页面模式（console-system.css）和页面/扩展细化。Settings、Operations、DataCenter、MemoryPage、KnowledgeLibrary、Diagnostics、UserManagement、CapabilityCenter 各自的 CSS 管理该页样式；TraceDetailPanel.css 管理轨迹详情，AgentWorkbench.css 是工作台入口，消息、正文、结果、工具、进度外壳/阶段/证据拆到 WorkbenchMessages、WorkbenchContent、WorkbenchResults、WorkbenchTools、TaskProgressPanel、TaskProgressPhases、TaskProgressEvidence 各自文件；WorkbenchComposer.css 管理输入与资源范围。patterns.css 是共享模式入口，按 forms、overlays、feedback、status、runtime、content、lists 拆分；product-shell.css 的侧栏独立到 sidebar.css。NetworkOperations.css 拆分目录、编辑器和拓扑基础/样式控件，TopologyStudio.css 拆分画布、工具栏、菜单、检查器/字段、Agent、白板和演示。global.css 只保留元素基础、通用工具类、无障碍与关键帧。所有样式从入口加载，页面切换不决定共享样式的先后。

登录基础样式归 feedback.css，页面细化归 pages.css。layers.css 保持原有优先级，并在 main.tsx 的组件导入之前加载；生产构建的 lint:styles --built 验证产物中各层首次出现的顺序，防止基础重置覆盖登录卡片等页面样式。迁移后的页面文件保留 base/console/pages 层，避免把低权重基础搬到高层后覆盖控件；归拢所有权不等于无边界重写全部声明。基础与细化同属其组件文件，删去无条件遮盖的旧声明，禁止新增未分层样式。所有组件入口用相对 @import 管理自己的子表，CSS 在 Git 中统一 LF 换行，确保 Windows 与 Unix 的大小检查一致；单个 CSS 不超过 16 KiB，lint:styles 对所有产品和网络扩展样式检查大小、语法与层归属，防止拆分后再次堆大。工作台消息与输入填满中间列，管理页使用可用空间；--w-reading 只约束空状态，不再要求固定正文宽度。历史 design-qa.md 只描述当时截图。

工作台以会话标题、消息与结果为主；模型可用性始终显示，完整会话 ID 和导出放在“会话信息与导出”中，Escape 关闭后回到触发器。侧栏只保留工作区、新会话与最近会话，任务历史从“任务与运行记录”进入 /runs，不再重复请求最近运行列表。

输入区的文本与附件/发送（运行中为停止）在同一行，短输入保持紧凑，多行按内容增长到上限后滚动；Skill 与资源摘要放在下方，拓扑侧输入采用相同的文本/发送排列。对话正文使用 normal 空白规则，行高 1.55、段落间距 8px、列表项间距 4px，代码和用户原文继续保留换行与缩进。

输入区默认显示 Skill 和资源摘要；展开后可搜索并选择全部资源，不会缩减工具或设备范围。资源面板有界滚动，Escape 收起并恢复焦点；窗口缩小时不改变手动展开状态。任务运行期间 Skill/资源不可改选，停止始终可操作；绘图绑定范围仍不可切换。

共享视觉使用 600 标题、500 控件标签与 400 正文；普通次操作为透明或弱 Surface，禁用态保持文字可读。侧栏和进度区减轻视觉重量，对话区域使用连续 Surface；空会话的首个操作居中。弹窗用间距分区，减少头尾分割线；控件边界使用独立 field-border，滚动条为 6px 低对比轨道。移除面板玻璃模糊和 Hover 位移，画布的定位、拖动反馈、对象配色与几何能力不受此规则影响。

主从页用于选择/详情，连续行用于数据索引；颜色表达选择或业务状态，避免装饰卡片。Button 图标提供可访问名称，DataTable 行支持 Enter/Space，ModalShell/PortalModal 限制焦点、支持 Escape 并恢复触发器焦点。异步覆盖加载、空、错误、成功、警告与未知状态。

900px 以下 Sidebar 为抽屉，工作台进度保持用户的展开状态，620px 以下移至对话下方，并保留时间线入口；760px 以下收紧密度并保留表格横向操作。路由焦点进入 #main；长文本换行或省略，不覆盖元数据。

## 验证

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint:tokens
npm --prefix frontend run lint:styles
npm --prefix frontend test -- --run
npm --prefix frontend run build
npm --prefix frontend run e2e
```

涉及 UI 还要检查实际请求、认证、主路径、窄屏、键盘、弹窗、长文本和错误。26-visual-system.spec.ts 检查 1440/900/390px 的深浅主题、11 个路由、功能抽屉、主文字 Token 对四种中性 Surface 的 4.5:1 对比度、输入边界的 3:1 对比度、无全局 zoom 和未分层 CSS，以及短窄桌面弹窗的焦点循环/关闭恢复；另以隔离数据和模拟消息覆盖有正文、表格的会话、设备目录与图纸检查器深浅主题。lint:styles 解析所有产品和网络扩展 CSS，lint:tokens 覆盖扩展 TSX。CI 保留 frontend-browser-validation 截图和失败轨迹 14 天。截图只证明当时视觉；桌面弹窗浏览器验收使用桥接适配器，不代替 Windows 原生 smoke，模拟流也不代替真实 LLM/网络设备验收。27-compact-chat.spec.ts 覆盖 1440/390px 输入高度、文本与按钮同排、多行增长、发送后清空、正文列表/标题间距和代码缩进。28-login-cascade.spec.ts 检查深浅主题、1440/390px 登录卡片内边距、控件高度、无横向溢出及键盘提交错误反馈。CI 保留完整开发服务回归，并用 E2E_PRODUCTION=1 在生产构建 preview 服务上验证管理页、工作台、视觉系统、紧凑对话和登录；同变量可用于本地生产包验收。

设置中的服务商卡片保持自然高度，宽窗口列表独立纵向滚动，920px 以下横向滚动选择，保留完整配置表单；配置字段按面板可用宽度重排，保存操作与长期记忆不重叠。右侧进度卡不因窗口变短而压缩内容，按用户选择展开/收起；窄窗口仍可访问，手机宽度在对话下方展示。图纸名称变化刷新绑定会话标题、Skill 和资源名称。

智能区域只认 canvas_items.item_id，节点 region_id 为其引用，显示名称不参与成员识别。创建/移动/自动布局/保存使用同一包围规则（region_geometry.py 与 topologyRegions.ts 有共同几何向量回归）。rectangle/ellipse 都支持；普通固定图元不因邻近设备改变尺寸。自动布局先按绑定区域安排内部节点，再隔开自动包围区域；固定框空间不足和跨区域刚体联动保持位置并提示。

拖动区域默认整体移动成员，检查器可选“只移动边框（固定尺寸）”；键盘平移遵循相同模式，拖动过程中成员实时跟随，固定联动组相对位置保留。自适应只使用既有绑定成员，不吸收邻近或同名区域的设备；设备详情可指定所属区域，选中设备创建区域会明确重新绑定。删除区域只解除归属，保留节点和连线；重载后不生成新框。迁移歧义会提示待确认，检查器显示绑定成员数量、估算越界和尺寸模式。
