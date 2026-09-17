# LZCore UI 精修审计（Phase 1）

本文件是「AI Operations Workspace」精修的 Phase 1 交付物，只陈述**实测到的现状与风险**，不含设想。
所有结论均带文件与行号，可逐一复核。实现阶段见本文件末尾的 Top 10 清单。

审计范围：`frontend/src/`（8 个 CSS 文件共 13,182 行）、`extensions/network_operations/frontend/`、
`frontend/src/components/ui/`、`frontend/src/pages/`。

---

## 一、当前 UI 的优点（资产，不得推翻）

1. **信息架构正确且不重复**。Header 承载 6 个领域分组（`config/nav.ts:50-58`），Sidebar 只承载
   工作区 / 会话 / 任务（`layouts/Sidebar.tsx:290-457`），桌面端两者无重叠；仅 ≤900px 抽屉里合并
   （`layouts/AppLayout.tsx:143-153`）。
2. **Token 单一来源 + 双主题重映射**。语义 Token 定义在 `styles/global.css:21-210`（亮）与
   `:212-265`（暗），`--ui-scale: 0.8` 是唯一的密度边界（`docs/FRONTEND.md` 明确禁止 `transform: scale`）。
3. **连续行纪律已经写进规范并被多数页面遵守**。任务中心（`console-system.css:762-768` 去掉圆角、
   仅留底部 1px 分隔）、诊断、设置、用户管理、资料中心均为主从或连续行，不是卡片墙。
4. **运行时语义没有被前端改写**。`execution_outcome` / `tool_execution_outcome` / `unknown` / approval
   的状态判定单源在 `components/toolCallState.ts`（`deriveInlineCardState` / `deriveSettledCardState`），
   前端不自行推断任务终态。
5. **进度投影来自真实事件**。`utils/streamStage.ts:15-48` 镜像后端 35 个阶段事件，
   `utils/taskProgress.ts:66-71` 投影为 4 个真实阶段；不是装饰性假进度。
6. **可访问性有真实实现**。焦点陷阱与焦点归还（`layouts/AppLayout.tsx:64-118`、`components/ui/ModalShell.tsx`）、
   `role="log"` + `aria-live`（`AgentWorkbench.tsx:521`）、工具卡 `aria-expanded`、`prefers-reduced-motion`。
7. **测试契约密度高**。工作台 20+ 个 `data-testid`、拓扑 10+ 个，且被 48 个测试文件依赖。

---

## 二、P1 问题（决定这一轮成败）

### P1-1 CSS 级联依赖加载顺序，且跨文件合成同一布局

- `global.css:2840-2847` 仍有一份 `.wb-shell { display: grid !important; grid-template-rows: 48px 42px minmax(0,1fr) auto }`；
  `AgentWorkbench.css:1-9` 只给列。**最终网格 = global 的行 + 页面文件的列**，`display:grid` 被 `!important` 锁死。
- `design-qa.md:71` 记录了上一轮同源的 P1：「Workbench content grid collapsed after the first production
  build because legacy global selectors won the CSS cascade」，处置方式是**靠 import 顺序**。
  这正是本次规范 §38 要求消除的模式。
- 全仓 `@layer` 出现 **0 次**；`!important` **44 处**（其中 12 处是真正的级联补丁）；
  同一选择器在 ≥2 个文件中出现 **170 个**；同文件内重复声明 **215 处**。
- 最严重重复：`.run-detail-button`（10 次）、`.chat-bubble.assistant`（10 次）、`.app-nav-item`（9 次）、`.btn`（8 次）、
  `.stat-grid`（3 个文件：`global.css:5481` / `console-system.css:241` / `typography.css:467`）。
- 有明文承认顺序依赖的注释：`typography.css:462-466`、`AgentWorkbench.css:1188-1191`、`global.css:3829-3832`。

### P1-2 扩展 CSS 因为最后注入而必然胜出

`NetworkOperations.css` 与 `TopologyStudio.css` 是懒加载，最后注入，于是：
- `NetworkOperations.css:1010` **裸选择器 `.stat-card`** 撞 `global.css:5493` 与 `console-system.css:249`；
  `:1078/:1086/:1095/:1101` 裸 `.modal-panel/.modal-header/.modal-header h3/.modal-actions`。
- `TopologyStudio.css:68-71` 自建 `[data-theme="dark"]` 分支并硬编码 `#0f1519`，**重复了主题机制**。
- `scripts/check_css_tokens.py:12-14` 的扫描根目录固定为 `frontend/src`，**扫不到 extensions**，
  且未接入 CI（`.github/workflows/` 无引用）。

### P1-3 工作台叠了两条 56px 横条

