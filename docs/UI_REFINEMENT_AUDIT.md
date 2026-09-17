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

- **/topology 检视器当时没被验证，而且结论下错了。** 它在 900px 和 1200px 下都测得
  0×0、`display:none`，`querySelectorAll` 命中的节点类元素数为 **0**，
  于是我写下「本工作区没有设备，没有可选中的东西」。**这是错的。**
  Cytoscape 把节点画在 `<canvas>` 上，DOM 里**不存在**对应元素；
  实例挂在 `container._cyreg.cy` 上，实际有 **2 个设备节点 + 2 个图纸图元**。
  这是今天第四次「度量方式会骗人」，方向是**拿 DOM 去数一个非 DOM 渲染器画出来的东西**。
  数它要用 `cy.nodes()`，不是 `querySelectorAll`。详见第十一节。
- 本轮改动**全是颜色**（令牌 + 8 处引用），不改变盒模型，因此未重跑几何探针。

---

## 十、响应式层被整体架空（已修，见第十二节）

`shadow_cssom.py`（**新增，已入库**）用浏览器 CSSOM 取代手写的 CSS 解析 ——
手写版丢了 `@media` 嵌套，产出全是垃圾。CSSOM 直接给出准确顺序、准确选择器、
以及规则是否位于媒体查询内。

### 发现

媒体查询**不增加特异性**。而 `product-shell.css` / `console-system.css` /
`typography.css` 都在 `global.css` **之后**加载，且其中的基础规则是**无条件**的。
于是 global.css 里所有同选择器的响应式覆盖**全部失效**：

- 响应式覆盖被后置无条件规则压掉：**82 条声明、31 个块**（订正，见下）
- 另有「同特异性、无条件」的死声明：168 处（覆盖架构下的正常噪声，不在此列）

**计数订正（2026-09-17）**：初版报「29 处 / 25 处」，两个数都错了。
`shadow_values.py` 当时拿**整条选择器字符串**做比较，于是
`.chat-bubble, .chat-bubble.user, .chat-result-inline { width: ... }` 这种分组规则
永远匹配不上后面单独的 `.chat-result-inline { ... }`，藏在里面的死声明全部漏掉。
按**选择器逐项拆分**后是 82 条 / 31 个块（多出的 23 条里有 `.app-nav` 的
`display: none`、`.page-header` 的 `min-height`、`.ui-detail-panel` 的 padding 等）。
这是当天第五次「度量方式会骗人」，这次是**比较的粒度太粗**。

同时初版把「取值不同」直接写成「重放后会真的改变渲染」—— **这句是错的**，
「死的」不等于「缺的」，订正见本节末。

实测佐证：`.page-body` 的 padding 在 1200 / 1000 / 900 / 760 / 700 / 600px
**始终是 `20px 24px 28px`**，而 ≤900px 本应是 `16px 18px 24px`、≤768px 本应是
`12px 14px 20px`。

### 影响评估

把矩阵扩展到 **768 / 640px** 重跑：**横向溢出 0、对比度问题 0、不可点击元素 0**。
global.css 想要的收紧确实没有发生（`.page-body` 各宽度恒为 `20px 24px 28px`），
但**这不等于功能故障**：不溢出、点得到、看得清，差异是「该收紧的留白没收紧」，
量级 2–10px。

### 为什么不能整体后置

第一反应是「把响应式规则搬到最后加载」，甚至「开一个 `@layer responsive` 声明在最后」——
**整体后置不对**，因为 blanket 提升会把**有意为之**的覆盖也一起翻过来：
`console-system.css` 无条件的 `.stat-grid { padding: 0 }` 是新版的刻意设计
（无边框网格），而 global.css 响应式里 `.stat-grid { padding: 14px }` 是旧版遗留。

### 订正（2026-09-17）：多数不是「丢失」，而是「被替换」

上面这版结论只做了一半功课 —— 它证明了「这些声明是死的」，
却把「死的」直接当成了「缺的」。逐条量下来，绝大多数是**新版在别处重新实现了**：

| 选择器 | global.css 想给 | 现在实际由谁负责 |
|---|---|---|
| `.app-nav` ≤900 | `display: none` | `product-shell.css` 同宽度也写了 `display: none`，**已生效** |
| `.brand` min-width 阶梯 | 150 / 124 / 112px | `product-shell.css` ≤1180 定 154px、≤900 定 0 |
| `.app-header` | `0 12px` | `product-shell.css` ≤1180 用 `--space-4` |
| `.page-header.ui-page-header` | `16px 18px 12px` | `console-system.css` ≤900 定 `12px 16px 10px` |
| `.data-split` ≤760 | `1fr` | `console-system.css` ≤900 已堆叠 |
| `.data-overview` ≤760 | `18px 14px 28px` | `console-system.css` ≤760 定 `--space-3`（**比旧值更紧**） |
| `.user-access-editor` ≤620 | `12px` | `console-system.css` 已收紧 |
| `.chat-result-inline` | `width: 100%` | 现行聊天布局已是 `width: 100%; max-width: none` |
| 三处 `border-right-color` | `currentcolor` | `console-system.css` 改用 `--console-border-soft` |

