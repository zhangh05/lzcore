# 新会话续接提示词（可直接复制）

把下面代码块里的内容整段粘贴给新会话即可。

```text
继续 LZCore（联智中枢）的 UI 精修工作。仓库在 /Users/zhangh01/Desktop/lzcore。
这是既有项目的精修，不是重写 —— 保留现有信息架构、Design System、业务语义与测试契约。

## 已完成（不要重做）

规范 Phase 1–6 大部分已落地，另有拓扑缺陷修复。关键提交：
- CSS 层序声明（styles/layers.css）+ 扩展边界；单层 `product` 是**刻意**的选择（见下）
- 技术元数据体系（.meta / .meta-label / .meta-fact，mono + tabular）
- Workbench：Context Bar 56→44px、空状态 Composer 优先、助手回复去气泡、思考块权重修正
- Runtime Rail：RUN/ELAPSED/TOOLS 真实元数据、阶段摘要优先展开、无时间戳则不显示时长
- Timeline：显式阶段分类（调度/推理/上下文/工具/校验/恢复/审批/答复），颜色只表达结果
- 原语收口四项：SearchInput（5 处）、Badge（状态）、metric-chip（计数）、EmptyState（2 角色）、SegmentedControl（radiogroup）
- 拓扑：拖动修复、文本框可见边界、移除冗余模式、椭圆插入、搜索定位居中、批量面板可达、Delete 整批删除、链路状态多通道
- 登录页品牌化、记忆页/知识库行化、诊断状态改 Badge、语义色与分类色板解耦

详细过程与证据在 docs/UI_REFINEMENT_AUDIT.md（含第八节的实施进度表）。

## 待办（按建议顺序）

### 1. 共享样式细拆层（最高价值，需要多轮迭代）
现状：`product` 是单层。细拆成 base/shell/console/workbench/typography/runtime **会改变渲染结果** ——
因为 `@layer` 是「层序优先」，而旧级联是「特异性优先、顺序兜底」。

**实测**：临时拆层后 10 条路由移动 207 个盒子；聚类后**只有 7 个真实规则冲突**，其余是连带后果：

| # | 冲突 | 拆层前 → 后 | 次数 |
|---|---|---|---|
| 1 | `.btn` 字号 | 12px → 13px | 40 |
| 2 | `.empty` 高度 | 29px → 150px | 12 |
| 3 | `.input` 宽度 | 193.7 → 240px | 11 |
| 4 | `.card` 高度 | 230.9 → 269.5px | 6 |
| 5 | `.page-header` 高度 | 80.6 → 84.7px | 5 |
| 6 | `.stat-grid` 行高 | 74.6 → 70px | 2 |
| 7 | `.card` 圆角 | 12px → 8px | 1 |

**方法（每步可独立验证、可安全中断）**：
1. 对每个冲突找到互相竞争的两条规则，确定哪个值是有意的，让两者一致。
   判据：**保持单层**的前提下探针差异必须为 0（视觉不变）。
2. 7 个全部消解后再应用细拆，差异应为 0。
3. 仍有差异 → 还有未发现的冲突，回到第 1 步。

### 2. Data / Capabilities 列表行化
与已完成的记忆页、知识库同类问题（列表项被做成卡片）。有现成范式可照搬：
「一个容器 + 行分隔线 + 元数据行」，见 MemoryPage 与 KnowledgeLibrary。

### 3. 响应式 + QA 矩阵（纯核对，无需设计决策）
- 响应式：≤900px 全站（抽屉、进度轨、Inspector、主从堆叠）
- QA：11 页 × 亮/暗 × 1200/1440/1920/≤900
- Motion：110–240ms 全站核对

### 明确不做（有理由，不是遗漏）
- 命令面板：当前 API 不支撑真实跨域检索，做了就是假搜索
- 多人实时协同：产品级决策；已从「冲突报错」推进到「三方合并 + 待确认清单」

## 工具（已入库）

- `frontend/scripts/layout_probe.py`：10 路由 × 25 选择器 × 计算几何与级联敏感属性
- `frontend/scripts/layout_diff.py <before.json> <after.json>`
用法：改前跑一次、改后跑一次、对比。**纯重构的判据是差异为 0**；有意改动必须能逐条解释。

## 环境

- 后端：`cd lzcore && set -a && . ./.env.local && set +a && .venv/bin/python backend/main.py --port 8011`
  （用 Bash 工具的 run_in_background 启动；改了 service.py/backend.py 必须重启）
- 前端 5273 是 **preview 模式（服务 dist）**：改完源码必须 `npm run build` 才生效
- 前端测试：`cd frontend && npx tsc -b && npm run build && npx vitest run`（当前 244 通过 / 50 文件）
- 后端测试：`.venv/bin/python -m pytest harness/...`（测试放 harness/，不是 tests/）
- e2e：`cd frontend && npx playwright test e2e/<spec>`，自带隔离后端 18011 / 前端 15273，不碰开发数据
- 浏览器验证用 `.venv` 里的 python playwright（node 侧没装），注意 `NO_PROXY='*'`

## 工作约定（都已验证过，请遵守）

1. **先复现再改**。这一天的多数缺陷（拖动、文本框、批量面板、Delete、定位偏移）
   代码审查和单测都抓不到，只有像用户一样走流程才暴露。用**可观察结果**当判据
   （服务端状态、弹窗是否出现、像素），不要用「看起来对」。
2. **断言必须具体**。我曾用「检视器里含『接口』」判断是否选中链路，结果节点检视器也含这两个字 → 假通过。
3. **比较布局必须同尺寸**。我拿 1200 宽的探针数据和 1440 宽的手动测量对比过，差点得出错误结论。
4. **验证不了就如实标注边界**，不要声称「看起来是对的」。
   已知两处：登录页（本地 `auth_type: none`，登录页不渲染）、知识库结果行（工作区 0 文档）、
   链路点线（探针索引不符，对比未跑完）。
5. **提交前看 `git log`**：这个仓库有并行工作线在提交，要核对它改的文件与你的改动是否重叠。
6. **不要盲信审计的数量**。今天四次出现「表象 ≠ 结论」：
   4 种徽标里 1 种不是徽标、5 种空状态是 2 个角色、2 种标签页是两种东西、
   1 处「颜色违规」其实是语义色被错接分类色板。**先看语义，再决定合并还是归位。**
7. **不要造假数据**。字段拿不到就不渲染（例：Runtime Rail 没有时间戳就不显示时长），
   绝不用 `trace_id` 顶替 `run_id`。加装饰性的假 RUN/TRACE 会破坏整个产品的可信度。

## 两个环境坑

- 这个环境里 **bash 的多模式 `grep "a\|b"` 不可靠**（多次返回空结果）→ 用 Grep 工具。
- `ls dir | head || mkdir dir` 里的 `mkdir` **永远不会执行**（管道返回码取 head 的）→ 显式 `mkdir -p`。

## 记忆文件

工作日志：/Users/zhangh01/Desktop/workspace/workbuddy/1/.workbuddy-ai/memory/2026-09-15.md
（含这一天的完整过程、每个缺陷的根因、以及被推翻的判断）
```