`--h-header: 56px`（`global.css:133`）同时用于全局 `.app-header`（`app/App.tsx:375`）与
`.wb-shell` 首行（`AgentWorkbench.css:11-19`）。两条同级横条共 ~112px，且工作台标题是前端从
最后一条用户消息截 32 字符派生（`AgentWorkbench.tsx:344`），与侧栏会话项重复（`layouts/Sidebar.tsx:356`）。

### P1-4 同一概念存在两套视觉语言

| 概念 | 实现 A | 实现 B | 后果 |
|---|---|---|---|
| 运行时呈现 | `rt-*`（`RuntimeEventTimeline.tsx/.css`） | `task-*`（`TaskProgressPanel.tsx`） | 仅共享状态判定函数 |
| 搜索框 | MemoryPage 自建 `.search-input-wrapper` | KnowledgeLibrary `.kl-search-box`；CapabilityCenter 裸 `<input className="input">`；DataCenter 用 `<Input>` | **四套实现** |
| 空状态 | `EmptyState`/`AsyncView`（`common.tsx:82`） | `.hero`（Memory/Operations）、`.user-access-empty`、`.data-onboarding-empty`、`.cc-empty-state` | 五种 |
| 状态徽标 | `Badge`（`common.tsx:173`） | `.status-pill`、`.diag-status-tag`、`.provider-badge` | 四种 |
| 标签页 | `<TabButton>` | 手写 `.segmented>button` | 两套 |
| 弹窗 | `ModalShell`（**页面零使用**） | `PortalModal`、`window.confirm` | 三套 |

UI 原语采纳率约 **50%**：`<Button>` ≈35 处，手写 `<button className="btn …">` ≈37 处。

### P1-5 助手回复仍是聊天气泡，且权重倒置

- 助手消息是单个中性气泡（`AgentWorkbench.css:253-264`），**不存在** judgement/evidence/steps 分段组件。
- 思考块有 `border-left: 3px solid var(--accent)`（`AgentWorkbench.css:1036-1044`），阶段输出没有
  （`1273-1284`）→ **思考比阶段输出更抢眼**，与「最终答复 > 阶段输出 > 思考」的目标顺序相反。

---

## 三、P2 问题（体验与一致性）

1. **卡片墙**：`KnowledgeLibrary` 堆叠 5+ 个 `.card`（`KnowledgeLibrary.tsx:485,515,557,620,696,740`）；
   `MemoryPage` 每条记忆一个 `.memory-card`（`MemoryPage.tsx:296-389`）；`CapabilityCenter` 工具目录为等权 `.card`（`CapabilityCenter.tsx:269`）。
2. **遗留色板**：`global.css:5506` `.stat-value-purple { color: #7e22ce }`（**蓝紫，违反规范**）；
   诊断页遗留 Material 色 `#ed6c02`×10、`#d32f2f`×7、`#2e7d32`×7（`global.css:5162-5250`）。
3. **辉光与渐变**：`global.css:5159/5163` `box-shadow: 0 0 14px var(--lz-glow-*)`；
   `console-system.css:90` 焦点光晕；渐变 3 处（`global.css:3720`、`TopologyStudio.css:67,69,110`）。
4. **第二套蓝色**：拓扑画布用 Tailwind 蓝（`NetOpsCanvas.tsx:171-173,281-288,563-565` 的
   `#3b82f6/#60a5fa/#dbeafe`；`TopologyStudio.css:81,82 #2563eb`、`:84 #ec4899`），
   与 `docs/FRONTEND.md:41` 的「禁止第二套品牌色」冲突。
5. **死代码**：47 个 Token 定义后从未引用；`global.css` 87 个不同硬编码 hex、1683 处硬编码 px；
   `.app-spacer`/`.brand-mark`/`.app-nav-advanced` 无 JSX 引用；`--topology-link`（`TopologyStudio.css:8`）定义未用。
6. **全局泄漏选择器**：`global.css:5086` `[style*="overflow"]`、`typography.css:401` `[class*="kicker"]`、
   `global.css:271` `body { zoom: var(--ui-scale) }`。
7. **无命令面板**；`Textarea` 原语零使用（MemoryPage 手写）。
8. **登录页无品牌化**：`app/App.tsx:237-319` 内联，只有 kicker「联智中枢」+ 标题「登录工作台」。

---

## 四、CSS 架构风险（工程侧结论）

1. **级联完全依赖加载顺序**：真实求值顺序是
   `RuntimeEventTimeline.css` → `global.css` → `product-shell.css` → `console-system.css` →
   `AgentWorkbench.css` → `typography.css` → 懒加载扩展 CSS。
   注意 `RuntimeEventTimeline.css` **先于 global.css**（经 `main.tsx:3 → App.tsx:26 → routes.tsx:14`），
   而 `global.css:4720-4722,6700-6723` 也写 `.rt-*` 类 → **global 永远胜出**。
