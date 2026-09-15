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
| — | 全量前端测试 | **230 通过 / 48 文件**，`tsc -b` 0 错误，`npm run build` 通过 |

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