**真正的缺口只有一个**：`typography.css` 把页面节奏（`--page-gutter` 24px、
`--flow-loose` 20px、`--flow-block` 28px）**只声明一次、永不变动**，
所以建立在节奏体系上的页面在窄屏下不会收紧。修法与验证见第十二节。

### 本轮实际改动

- 删除 `global.css` 的裸标题规则（前置 1，见上一节）。它是死的：
  10 条路由上 70 个标题，**没有一个**渲染成它的 `font-weight: 720`。
- `.page-body.no-pad` 的倒置是**潜在的**而非实际的：它特异性 0-2-0，
  压得住后置的 0-1-0 规则，实测 `/settings` 的 padding 确为 `0px`，当前正常工作。
  只有拆层之后才会坏。

---

## 十一、网络拓扑拖拽「会飘」：两个叠在一起的缺陷（已修）

用户报告：「网络拓扑，选中设备后拖动，会飘」。`NetOpsCanvas.tsx` 里的对齐吸附
是唯一的可疑点，用真实鼠标拖拽 + 包裹 `node.position()` 抓到了两件事 ——
它们**叠在一起**，但根因不同。

### 缺陷 1：把邻居的线坐标写进了本节点的中心（瞬移）

`snapAxis` 原本把命中的**目标线坐标**直接赋给被拖节点的**中心**：

```js
if (snappedX) x = snappedX.value;   // value 是邻居的线，不是本节点的中心
```

吸附判定拿本节点的三条线（近边、中心、远边）去比邻居的三条线，共 9 种配对。
只有当**本节点的边**对上**邻居的中心**时错位才最大：节点中心被搬到邻居中心上，
一次跳掉半个自身尺寸（`NODE_HALF_W` 47 / `NODE_HALF_H` 38）。

实测轨迹（指针匀速下移 15px×6，模型坐标）：

```
-146 → -129.22 → -146 → -129.22 → -146 → -129.22 → -146
```

**在两个位置之间来回弹，最后回到起点。** 指针走了 90 屏幕 px，节点净位移为 0。
这就是「飘」：节点跟不上指针，并且在原地抖。

### 缺陷 2：吸附把指针位移「吃掉」，小步长下节点被钉死

Cytoscape 的节点拖拽是**增量式**的（新位置 = 当前位置 + 指针位移），
这一点用注入实验确认过：拖拽中途把节点强行挪到 x=900，下一次拖拽事件
从 x=900 继续，而不是回到指针隐含的位置。

而吸附每帧**改写绝对位置**。于是吸附量等于**吞掉了等量的指针位移**。
当每帧位移小于 `SNAP`（5 模型 px）时，下一帧的原始位置仍然落在吸附窗口内，
**再次被吸回去 —— 节点永远出不来**。真实鼠标的位移恰恰是这种小步长。

跟随率实测（纵向 40 步）：

| 每帧指针位移 | 修复前跟随率 | 修复后 |
|---|---|---|
| 2 屏幕 px | — | **100.0%** |
| 3 屏幕 px | **0.0%**（节点纹丝不动） | **100.0%** |
| 6 屏幕 px | 14.2%（只走了 `NODE_HALF_H` 就卡住） | **100.0%** |
| 14 屏幕 px | 100%（步长够大，逃得掉） | **100.0%** |

「3px 一步 → 0%」是最能说明问题的一行：**指针在走，节点完全不动**。

### 修复

两处，都在 `NetOpsCanvas.tsx` 的 `drag` 处理器里：

1. `snapAxis` 返回**位移**而不是新坐标：`shift = target - candidate`，
   参考线画在邻居那条线上（`line = target`）而不是本节点中心。
2. 新增 `snapResidualRef` 记录上一帧吸附把节点推离指针隐含位置多远，
   每帧先**减掉**它再吸附。这样吸附量不再累积、也不再钉死：
   指针离开窗口时节点最多落后 `SNAP`，随后立刻跟上。

```js
const rawX = position.x - residual.x;          // 指针真正要求的位置
const nextX = rawX + (snappedX?.shift ?? 0);   // 只做有界的修正
snapResidualRef.current = { x: nextX - rawX }; // 记下来，下一帧还回去
```

`free` / `dragfree` 时清零。

### 验证

判据不是「步长中位数比」—— 修复后节点会**刻意停在参考线上**若干帧，
中位数为 0，比值失去意义。正确判据是**绝对上界**：
单步最大位移 ≤ `SNAP` + 一帧指针位移。

| 用例 | 跟随率 | 最大单步 | 上界 | 参考线 | 判定 |
|---|---|---|---|---|---|
| 小步纵向 3px×40 | 100.0% | 5.96 | 6.83 | 出现 6 帧 | 正常 |
| 中步纵向 7px×30 | 100.0% | 4.27 | 9.27 | 未出现 | 正常 |
| 大步纵向 14px×24 | 100.0% | 8.55 | 13.55 | 未出现 | 正常 |
| 小步横向 3px×40 | 100.0% | 1.83 | 6.83 | 未出现 | 正常 |

`npx tsc -b --noEmit` 0 错误。

### 一个必须先排除的假象