2. **组件类住在全局文件**：`.wb-*` 56 行、`.rt-*` 两处位于 `global.css`。
3. **危险排序**：`.wb-shell` 跨文件合成 → 扩展裸类最后注入 → `.stat-grid`/`h1-h6` 同特异性靠顺序决出。
4. **可安全推进的路径**：引入 `@layer` 固定层序，先声明层序再逐块迁移，**不一次性删除 legacy 规则**。

---

## 五、最值得做的 10 个改动（按性价比排序）

| # | 改动 | 为什么值得 | 风险 |
|---|---|---|---|
| 1 | **引入 CSS `@layer` 层序**，把 `.wb-shell` 完整网格收回 `AgentWorkbench.css` 并去掉 `!important` | 消除唯一被记录过的 P1 回归；让后续所有改动不再依赖 import 顺序 | 中（需逐块迁移） |
| 2 | **建立 Technical Metadata 排版体系**（RUN/TRACE/MODEL/TOOL/DURATION/SOURCE，mono + tabular） | 规范 §41 的品牌签名来源，且**数据已真实存在** | 低 |
| 3 | **工作台 Context Bar**：56px → 44px，去掉 kicker，与全局 Header 层级拉开 | 一次性消除 112px 双横条，工作台立刻不像"第二层后台" | 低 |
| 4 | **空状态改为 Composer 优先** | 复用已存在的 3 个真实 chip，删掉 badge+标题+说明的模板形态 | 低 |
| 5 | **助手回复去气泡化 + 分段结构**（判断/证据/执行/建议，靠排版与分隔线而非背景框） | 直接达成「像 Investigation Report 而不是聊天」 | 中 |
| 6 | **修正权重倒置**：思考块去掉 accent 左边框，阶段输出保持 secondary | 让「答复 > 阶段输出 > 思考」真正成立 | 低 |
| 7 | **Runtime Rail 收敛为 4 个真实阶段**（理解问题/收集证据/分析判断/形成建议），保留 summary 优先、点击展开 | 已有真实投影，只需视觉收敛；**不编造第 5 阶段** | 低 |
| 8 | **拓扑去除第二套蓝色**，节点/链路统一走产品语义色与状态色 | 拓扑是第二旗舰页，第二套品牌色是最显眼的"模板感"来源 | 中 |
| 9 | **Shell 降噪**：一级导航文字优先、active 用排版 + 细指示器 | 规范 §8；减少每项 icon+text 的重复信号 | 低 |
| 10 | **原语收口**：新增 `SearchInput` / `StatusPill` / `SegmentedControl` / `EmptyState` 统一件，迁移 5 个手写页面 | 消除四套搜索框、五种空状态、四种徽标 | 中 |

**明确不做**（本轮）：命令面板（需真实跨域检索能力，当前 API 不支撑，做了就是假搜索）；
实时协同与 CRDT（产品级决策）；任何假 KPI / 假 Trace / 假 Run。

**关于规范 §13 的 5 阶段命名**：后端真实投影只有 4 个阶段（`utils/taskProgress.ts:66-71`），
`streamStage.ts:15-48` 的 35 个事件里没有 validate/respond 的独立阶段。
本轮**保留真实的 4 阶段**，不为了对齐规范而发明第 5 个 —— 规范 §5 同时要求「必须建立在真实产品数据之上」。

---

## 六、实施进度

验证方式：**结构探针**（10 条路由 × 25 个选择器 × 计算几何与级联敏感属性）在改动前后各采集一次，
逐项比对。纯重构的验收标准是差异为 0；有意改动则必须能逐条解释。

