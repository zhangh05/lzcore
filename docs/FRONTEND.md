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

topology_updated 只携资源 ID/version。画布以最后确认版本对账：已保存则采纳；非重叠本地编辑三方合并；同字段、删除/编辑和依赖链路冲突要明确解决。snapshot_complete=false 不能替换完整画布。变更卡标明已显示/待处理、差量和移除对象，可聚焦及撤销；撤销拒绝覆盖后来的重叠改动。

固定联动组按整体移动；明确成员坐标优先，解除 lock_group 才独立。布局保护组内相对位置与固定区域。区域 auto_fit 和手工几何有不同职责；批注独立版本保存。工具保存成功和几何 feedback 不能代替视觉验收。

接口使用 Cytoscape 原生端点标签：平行线控制点间距 144，裁剪曲线 22%/78% 位置按弧长换算偏移；拖动、布局或链路变化更新几何，平移缩放不改变图纸位置，自环保留原生端点偏移。性能策略减少拖动重复计算；大图流畅度仍需目标硬件评测。

## 身份与异步

登录采用 HttpOnly Cookie；临时 token 只用 sessionStorage，不进 URL/localStorage/日志/构建变量。VITE_API_BASE 决定 API 与实时 origin；本地 token 探测合并并发并缓存 local_token_unused，临时故障可重试。fetch SSE 保留跨分片 CRLF、事件名、多行数据和 ID；Agent 会话 SSE 未接入生产者。

异步详情核对请求序号和资源 ID，旧返回不能覆盖新选择。附件失败保留草稿和失败项，仅移除成功上传项。删除保留各资源原有硬删除及确认语义。

## 视觉和可访问性

Token 在 frontend/src/styles/global.css。深浅主题复用语义色；--ui-scale=0.8 是统一比例边界，不能另用 transform:scale 改命中区。间距、字号、圆角、控件、焦点、移动触摸目标消费共享 Token，不硬编码第二品牌色。

样式顺序：global.css → product-shell.css → console-system.css → AgentWorkbench.css。工作台消息与输入填满中间列，管理页使用可用空间；--w-reading 只约束空状态，不再要求固定正文宽度。历史 design-qa.md 只描述当时截图。

主从页用于选择/详情，连续行用于数据索引；颜色表达选择或业务状态，避免装饰卡片。Button 图标提供可访问名称，DataTable 行支持 Enter/Space，ModalShell/PortalModal 限制焦点、支持 Escape 并恢复触发器焦点。异步覆盖加载、空、错误、成功、警告与未知状态。

900px 以下 Sidebar 为抽屉，工作台进度有时间线入口；760px 以下收紧密度并保留表格横向操作。路由焦点进入 #main；长文本换行或省略，不覆盖元数据。

## 验证

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint:tokens
npm --prefix frontend test -- --run
npm --prefix frontend run build
npm --prefix frontend run e2e
```

涉及 UI 还要检查实际请求、认证、主路径、窄屏、键盘、弹窗、长文本和错误。截图只证明当时视觉，自动化不是所有机器的帧率或原生窗口验收。