第一轮测量得出「节点比指针多走了 5.29%」，看着像又一个 bug。
**不是。** `global.css:298` 在应用根上有 `zoom: var(--ui-scale)`（0.95），
Cytoscape 对此一无所知：它的 `renderedPosition()` 是容器局部坐标，而指针是屏幕坐标。
按每帧算清楚就闭合了：`8.95 模型 px × cy.zoom 0.941 × 0.95 = 8.00 屏幕 px`，
与指针步长分毫不差。**若照第一轮的结论去「修」缩放换算，会把一个本来正确的渲染改坏。**

### 数据卫生（教训）

`dragfree` 会把位置写回后端（`onMoveElements` → `PUT /topologies/<id>`）。
**所以任何真实拖拽测试都会污染用户数据。** 本次测试把 AR1 从 `(677,-70)`
拖到了 `(1257,-146)`（version 103 → 106），事后已按测试前的值还原（version 107）。
后续验证脚本改为 `route.abort()` 拦掉写回请求，只跑渲染与拖拽逻辑，不再落盘。

---

## 十二、窄屏节奏：只修真正的缺口（已修）

第十节的结论是「响应式层被架空」，订正后真正的缺口只有一句话：
**页面节奏令牌不是响应式的。**

`typography.css` 把 `--page-gutter`（24px）、`--flow-loose`（20px）、
`--flow-block`（28px）声明在 `:root` 上，**一次，无条件**。`.page-body` 与
`.page-header` 的 padding 都取自这三个令牌，所以它们在任何宽度下都一模一样 ——
1200px 和 600px 的页面留白完全相同。`global.css` 当年想收紧，写下的
`@media (max-width: 768px) { .page-body { padding: 12px 14px 20px } }`
被后置的无条件规则压掉，从此没人再碰过。

### 修法

新增 `src/styles/responsive.css`，落在**声明在最后的 `@layer responsive`** 里
（`layers.css` 的顺序改为 `product, extension, responsive`）。
层之间不看特异性只看顺序，所以这里的规则一定压得住 `product` 里的无条件规则，
而不用管谁先谁后加载。

令牌是**就地重声明**的，不是写死 padding：

```css
@media (max-width: 900px) {
  .page-header, .page-body {
    --page-gutter: 18px; --flow-loose: 16px; --flow-block: 24px;
  }
}
```

这样 `.page-body` 拿到 `16px 18px 24px`、`.page-header` 拿到 `16px 18px 12px`，
两者的左右边距仍然是**同一个令牌**，不会再出现「页头 26px、页身 24px」那种错位
（见 `typography.css` 里 `--page-gutter` 的注释）。

### 验证

`responsive_probe.py`（**新增，已入库**）在 7 个宽度 × 11 条路由 = **77 个组合**上
记录 25 个选择器的计算值，改动前后各跑一次，差异即效果。

结果：**149 处计算值变化，落在 8 个 (选择器, 属性) 上，全部是收紧方向，其余一律没动。**

| 选择器 | 属性 | 宽度 | 变化 |
|---|---|---|---|
| `.page-body` | padding | ≤900 / ≤760 | `20px 24px 28px` → `16px 18px 24px` / `12px 14px 20px` |
| `.page-header` | padding | ≤900 / ≤760 | `20px 24px 12px` → `16px 18px 12px` / `12px 14px` |
| `.brand-text small` | display | ≤900 | `block` → `none` |
| `.brand-text > span` | font-size | ≤640 | `16px` → `13px` |
| `.stat-value` | font-size | ≤900 | `24px` → `18px` |
| `.wb-header` | padding | ≤768 | `0 18px` → `0 12px` |
| `.wb-input-bar` | padding | ≤768 | `8px 12px` → `6px 12px` |
| `.app-header` | padding | ≤640 | `0 16px` → `0 12px` |

`npx tsc -b --noEmit` 0 错误；`qa_matrix.py 900 768 640` 复跑仍是
**溢出 0 / 对比度问题 0 / 不可点击 0**。

### 有两条「想当然的修复」反而会改坏 —— 被量出来挡下了

先按「global.css 想要什么就恢复什么」写了一版，把 31 个块里看着合理的全搬进去，
再量一次，diff 立刻指出两条是**倒退**：

| 规则 | 现值 | 我差点改成 | 问题 |
|---|---|---|---|
| `.app-nav-item` padding | 9px | 10px | 新版**更紧**，我把它放松了 |
| `.data-overview` padding | `12px`（`--space-3`） | `18px 14px 28px` | 新版更紧，我把它放大且改成非对称 |

还有三条（`.data-split`、`.user-access-editor`、`.ui-detail-panel`）**改了等于没改** ——
`console-system.css` 早就做过了 —— 也一并删掉。

于是最终文件只剩 8 条，每一条都有 diff 作证。**「旧代码想要什么」不是恢复的理由，
「现在缺什么」才是。**

### 方法论

这一节推翻了同一份文档里两次先前的判断，两次都是度量方式的问题：

1. **粒度太粗**：比较整条选择器字符串，漏掉分组规则里的死声明（29 → 82）。
2. **把「不同」当成「缺失」**：取值不同 ≠ 渲染不同，因为可能有第三条规则已经提供了它。
   `.app-nav { display: none }` 就是例子 —— 它确实死了，但 `product-shell.css`
   在同宽度写了同样的一条，导航其实是隐藏的。