| 批次 | 内容 | 验证结果 |
|---|---|---|
| `d08fc69` CSS 地基 | 新增 `styles/layers.css` 声明层序；8 个样式表各自归层；`RuntimeEventTimeline.css` 改由入口加载；删除 global.css 中**从未生效**的 `.wb-shell`（它用 `!important` 锁死 `display:grid` 并把最终网格跨两个文件合成） | **布局差异 0 / 颜色差异 0 / 页面错误 0** |
| `cbcb1e2` 元数据 + 工作台 | 技术元数据体系；Context Bar 56→44px；空状态 Composer 优先；修正思考块权重倒置；删除 global.css 中特异性更高的 `.wb-empty h2` | Context Bar 42px vs 全局 Header 53px；标题与消息列同一左基线；空状态引导行 16px/600、距 Composer 23px |
| `a1201c4` Shell 降噪 | 一级领域导航改为文字优先，领域图标移入其下拉头部 | 6 个领域 / Header 内 **0 图标** / Header 高度不变 |
| `dc0353b` 助手回复报告化 | 去掉助手气泡的底色/圆角/内边距，轮次加细分隔线；AI 标记不再是填充品牌色圆点；**删除 global.css 中特异性更高的深色覆盖** | 明暗两主题实测：`background: transparent` / `radius: 0` / `padding: 0` / 行首 1px 分隔线 |
| `0e04769` 拓扑单色板 | 节点/链路状态、选区、连线反馈、分组容器统一走产品语义色；**选区改为强调色光晕，不再覆盖运行状态边框**；图例与筛选点改用 `var(--ok/--warn/--danger/--text-4)` | 两主题下图例渲染值与画布镜像值完全一致（浅 `#147a55/#a16207/#bd3040/#6c7c7e`，深 `#77ca9c/#e2ad4d/#ef7180/#95a3b3`） |
| `be4ba5b` Runtime Rail | 头部改为陈述轮次本身（`RUN` / `ELAPSED` / `TOOLS`，全部为观测值）；阶段改为连续行 + 摘要优先展开项，活动阶段自动展开；**没有时间戳就不显示时长** | 真实已完成轮次实测：`RUN fb798bee` / `ELAPSED 28s` / `TOOLS 2` / 阶段 14s·28s；无观测时不渲染任何事实 |
| `2d4ba41` 记忆页行化 | 去掉行上的 `card`（消除「列表容器 + 每行卡片」的双重容器）；6 个徽标降为「元数据行 + 仅例外徽标」 | 真实创建一条记忆实测：圆角 0、徽标 0、元数据 `TYPE/SOURCE/SCOPE/CONFIDENCE`；验证后已删除 |
| — | 全量前端测试 | **232 通过 / 48 文件**，`tsc -b` 0 错误，`npm run build` 通过 |

### 一个必须记录的失败尝试

第一版层序设计把 6 个共享样式表拆成 6 个独立层（`base/shell/console/workbench/typography/runtime`），
**实测在 10 条路由上移动了 156 个盒子**。根因不是实现错误，而是对 `@layer` 语义的误解：

> 旧级联是「**特异性优先，顺序兜底**」；`@layer` 是「**层序优先，特异性兜底**」。

因此把共享样式拆层会改变结果 —— 例如 `console-system.css` 的 `.btn.sm { font-size: 12px }`
此前是靠**更高的特异性**压过 `typography.css` 的 `.btn { font-size: 13px }`，
拆层后反过来输了。这 156 个差异没有被"接受"，而是**退回单层**先保证等价，
再逐个消解冲突（这是规范 §38「逐步消除 specificity war，但必须安全迁移」的字面执行）。

**结论**：共享样式拆层是一项需要逐条验证的工程，不是一次机械包裹。当前 `product` 单层
已经达成两个目标（声明式层序 + 扩展边界），细拆留待冲突逐个清零后进行。

### 两条值得记下的实现约束

1. **Cytoscape 画在 bitmap 上，无法解析 CSS `var()`**。所以画布颜色必须在 JS 里镜像一份字面量 ——
   这是唯一允许重复令牌的地方（`NetOpsCanvas.tsx` 顶部已写明）。而**凡是 DOM**（图例、筛选点、
   预览线、对齐辅助线）一律用 `var()`，两者必须同源，否则会出现"图例说绿色、画布画灰色"。
2. **深色主题的高特异性覆盖是最容易漏的一类 bug**。本轮两次遇到同型问题：
   `[data-theme="dark"] .chat-bubble.assistant` 与 `[data-theme="dark"] .lz-group` 的特异性
   都**高于**页面文件里的同名规则，导致"改动只在浅色生效"。凡改颜色/背景，必须在两个主题下各验一次。

### 关于「不得造假数据」的一条执行标准

规范要求「必须建立在真实产品数据之上」。本轮把它落成一条可检验的规则：
**字段拿不到就不渲染，而不是给一个看起来合理的值。**

具体表现：Runtime Rail 的阶段时长取自运行时**真实发出的事件时间戳**；
运行时没有给该阶段打时间戳时，模型返回 `undefined`，界面**不显示任何时长**
（而不是显示 `0s` 或按阶段数平均）。同样，`run_id` 只从轮次快照或消息上取 ——
它是时间线分组用的同一个字段，**绝不用 `trace_id` 顶替**（两者语义不同）。

### 三个数据页共用的语言（§26 的落地）

规范要求 Data / Knowledge / Memory 不要各自发明视觉语言。本轮把记忆页统一到与工作台、
Runtime Rail 相同的**技术元数据语言**（`.meta` / `.meta-label` / `.meta-fact`）：

- 行内只陈述扫读需要的事实：`TYPE` / `SOURCE` / `SCOPE` / `AUTHORITY` / `SCORE` / `CONFIDENCE`。
- **徽标只留给例外**（需要处理的状态、用户明确确认的权威、低于阈值的评分）——
  之前每行 6 个徽标，等于没有重点。