所以最终的判据不是静态分析，而是**在真实宽度上量计算值，再做前后 diff**。
静态工具（`shadow_cssom.py` / `shadow_values.py`）负责**缩小范围**，
`responsive_probe.py` 负责**下结论**。

## 十三、画布项的标签跑到框外（已修）

**报告**：网络拓扑里那个虚线文本框，「没对齐」。

### 这一节为什么不能靠读样式表

Cytoscape 把节点和标签都画在 `<canvas>` 上，**DOM 里没有任何元素可查**。
样式表能告诉你「意图」，不能告诉你「结果」，而这个缺陷恰恰是**意图与语义不符** ——
读一百遍 `"text-halign": "left"` 也只会读出「左对齐，看着挺合理」。

唯一的真相在像素里。

### 两个叠在一起的缺陷

| # | 现象 | 量出来的值 | 根因 |
|---|---|---|---|
| 1 | 标签整个在虚线框**外面**，贴着左边 | 相对自身中心 **dx = −149.1px**，字形左边缘离框左沿还有 43px | `.canvas-item-text` 写了 `text-halign: left` |
| 2 | 标签比框的中心**偏低** | 文本框 dy = **+10.7px**，椭圆 dy = **+10.5px** | 共享的 `node` 规则有 `text-margin-y: 8px`，画布项从没重置它 |

**缺陷 1 的语义坑**：`text-halign` 指的是**标签挂在节点的哪一侧**，不是**文字在框内怎么对齐**。
`left` = 挂在左侧（也就是框外面）。设备节点用的 `text-valign: bottom` 是同一个语义 —— 名字挂在图标下方。
想让多行文字在块内左读，属性叫 `text-justification`。

**缺陷 2 的由来**：`node` 规则给所有节点标签加了 8px 下移，这对「名字在图标下方」的设备是对的，
对「名字在自己框中间」的画布项是错的。画布项只覆盖了 `text-valign`，没覆盖 `text-margin-y`，
于是两个画布项的标签都低了 10px 左右 —— 椭圆那个肉眼几乎看不出来，文本框那个因为框只有 36px 高就很显眼。

### 修法

```tsx
// .canvas-item
"text-margin-y": 0,          // 新增：画布项的标签居中于自身，不要继承设备标签的下移
// .canvas-item-text
"text-halign": "center",     // 原为 "left" —— 那个值把标签整个推到框外
"text-justification": "left" // 新增：多行时行内左读
```

### 验证（在渲染器自己的像素空间里量）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 文本框 `123` | dx = **−149.1**，dy = +10.7，**在框外** | dx = **−0.5**，dy = **−0.8**，**在框内** |
| 椭圆 `业务域` | dx = +0.0，dy = **+10.5**，偏低 | dx = **−0.1**，dy = **−1.2**，居中 |

**设备标签未受影响**：`.canvas-item` 不匹配 `manual-node` / `managed-node`，
计算值仍是 `valign=bottom marginY=8px`。`npx tsc -b --noEmit` 0 错误。

### 度量方式又骗了我两次（第五、第六次）

这一节的结论来得比前几节慢，因为探针本身错了两次，而**两次的错误看起来都像「缺陷」**。

1. **参考点用错了坐标系**。先用 `getBoundingClientRect()`（页面坐标）加 `renderedPosition()`
   （容器坐标）算节点中心 —— 容器的边框盒**不是**它 canvas 的原点，两者差约 30px。
   于是探针稳定地报出「椭圆标签偏左 27px」，而它其实**分毫不差**。
   转机是**校准**：椭圆的 `dx` 应该是 0（它本来就是居中的），一量不是 0，
   就知道错的是参考点而不是标签。**改到 canvas 自己的像素空间里量（`getImageData`），
   和 `renderedPosition()` 同源，换算全部消失。**
2. **隔离没生效，读到了上一帧**。`cy.style()` 的改动要等下一次渲染才生效，
   在同一个同步调用里立刻读像素，拿到的是**改之前**那一帧 ——
   两个不同的项读出了**完全相同**的字形框，这才暴露出来。
   拆成「改样式 → 等一帧 → 读像素 → 还原」四步才干净。

**教训**：探针报出一个「整齐的偏差」（27px、30px 这种整数级的平移）时，
先怀疑**坐标系**，再怀疑被测对象。而「两个不同的被测对象得到完全相同的测量值」
几乎一定是探针坏了 —— 不是巧合。

## 十四、拖动设备「有概率闪到其他位置」（已修）

**报告**：「拖动设备，还是有概率，设备会闪到其他位置」。注意是**有概率** —— 这是竞态。

上一节修的是吸附算法本身（跟手率 0% → 100%）。这一节是完全不同的一类：
**节点被拖得好好的，外部把它的位置写回去了。**

### 两条路径，都不认识「用户正在拖」