- 深层信息（为什么记、证据来源、记忆主题、经历证据、合并来源）留在展开区，
  符合「overview first, details on demand」。

**未做**：Knowledge 与 Data 两页仍是原状。记忆页是三者中最典型的卡片墙，
先做它以确立语言；另两页可在同一语言下继续迁移。

## 七、2026-09-16 提交前复审

审核范围为 `origin/main` 的 `b8f82c7` 至 `2d4ba41` 的 10 个本地提交，以及本文件原有未提交补记；保留全部既有改动。

本轮修复：

- **拓扑状态更新**：运行状态独立于图纸变化，不能只靠图纸重新渲染更新边框。新增仅更新 `status/statusColor/statusWidth` 的渲染器同步，不写节点坐标；首次请求改为在活动图纸初始化后触发，避免首屏等待 10 秒轮询。
- **进度栏语义**：工具项复用 `deriveInlineCardState`，保留 pending、unknown、成功和失败的区别。`status=done` 仅表示调用结束，不能覆盖 `ok=false`；未知写入按调用 ID 精确标注，已核对的历史事实不重新标为未知。
- **失败阶段**：失败结果不再同时满足完成条件，后续阶段保持等待；成功工具调用数量不再称为“证据/来源数量”。阶段时间增加“事件跨度、非独占耗时”提示。
- **样式边界**：网络扩展的 `.stat-card` 与 `.modal-*` 规则限定到扩展容器，防止访问拓扑后污染平台弹窗。保留现有 product/extension 层序。
- **拓扑深色主题**：工具栏、菜单、侧面板与状态栏不再硬编码白底和浅色文字，接入现有语义 Token；不改设备图标、厂商底色或用户自定义图元颜色。
- **记忆交互**：标题提供原生按钮、展开状态与详情关联，支持 Enter/Space；复选框有可访问名称，点击详情、复制内容或审核操作不再意外收起整行。
- **测试契约**：助手回复的浏览器断言从旧气泡底色更新为明暗两主题下的透明、无圆角、无内边距；新增记忆键盘操作、扩展样式隔离和真实画布状态刷新的回归用例。

浏览器测试使用仓库隔离后端及临时数据目录；画布状态变化由测试接口响应驱动，不连接实际设备、不修改开发工作区数据。此处验证的是界面响应与渲染，不代表外部设备已验证。

复审验证：前端 **236 项 / 49 文件通过**；完整 Playwright **30 项通过**（含管理页面 390–1920px、深浅主题与新回归用例）；网络后端 **142 项通过**；TypeScript、生产构建、文档一致性及 Token 扫描通过。构建仍提示 ELK 布局库大分块，未新增依赖或改动其加载契约。Vitest 仍有原有模拟环境 socket 噪声，浏览器测试的认证与 SSE/WS 用例通过。

---

## 七、共享样式细拆层：可执行交接清单（Phase 7）

现状：`product` 是**单层**，层序已声明、扩展边界已建立，但共享样式表之间的归属仍是粗粒度的。
细拆（`base` / `shell` / `console` / `workbench` / `typography` / `runtime`）**会改变渲染结果**，
原因是层序优先于特异性，而旧级联是特异性优先、顺序兜底。

**实测数据**：临时拆层后在 10 条路由上移动了 **207 个盒子**，聚类后只有 **7 个真实规则冲突**，
其余 200 处都是它们的连带后果（父容器高度变化传导给子元素）。

| # | 冲突 | 拆层前 → 拆层后 | 出现次数 |
|---|---|---|---|
| 1 | `.btn` 字号 | 12px → 13px | 40 |
| 2 | `.empty` 高度 | 29px → 150px | 12 |
| 3 | `.input` 宽度 | 193.7px → 240px | 11 |
| 4 | `.card` 高度 | 230.9px → 269.5px | 6 |
| 5 | `.page-header` 高度 | 80.6px → 84.7px | 5 |
| 6 | `.stat-grid` 行高 | 74.6px → 70px | 2 |
| 7 | `.card` 圆角 | 12px → 8px | 1 |

### 执行步骤（每步都可独立验证、可安全中断）

1. 对每个冲突：找到互相竞争的两条规则，**确定哪个值是有意的**，
   然后让两者一致（删掉多余的那条声明，或把值改成相同）。
   **判据**：在**保持单层**的前提下，探针差异必须为 0 —— 也就是视觉不变。
2. 7 个冲突全部消解后，再应用细拆，探针差异应为 **0**。
3. 若仍有差异，说明还有未发现的冲突，回到第 1 步。

### 工具

- 探针：`/tmp/layout_probe.py`（10 路由 × 25 选择器 × 计算几何与级联敏感属性）
- 对比：`/tmp/layout_diff.py <before.json> <after.json>`
- **建议把这两个脚本移进仓库**（`frontend/scripts/`），否则会随临时目录丢失。

### 本轮为什么停在这里

修复循环需要「改一条 → 构建 → 探针 → 对比」重复 7 次以上，属于多轮迭代任务。
在上下文余量不足时启动它，中途耗尽可能把样式留在更糟的状态。
因此本轮**只做分析、不动代码**，代码库保持在已验证的单层状态。

---

## 八、共享样式细拆层：实测结论（Phase 7 续）

上一节留下的是「7 条冲突 / 207 个盒子」。本轮把每一条都定位到了具体规则，
**实测结果与那份清单不同，而且原因不同**。

### 工具：原来那套不够用

| 工具 | 覆盖 | 本次发现 |
|---|---|---|
| `layout_probe.py`（10 路由 × 25 选择器） | 25 个选择器 | 报 39 处差异 |
| `dump_boxes.py`（**新增**） | 每条路由的**每一个元素** | 报 **1280 处** |
| `cascade_conflicts.py`（**新增**） | 每条规则的胜出者，按两套级联各算一次 | 22 类真实翻转 |

`cascade_conflicts.py` 的做法：对同一元素的同一属性，把两条候选声明
**各自强制成内联样式再读一次真实计算值**再比较 —— 这样才能区分
「同一像素、不同写法」的假翻转（`var(--weight-subhead)` vs `650`）。

### 实测数据

per-file 拆层（`base`=global / `shell` / `console` / `workbench` / `typography` / `runtime`）：
**109 处翻转，聚类后 22 类真实冲突**。约 14 类是同一个形状 ——
typography.css 的裸元素选择器（`h1`–`h6`）压过各组件的限定标题规则，
例如 `.task-phase-summary h3 { font-size: 13px }` 败给 `h3 { font-size: 16px }`。

试算过 5 种层序，没有一种可行：

| 层序 | 翻转 / 类数 |
|---|---|
| base, shell, console, workbench, typography, runtime | 64 / 22 |
| base, typography, shell, console, workbench, runtime | 96 / 30 |
| typography, base, shell, console, workbench, runtime | 144 / 36 |
| base, shell, console, workbench, runtime, typography | 64 / 22 |
| runtime, base, shell, console, workbench, typography | 64 / 22 |

### 两个结构性阻塞

**1. typography.css 装着两个相反的角色。**

- *元素级默认*（h1–h6、`.markdown-body`、`.meta`）必须是**最早**的层，组件才能覆盖它；
- *容器节奏归一*（`.card`、`.page-body`、`.ui-filter-bar`、`.stat-grid`）必须是**最晚**的层 ——
  它当初就是靠「后加载 + 同特异性」盖住 global.css 与 console-system.css 的硬编码值。

把文件按角色切成 `typography`（早）+ `rhythm`（晚）两层试过：14 类标题冲突消失，
但暴露出阻塞 2。

**2. 晚层的 `padding` 简写会压掉早期层里的长写与更高特异性覆盖。**

`.capability-center .page-body { padding-top: 16px }`（console，特异性 0-2-0）被
`.page-body` 的 `padding` 简写（rhythm，最后一层）盖掉 → **能力中心 878 个元素位移**。

**这条是本轮最重要的工具教训**：冲突枚举器按属性名比较，
**抓不到简写 vs 长写**（`padding` / `padding-block`、`background` / `background-color`）。
只有全元素几何对比才暴露。**验证手段选错比不验证更危险** —— 这一条今天第二次命中。

### 结论与当前状态

按上一节定下的判据（不能验证就回退），六个样式表已 `git checkout` 回**已验证的单层状态**，
探针重跑 **0 差异**。代码库没有留在半途。

细拆层的前置工作（做完它才谈得上拆）：

1. **删掉 `global.css:438-453` 的裸标题规则**（`font-weight: 720`、line-height 1.25/1.3/1.35/1.45）。
   它与 typography.css 的（700/650、1.24/1.34/1.34/1.34）重复且取值不同。
   typography.css 自称元素排版的唯一来源，那么该删的是 global.css 这份，
   而不是继续靠「谁后加载」决定。
2. 把 typography.css 的容器节奏段**就地并入** global.css / console-system.css（合并到源头），
   而不是叠在最外层 —— 只有这样，特异性才能继续在那一层内部裁决
   （`.knowledge-library .page-body > .card` 这类覆盖才活得下来）。
3. 逐条消解剩下的跨文件倒置：`.data-center .data-center-tabs button` 与 global 的三选择器规则、
   `.message-avatar.user`（global）与 `.message-avatar`（AgentWorkbench）、
   `.page-body.no-pad`（global）与 `.page-body`（console-system）。
   后一条已有现成先例：typography.css:375 用的是 `.page-body:where(:not(.no-pad))`。

### Data / Capabilities 列表行化（已完成）