| # | 路径 | 守卫 | 窗口 |
|---|---|---|---|
| 1 | `executeSave` 成功后 `setActiveTopology(res.topology)` | `revision === revisionRef.current`（**只统计已提交的编辑**） | PUT 往返 |
| 2 | 保存成功后 `onReload()` → 列表刷新 → `useEffect([currentTopology])` 里 `setActiveTopology(currentTopology)` | `saveStatusRef !== "saved"`（**与拖拽无关**） | 整个 `load()` 往返（6 个并发 GET） |

第 2 条窗口宽得多，也更隐蔽：它藏在 `TopologyWorkspace.tsx` 里一个只依赖
「列表对象变了」的 effect 中。两条路最后都汇到 `applyElements` 的
`existing.position(next.position)`。

**为什么「有概率」**：拖拽只在 `dragfree` 时提交，所以拖拽进行中 `revision` 没变，
守卫形同虚设；只有在「上一次拖拽的保存响应落地」与「这一次拖拽进行中」重叠时才触发。

### 复现方法（关键是扣住响应，不是延迟）

拖一次并提交，让防抖保存发出；用 `route.fetch()` **让请求真正写到服务端**，
但**扣住响应不返回**；此时再抓住同一个节点开始第二次拖拽；然后手动放行响应。

- 用 `time.sleep` 在 route handler 里延迟是**不行**的：它会阻塞拖拽所依赖的同一个事件循环。
- 用合成响应（不写服务端）也**不行**：服务端会停留在旧状态，随后 `onReload()` 拉回旧坐标，
  探针污染了自己的测量 —— 第一次尝试就栽在这上面。

### 结果

| | 响应落地瞬间位移 | 落点 |
|---|---|---|
| 修复前（3/3 次） | **+33.8 / +37.6 / +42.2** model px | 上一次拖拽的静止位置 |
| 修复后（3/3 次） | **0.0 / 0.0 / 0.0** | 不动 |

典型一次：节点在 `(584.4, −38.6)`、`grabbed=True`，响应一到就弹回 `(611.0, −20.0)` ——
第 1 次拖拽的静止位置，**指针还按着**，而第 2 次拖拽的位移被整个丢弃。

### 修法

修在**所有外部位置写入的汇合点**：

```tsx
// applyElements —— 正在被指针抓住的节点，不接受外部写入
if (syncPositions && existing.isNode() && next.position && !(existing as CyNode).grabbed()) {
```

**为什么修在这里而不是修那两条路径**：只有画布知道「用户正抓着哪个节点」。
状态机（冲突合并 / 撤销重做）很微妙，不动它。

**反向验证（守卫不能太宽）**：把一个**没人拖**的节点强行挪到 `(999,999)`，
再走一次正常的保存往返 —— 它被正常拉回提交位置 `(128,−177)`。
说明只挡住了正在被拖的那一个，正常的服务端同步没有被误伤。

`npx tsc -b --noEmit` 0 错误。探针入库：`frontend/scripts/drag_race_probe.py`（跑完自动复原节点位置）。

---

## 十五、侧边栏一开，工具栏按钮就重叠（已修）

**报告**：「侧边栏一开，按钮就重叠了」。放大用户截图后能直接读出结论 ——
`… 插入 | 撤销 | 对[齐] | 重做 …`，**「对齐」被「撤销」压在下面，只露出一个「齐」字。**

### 一个「父盒子看不出来」的缺陷

工具栏 `.topology-editbar` 是 `justify-content: space-between`，左边一组画布工具
（`选择 连线 插入 对齐`），右边一组动作（`撤销 重做 新建链路 …`）。两条规则凑出了这个结果：

| 元素 | 规则 | 后果 |
|---|---|---|
| `.studio-edit-tools` | `min-width: 0` + `overflow: visible` | **可以被压到 8px**，而 `nowrap` 的子按钮照旧画出去 |
| `.toolbar-right` | `flex: 0 0 auto` | 一步不让，于是被压出去的那组正好盖在它头上 |
| `.topology-editbar` | `flex-wrap: wrap` **只写在 `@media (max-width: 1180px)` 里** | 1180 以上没有兜底 |

**所以「组盒子的矩形相交」这个判据是错的** —— 探针一开始就报了 `groupsIntersect: false`
而按钮明明重叠着。子元素溢出了父盒子，父盒子的矩形当然不相交。
判据必须落到**每一个按钮的矩形两两相交**上。

### 修复前：19 / 40 个「宽度 × 面板」组合重叠

| 视口 | 无面板 | 设备库 | 详情栏 | Agent |
|---|---|---|---|---|
| 1920 / 1705 | 0 | 0 | 0 | 0 |
| 1600 | 0 | 0 | 1 | 2 |
| 1500 | 0 | 1 | 3 | 5 |
| 1440 | 0 | 3 | 5 | 7 |
| 1366 | 0 | 4 | 7 | 7 |
| 1280 | **1** | 7 | 7 | 7 |
| 1200 | **3** | 7 | 7 | 7 |
| **1180 及以下** | **0** | **0** | **0** | **0** |

单元格 = 重叠的控制对数。左组最多被压缩 **241px**。

两个读数值得单独说：

- **1180 及以下是干净的**，因为那条媒体查询在那里生效。会撞车的区间恰好是
  **1181–1600**：规则离修好它只差一个像素，却只在最不需要它的地方生效。
- **1280 / 1200 在「无面板」时就已经重叠了**（1 对 / 3 对）。侧边栏不是原因，
  只是把它放大到看得见。用户是在开侧栏时注意到的，缺陷本身不依赖侧栏。

### 修法：把换行提到基础规则

```css
/* 基础规则，不再藏在媒体查询里 */
.topology-studio .topology-editbar { … flex-wrap: wrap; … }
```

左组一旦不会低于自身内容宽度，溢出就不会发生。**但这一改立刻暴露出第二个缺陷** ——
同一个探针加了一条断言就抓到了：

> 换行后 `.toolbar-right` 被单独放到一行，而它自己是 `flex: 0 0 auto` + `flex-wrap: nowrap`：
> **868px，不缩不断**。一行装不下它，尾巴就伸到工具栏外面去，盖住下面的画布说明文字。

**13 / 40 个格子出现了这个溢出**，最差的溢出 308px，肇事者永远是末尾的 `.studio-more`（更多）。
它其实**在 1180px 以下早就存在**（那里的媒体查询本来就在换行），只是没有人看过。

```css
.topology-studio .topology-editbar > .toolbar-right { flex: 0 1 auto; flex-wrap: wrap; }
```

`flex-shrink: 1` 让它能被压缩到行宽，`flex-wrap: wrap` 让它的按钮接着往下排。
**不加 `flex-grow`** —— 两个组能同处一行时，`space-between` 仍把它顶到右边
（实测 1920px 下右组右边缘 1904.8 vs 工具栏内边缘 1904.0，与修复前一致）。
**选择器限定到 `.topology-editbar >`**：上面的 `.topology-canvas-toolbar` 是固定 54px 一行，
在那里换行会变成竖向溢出。

### 结果

| 断言 | 修复前 | 修复后 |
|---|---|---|
| 控制对重叠 | 19 / 40 格 | **0 / 40** |
| 控制件溢出工具栏 | 13 / 40 格（1180 以下本来就存在） | **0 / 40** |
| 左组被压缩 | 最多 241px | **0px** |
| 1920 / 1705 下工具栏高度 | 45px（单行） | **45px（不变）** |

高度只在真正需要时增长：1600/详情栏 82px（两行）、1366/详情栏 117px（三行）。
1180 及以下与修复前完全一致。

### 留下的东西

`frontend/scripts/editbar_overlap_probe.py` —— 10 个宽度 × 4 个面板的矩阵，
面板全部通过**真实控件**打开（设备库按钮 / 更多 → 查看详情 / Agent 协作），
双断言（不重叠 + 不溢出），退出码可当门禁，`--shot DIR` 顺手留图。

**这一节真正的教训**：把「两个东西撞在一起」修成「换行」时，
**换行本身会造出一个新的容器，而新容器也需要一条约束**。
只验证「重叠消失了」就会带着一个更隐蔽的溢出上线 —— 所以断言要一次写全。

## 十六、多选设备，与「照 eNSP / HCL 那样加设备」（已修）

**报告**两条：「多选设备功能没有」，以及「我觉得一个很好的参照就是华为的 ensp 和华三的 HCL，
这是真的好用，建议你参考人家的画布实现、设备添加等」。
第二条是建议不是缺陷，但它指向的问题是真的：这台画布加设备的手感，和用户熟悉的那两个工具是反的。

### 16.1 多选：不是没有，是**只有一条路进得去**

先把「没有」变成一个有答案的问题 —— 逐手势量了一遍：

| 手势 | 修复前 | 修复后 |
|---|---|---|
| 单击 A | 1 | 1 |
| ⌘ / Ctrl / Shift + 单击 B | **1**（点多少次都加不进来） | 2 |
| ⌘ + 再单击 B | — | 1（移出选区） |
| Shift + 拖框 | 2 | 2 |
| ⌘ + 拖框 | **平移画布** | 2（追加） |
| ⌘ + A | 4 | 4 |

根因是每次 `tap` 都以 `cy.elements().unselect()` 收尾、然后只选中被点的那个，
**所以没有任何一次点击能长出一个选区**；唯一的入口是 Shift + 拖框，
而它的提示只在按住 Shift **之后**才出现 —— 用户不会先去按一个不知道存在的修饰键。

另外量到：`boxSelectionEnabled(false)` 把 Cytoscape 自带的框选关掉了，
于是 **Ctrl/⌘ + 拖 被静默地当成平移**（一个凭直觉就会做、结果做了反事的手势）。

修法三条：

1. **点击按修饰键决定语义** —— Ctrl/⌘ 切换、Shift 追加。
2. **`boxSelectionEnabled(true)`** —— 框选交回 Cytoscape，它本来就在 Ctrl/⌘ + 拖 上武装，
   普通拖动仍然是平移。这是 eNSP 和 HCL 都用的手势，白捡。
3. **框选从覆盖层搬到捕获阶段的命中测试监听器上**（见下）。

**一个必须写下来的细节**：Ctrl/⌘ + 单击要能**取消选中**，就需要「点击之前」的选区；
而它在 `tap` 里读不到 —— **Cytoscape 在 `tap` 触发前就已经把自己的选区改动应用完了**，
再读只会读回同一个集合，于是永远取消不掉。只能在捕获阶段的 `mousedown` 里抢拍。