- **能力中心工具目录**：原本四层嵌套边框盒（category → group → row → detail-card）。
  `.tool-row` 拆出共享的 border/radius/background 规则，改为 `border-bottom` 分隔 + 透明底；
  `.tool-list` 成为唯一容器。`.capability-center .tool-row` 的 `surface-2` 填充也去掉了 ——
  否则每行一块底色，读起来仍是一叠面板。
- **数据中心文件列表**：`.data-row` 原本是带 border/radius/box-shadow 的卡片，改为行。
  hover 从「上浮 1px + 边框变色」改为换底色（上浮是卡片的语言，行不该动）。

**验证边界（如实）**：本工作区**数据 0 个文件**，`.data-row` 一行都渲染不出来。
用注入探针行的方式验证了计算样式（borderTop 0 / radius 0 / 背景透明 / margin-top 0），
验证的是 CSS 本身而非业务数据。与知识库结果行同一类边界。

---

## 九、响应式与 QA 矩阵：全站扫描（Phase 7 续）

`qa_matrix.py`（**新增，已入库**）跑 11 路由 × 4 宽度 × 亮/暗 = **88 个组合**，
报四类截图审查看不出、类型检查永远看不见的问题：横向溢出、文字对比度、
零尺寸可交互元素、≤900px 关键区域是否真的重排。

### 先证明检测器本身有效

第一版报「无尺寸元素 **85 类**」。逐个查后发现全是**假阳性**：
移动端抽屉在桌面断点下整体 `display:none`，其链接自然测得 0×0 —— 而 `display`
的计算值仍为 `inline`，因为祖先的 `display:none` 不会改变后代的计算样式。
改用 `checkVisibility()` 后归零。

于是给检测器加了自测（`--selftest`）：注入三个已知缺陷（白底白字、4.0 的灰字、
0×0 按钮），断言全部被抓到，再加一个正常按钮断言**不**被误报。四项全部 PASS。
**「什么都不报」和「什么都没看」在输出上无法区分** —— 这是今天第三次撞上
「度量方式会骗人」，这次是反过来的方向。

### 结果

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 横向溢出 | 0 | 0 |
| 对比度 < 3.0（几乎不可读） | **1 类** | 0 |
| 对比度 3.0–4.5（未达 AA） | **72 类** | 0 |
| 零尺寸可交互元素 | 0（修正判定后） | 0 |

### 修的两个缺陷

**1. 语义色被当成填充色用（暗色主题下对比度 2.1，按钮几乎看不见）。**

暗色主题把语义色整体翻成**浅色**（`--accent #72c3ba`、`--info #80badc`、
`--danger #ef7180`）—— 它们是给深色底当**前景**用的。所有「白字 + 语义色填充」
的组合在暗色下因此全坏，而产品里只有一个 `--accent-text` 令牌在处理这件事。

按已有模式补齐 `--ok-text` / `--warn-text` / `--danger-text` / `--info-text`
（亮色为白、暗色为深），并修 8 处用法：`.btn-info`、`.scroll-bottom-btn:hover`、
`.msg-error-box button`、`.diag-summary-icon` 及其 `[data-healthy="false"]` 态、
`.toast-notification.ok/.err`、`.error-boundary-retry`、`.user-avatar`。

toast 的墨色从基础规则**移到了变体上**：`kind` 被类型约束为 `"ok" | "err"`，
不存在需要默认值的第三种状态，基础规则上的 `color: #fff` 是死重。

`[data-tip]` 的气泡是 `background: #111827`（硬编码深色，不随主题翻转），
白字正确，**未改**。

**2. 两级次要文字靠得太近，较浅的那级不达 AA。**

72 类全部指向同一个令牌。亮色主题下：

| 令牌 | 原值 | 白底 | 次表面 #fafcfb |
|---|---|---|---|
| `--text-2` | #334348 | 10.31 | 10.00 |
| `--text-3` | #66777b | 4.68 | 4.54 |
| `--text-4` | #6c7c7e | **4.36** | **4.23** |

两级只差 0.3 对比度 —— 肉眼分不出来 —— 而 `--text-4` 承载的是 10–11.5px 的文字，
未达 WCAG AA 的 4.5。**这不是改一个值能解决的**：要让 `--text-4` 过 4.5，
它就得比 `--text-3` 更深，直接把层级倒过来。

所以是**重新拉开间距**：`--text-4` 取原 `--text-3` 的值（4.68 / 4.54，两项达标），
`--text-3` 下移到 #5d6b6f（5.53）。层级变成 10.31 / 5.53 / 4.68。
暗色主题两级同样是 `text-4` 更浅的排序，且本来就达标，未动。

**这是一次全局视觉改动**（`--text-3` 用于各处次要文字），不是纯修补。
若要回退，改 `global.css:41-42` 两行即可。

### 交互验证（静态扫描之外的部分）

- 900px 抽屉：点击前 `x=-294` → 点击后 `x=0`（宽 295），**能打开**。
- 抽屉内导航：点击非当前路由 → URL 变为 `/runs`，**能跳**。

### 验证边界（如实）

- **/topology 检视器未被验证**。它在 900px 和 1200px 下都是 0×0、`display:none`，
  节点类元素数为 **0** —— 本工作区没有设备，没有可选中的东西。
  这是与「知识库 0 文档」「数据 0 文件」同类的边界，不是响应式缺陷。
- 本轮改动**全是颜色**（令牌 + 8 处引用），不改变盒模型，因此未重跑几何探针。

---

## 十、响应式层被整体架空（未修，需设计判断）

`shadow_cssom.py`（**新增，已入库**）用浏览器 CSSOM 取代手写的 CSS 解析 ——
手写版丢了 `@media` 嵌套，产出全是垃圾。CSSOM 直接给出准确顺序、准确选择器、
以及规则是否位于媒体查询内。

### 发现

媒体查询**不增加特异性**。而 `product-shell.css` / `console-system.css` /
`typography.css` 都在 `global.css` **之后**加载，且其中的基础规则是**无条件**的。
于是 global.css 里所有同选择器的响应式覆盖**全部失效**：

- 响应式覆盖被后置无条件规则压掉：**29 处**
- 其中取值确实不同（即重放后会真的改变渲染）：**25 处**
- 另有「同特异性、无条件」的死声明：168 处（覆盖架构下的正常噪声，不在此列）

实测佐证：`.page-body` 的 padding 在 1200 / 1000 / 900 / 760 / 700 / 600px
**始终是 `20px 24px 28px`**，而 ≤900px 本应是 `16px 18px 24px`、≤768px 本应是
`12px 14px 20px`。

### 影响评估（这是不改的理由）

把矩阵扩展到 **768 / 640px** 重跑：**横向溢出 0、对比度问题 0、不可点击元素 0**。
逐项量了实际值：

| 元素 | 现值（各宽度恒定） | 响应式本想给 | 差值 |
|---|---|---|---|
| `.page-body` | `20px 24px 28px` | ≤768px: `12px 14px 20px` | 左右各 10px |
| `.page-header` | `12px 16px 10px` | ≤768px: `12px 14px` | 2px |
| `.app-header` | `0px 16px` | ≤640px: `0px 12px` | 4px |
| `.data-split` | `clamp(320px,31%,420px) minmax(0,1fr)` | ≤760px: `1fr`（堆叠） | 不堆叠 |

**没有一处构成功能故障**：不溢出、点得到、看得清。差异是「该收紧的留白没收紧」，
量级是 2–10px。

### 为什么没有直接改

第一反应是「把响应式规则搬到最后加载」，甚至「开一个 `@layer responsive` 声明在最后」——
**这两条都不对**，因为 blanket 提升会把**有意为之**的覆盖也一起翻过来：
例如 `console-system.css` 无条件的 `.stat-grid { padding: 0 }` 是新版的刻意设计
（无边框网格），而 global.css 响应式里 `.stat-grid { padding: 14px }` 是旧版遗留。
一旦响应式层整体后置，这个意图就被反转了。

所以这 25 处**必须逐条判断**，不能机械搬运：

- 该修（留白收紧，意图明确）：`.page-body`、`.wb-header`、`.wb-input-bar`、
  `.user-access-editor`、`.data-overview`、`.chat-result-inline` 宽度、
  `.brand-text small` 隐藏、`.stat-value` 字号、`.message-row` gap
- 有疑义（新版刻意设计，或旧值已不适用）：`.stat-grid`（新版 padding 应为 0）、
  三处 `border-right-color: currentcolor`、`.ui-filter-bar`（8px vs 10px，差 2px）、
  `.brand` 的 min-width 阶梯（≤640px 时侧栏是抽屉，未必可见）

### 建议

若要动，最小改动是把这 25 处**逐条**搬进一个声明在最后的 `@layer responsive`，
每搬一条都在 900 / 768 / 640 三个宽度上量一次。这比 per-file 拆层的价值大得多 ——
**响应式被架空是真实存在的缺陷，而 per-file 拆层只是可维护性偏好。**

### 本轮实际改动

- 删除 `global.css` 的裸标题规则（前置 1，见上一节）。它是死的：
  10 条路由上 70 个标题，**没有一个**渲染成它的 `font-weight: 720`。
- `.page-body.no-pad` 的倒置是**潜在的**而非实际的：它特异性 0-2-0，
  压得住后置的 0-1-0 规则，实测 `/settings` 的 padding 确为 `0px`，当前正常工作。
  只有拆层之后才会坏。