### 16.2 一个盖住全画布的覆盖层，分辨不出「按在设备上」和「按在空白处」

原来 Shift 框选是靠一个 `position:absolute; inset:0; z-index:6` 的 React 覆盖层实现的。
它分不清按在设备上还是空白处，于是**两者都被它吞掉**：Shift + 单击设备不是加选，而是**清空选区**
（量到 `cy=0`），而且按住 Shift 时设备根本拖不动。

换成**捕获阶段的 `document` 监听 + 先做几何命中测试**（`nodeUnderPointer`）：
只有按点确实落在空白处才消费事件，落在设备上就交还给 Cytoscape。

### 16.3 照 eNSP / HCL 改设备添加：先选型号，再点画布

改之前：左栏列的是**已登记设备**（拖一个资产上去），而纯图纸设备要走「新建图纸设备」弹窗 ——
**想放一台防火墙，得先给它起名字，才能看见它。**

eNSP 和 HCL 都是反过来的：左栏一列**型号**，选型号 → 点画布，两个手势、零弹窗，
先落一台 `Router1`，要改名后面再改。照这个做：

- 左栏新增「图纸设备」区，六个型号（路由器 / 交换机 / 防火墙 / 服务器 / 云 / 无线 AP），
  可点选（武装）也可拖拽；
- 点选后画布进入待放置：光标 `copy` + 顶部提示条「在空白处单击放置设备 · Esc 取消」；
- 落点用 Cytoscape 报的模型坐标，名字自动生成且**不重号**（删掉 路由器2 再放一台不会又出一台 路由器2）；
- **点已有对象 = 取消待放置**，而不是在它头上再摞一台；Esc 同样取消；
- 拖拽用**独立的 MIME 类型**（`application/x-lzcore-node-type`）和已登记设备的
  `application/x-lzcore-device-id` 区分开 —— 否则一台**名叫「路由器」的设备**和一次
  **拖拽「路由器」型号**无法分辨；
- 老弹窗保留在「需要先定名称？新建图纸设备…」链接后面，因为确实有先定名字的场景。

### 16.4 这一轮真正的坑：探针会**悄悄把用户的图挪走**

量到画布上莫名多了 6 台 `防火墙`（前几次探针崩溃留下的），而更要命的是另一件事：
**`AR1` 从 `(292,503) 漂到了 (362,542)`。**

根因是 `interface_label_probe.py` 里那次「真实拖动」——**拖完从不复位**。
真实拖动是会落盘的，于是**每跑一次，用户的图就被挪一点**，而探针的输出只说「标签活下来了」，
一个字都没提它改动了画布。**这是靠读拓扑文件发现的，不是靠读脚本。**

由此串出一条完整的因果链，也解释了之前那个「≥5 台设备时点击命中位置偏 40px」的怪现象：
**画布上的设备越多，这个偏移越容易出现**；而设备之所以多，正是因为前几次探针崩溃没清干净。
**探针留下的脏数据，变成了下一次探针的假故障。**

修法与纪律：

- `interface_label_probe.py` 现在先记下坐标、跑完通过产品自己的 `PUT` 接口写回，
  并且会打印 `复原 AR1: (362.0, 542.0) → (292, 503)`。**不手改 JSON 文件** ——
  版本号和修订历史归应用所有，直接写文件会让两者失配。
- 新增 `frontend/scripts/canvas_cleanup.py`：只删不在保留名单里的节点，
  走产品自己的「选中 → Delete → 确认移除」，前后都打印集合。
- **探针必须证明自己碰到了目标**：落点先用 `document.elementFromPoint` 验证在画布上，
  否则抛「探针自身失效」，**绝不把一次没落上的点击当成产品故障上报**。
- **每个小节都从整页刷新开始**，否则探针量的是自己的历史。

### 16.5 验证

| 探针 | 结果 |
|---|---|
| `multiselect_probe.py` | **12 项断言 0 失败**；多选整体移动刚性偏差 **0.00px**；空白拖动仍平移 126.4px |
| `device_add_probe.py` | **8 项断言 0 失败**（干净画布上） |
| `interface_label_probe.py` | **6/6**，且现在会自行复原拖动 |
| `drag_flash_probe.py --trials 4` | **16/16**，抓取偏移突变 ≤5.6px、刚性偏差 0.0px、异常 0/4 |
| `reload_stale_probe.py` | 迟到的重载没有覆盖更新的本地状态 |
| `editbar_overlap_probe.py` | 40 个组合 **0 个重叠** |

`tsc -b --noEmit` 通过，`vite build` 通过。

### 16.6 当时没解决的（**已在第十七节查明并修复**）

**设备数 ≥5 时，渲染器的命中测试和 `renderedPosition()` 会差约 40px。**
5×5 网格扫描量到：节点的 `renderedPosition()` 处点下去命中的是**背景**，
而节点实际应答点击的位置在它上方约 40px。`cy.fit()` 和画布自带的「适配」按钮都躲不开，
**只有把图变小才不复现**。当时只影响探针，没有观察到影响真实用户手势，所以没有动产品代码。

> **后续**：这个「只有设备多才出现」的现象，正是**根因**的指纹 ——
> 偏移量正比于节点离容器原点的距离，设备越多、`fit` 把节点铺得越开，偏移就越大。
> 它**不是探针问题，是产品缺陷**，见第十七节。

## 十七、两个像素空间：画布上一半的手算坐标都是错的（已修）

**来源**是十六节留下的那个「未解决」项：设备数 ≥5 时命中位置偏约 40px。
当时的判断是「只影响探针」，**这个判断是错的**。

### 根因：`getBoundingClientRect()` 和渲染器的坐标不在同一个空间

应用在 `<body>` 上有 `zoom: 0.95`（`--ui-scale`）。于是：

| 来源 | 单位 | 实测 |
|---|---|---|
| `getBoundingClientRect()` | **视觉像素**（已被 0.95 缩过） | `rect.width = 1272.8` |
| `host.clientWidth` | **布局像素** | `clientWidth = 1340` |
| `cy.pan()` / `zoom()` / `renderedPosition()` / `width()` | **布局像素** | — |

两者之比实测 **0.9499 / 0.9497**，也就是那个 0.95。

**把它们相减而不乘这个比例，误差正比于离容器原点的距离**：
`误差 = rp.y × 0.05`。画布高 760 布局像素，所以最差 **38px** ——
比一台设备本身还高（设备视觉半高约 39px）。
**「设备越多越容易复现」正是因为 `fit` 把节点铺开后，`rp.y` 变大了。**

### 症状：Shift + 拖设备时，设备拖不动，反而拉出一个框

`nodeUnderPointer` 决定一次按压「归 Cytoscape（设备）」还是「归框选」。
它算出的点比设备实际位置低 38px，于是**按在设备上被判成按在空白处**：

```
按压点（确实在设备上，对照单击 tap 命中该节点）  clientY = 739.6
产品命中测试算出的位置                          cyY    = 799.7
相差 60.1px   vs   判据容差 43.2px
→ 判为空白画布 → 框选抢走这次按压
```

**而 Cytoscape 自己的命中测试一直是对的** —— 它全程待在自己的空间里。
这就解释了为什么**单击设备从来没问题，只有手算坐标的那几处出问题**。

### 一共六处，全部改成走同一个换算

| 位置 | 用途 | 后果 |
|---|---|---|
| `nodeUnderPointer` | 框选前的命中测试 | 按在设备上被判为空白，设备拖不动 |
| `handleDrop` | 拖放落点 | 设备落点偏移最多 38px |
| 待放置落点回退分支 | 点空白处放设备 | 同上 |
| `nodeAtClient` | 框选起点的设备判定 | 同 `nodeUnderPointer` |
| 小地图点击 | 换算回模型坐标 | 点击定位偏移 |
| `clientPoint` / `pointInHost` | 框选框的 CSS 偏移 | 框选框与指针差最多 5% 画布高 |

统一为两个函数：`hostScale()` 量出比例，`toHostPoint()` 把指针换算进容器的**布局像素**。
改完后 `getBoundingClientRect()` 只出现在这两个函数里。

### 判据（都是渲染值，不是读代码）

| 断言 | 旧算法 | 新算法 |
|---|---|---|
| 该点是否落在设备上（新算法 28.9px < 容差 45.2px） | 60.1px → **否** | **是** |
| Shift + 按在设备上（A/B 实测） | **出现框选**（缺陷复现） | 未出现 |
| 空白处按下仍起框选 | 出现 | 出现（功能还在） |
| 框选框 `style.top` | 85.5（视觉像素） | **89.8**，期望 90.0 |

**A/B 是临时把 `nodeUnderPointer` 改回旧算法跑出来的** —— 不改回去，就没法证明
「框选不出现」是因为修好了，而不是因为这条断言本来就抓不到东西。

### 附带收获：探针也在同一个坑里

`device_add_probe` / `multiselect_probe` / `interface_label_probe` / `drag_flash_probe`
**都用手算坐标定位**，也就是说它们一直在系统性地往设备下方偏最多 38px 点，
**只是因为设备够大才没露馅**。这正是一路以来那些「间歇性探针失效」的来源。
四个探针已一并改用同一比例。

### 又一次「探针量到了自己的历史」

第一版回归探针报「缺陷仍在」，其实是它**先普通单击一次做对照**（为了证明落点在设备上），
而那次单击会打开右侧详情栏、让画布重排：

```
点击前 rect.top = 149.7  clientWidth = 1340
点击后 rect.top = 186.5  clientWidth = 1020     ← 画布整体下移 37px
设备的 rp/zoom 完全没变（606.4,650.0 / 1.085）
```

**落点在点击前算好、点击后使用，就整整过期 37px**，那个点已经落到设备上方 64px 的空白处了。
修法：**每个小节都从整页刷新开始**，对照与实测各用一次加载。

### 留下的东西

`frontend/scripts/marquee_hit_probe.py` —— 四项断言（对照 / 设备上 / 空白处 / 几何），
每节独立加载，跑完把设备坐标写回。**它自己也验证过反向**：
把 `nodeUnderPointer` 临时改回旧算法，它必须失败。





