# 前端：产品入口与框架合同

产品源码位于 `frontend/`，React 18、TypeScript、Vite、Zustand、Lucide 图标与 Motion 动效；入口 `frontend/src/main.tsx`，共享壳 `frontend/src/app/AppShell.tsx`，导航 `frontend/src/contracts/naming.ts`，路由 `frontend/src/app/routes.tsx`。默认启动、Docker、桌面宿主与 Windows 打包继续沿用 frontend/dist，不变更后端或运行数据目录。

## 当前路由

| 页面 | 路由 |
| --- | --- |
| 工作台 | /workbench |
| 任务 | /tasks |
| 文件、知识、记忆 | /library/files、/library/knowledge、/library/memory |
| 工作流 | /workflows |
| 扩展目录 | /extensions |
| 网络设备（清单与连接、巡检、观察记录） | /extensions/network.operations/manage |
| 网络拓扑（拓扑画布） | /extensions/network.operations/topology |
| 网络 Skill（Skill、巡检脚本） | /extensions/network.operations/skills |
| 系统状态与设置 | /system、/system/settings |
| 身份与工作区 | /system/users、/system/workspaces |
| 备份、生态与 worker | /system/backups、/system/ecosystem、/system/workers |

网络扩展 UI 通过 `frontend/src/extension-modules/registry.tsx` 挂载。设备、连接、Skill 与图纸仍由扩展后端管理，前端不能授予权限。网络扩展的当前产品 UI 在 frontend/src/extension-modules/network-operations；旧版扩展前端已删除，清单里的 `frontend_modules` 只作为路由标识。三个入口来自扩展清单的三条 `frontend_routes`，互相独立，挂同一模块按挂载路径分派；旧深链 `/manage?tab=topologies` 跳到 `/topology`（保留 `topology`、`node`），`/manage?tab=skills|scripts` 跳到 `/skills`。改清单后需重启后端（扩展清单有缓存）。

## 视觉系统

视觉语言采用微软 [Fluent 2](https://fluent2.microsoft.design)，按 Windows 11 原生应用的方式排版：导航和标题栏在 Mica 底色上，页面内容放在左上角圆角的内容层上，用细描边而不是阴影分层。数值全部取自 Fluent 2 web 主题（`@fluentui/tokens` 的 webLight/webDark）和 Windows 11 材质，写在 `styles/arc-overrides.css`：中性色阶、品牌蓝 `#0f6cbd`（深色 `#479ef5`）、状态色、阴影阶梯（卡片无阴影，浮层 shadow16，对话框 shadow64）、圆角（控件 4px，卡片/浮层/对话框 8px）、字重只用 400/600、字体 Segoe UI Variable（中文回落微软雅黑 UI / 苹方）、等宽 Cascadia Mono。动效用 Fluent 曲线：入场 decelerateMax `cubic-bezier(.1,.9,.2,1)`，状态变化 easyEase；页面切换上移 12px 淡入 300ms，浮层从锚点滑入 10px，对话框从 0.96 放大，导航选中指示条在项目之间滑动，输入框聚焦时底部品牌色下划线从中间展开；`prefers-reduced-motion` 时全部关闭。控件按 Fluent 规范：按钮有 standard / primary / subtle 三种外观，按下时只变底色不缩放；页签是文字加 3px 下划线；徽标 4px 圆角带同色细描边。

`components/arc/` 仍是控件实现（CSS Modules + Motion + Radix，保留 LICENSE），样式已改为 Fluent；基础层 `foundation.css` 不进 CSS layer，`arc-overrides.css` 紧随其后覆盖它，`styles/tokens.css` 的产品变量从这两层取值，深色主题随之切换。只有 `tokens.css`、`arc-overrides.css` 与基础层持有字面颜色；拓扑画布无法读取 CSS 变量，`topologyPalette.ts` 保存同值的十六进制，并由测试校验与 CSS 一致。

## 版式

- 主导航按「做事（工作台、任务、工作流）→ 资料（文件、知识、记忆）→ 扩展区 → 系统」分组平铺，每个入口常显，不靠展开子级寻找；可收起为图标栏（偏好存 `lzcore-next:nav-collapsed`）。资料的分类只在导航里，页内不再重复分类页签。
- 顶栏：工作区切换 │ 面包屑（`app/Breadcrumb.tsx`，从导航表与扩展目录推出「一级入口 › 子页」）… 命令入口、账户。不提供全局「待核对」收件箱；任务和工作台的「去核对」深链到 `/review?source=&id=` 的单条核对面板。
- 页头：标题 + 一句面向用户的说明，页面级主操作放在页头右侧；单独一个主按钮的操作行靠右。
- 系统等多子页入口用 `app/SystemLayout.tsx`：主导航只占一项，子页导航在页内左栏（非管理员看不到管理页），窄屏变为横向滚动条。
- 画布型扩展页（网络扩展「拓扑」）：页头只留给读屏，位置由面包屑表达，页签贴顶，画布铺满主区且主区不滚动；画布外围工具栏收紧。
- 网络设备：顶部 MetricCard 一行（设备、连接健康、需关注、巡检），页签「设备 / 巡检 / 观察记录」；设备页签是主从布局——左侧清单带 SearchField 与 SegmentedControl 健康筛选（全部 / 需关注 / 未测试），右侧设备详情，连接以卡片挂在所属设备下（测试、指纹确认、删除），选中设备存在 `?device=`。
- 网络拓扑：独占整页的画布，离开页面或换图前有未保存守卫。
- 网络 Skill：顶部 MetricCard 一行（已发布、草稿、写入需审批、巡检脚本），Skill 与巡检脚本以卡片网格呈现；不再挂设备页的入口。
- 模型服务（`pages/system/ModelSettings.tsx`）：顶部「当前模型」卡显示状态、端点与一键连通测试（含耗时）；下方分「已接入」（有密钥、当前、本机地址或自定义的服务）与「添加模型服务」画廊。点画廊或「配置」打开 Arc Drawer：协议、名称、接口地址、API Key（PasswordField）、模型；填好地址与密钥（本机地址可不填密钥）后自动调用 `POST /api/agent/llm/models` 获取模型列表，用 Combobox 搜索选择，也可切换手动输入，获取失败给出原因；高级项是温度（Slider）与 max_tokens。「测试连接」用抽屉里的草稿参数直接探测，不落盘；可「保存」或「保存并设为当前」。非平台管理员不能改已有服务的地址。
- 强调色是 Fluent 品牌蓝：主按钮、导航与页签的选中指示、链接与焦点用强调色，结构保持中性；悬停、按下、选中用 Windows 11 的半透明中性填充（`--subtle-hover` / `--subtle-pressed` / `--subtle-selected`），不用强调色染底。拓扑画布的选中色取同一值。

## 框架合同

工作区来自已认证的 GET /api/workspaces，不伪造默认身份。Skill 与 resource_ids 来自服务端目录，使用 metadata.workbench_selection；后端重新校验范围与权限。附件使用托管 file.file_id，不使用 artifact_id 替代原件身份。个人模式写请求、multipart 与实时消息沿用内存 local-token，不将令牌持久化。

工作台通过 WebSocket /ws/agent 发起和续传回合，client_request_id 标识请求。断线只续传/回读，不自动重发写入。终态消息和 task-state 来自服务端；工具尝试、用户目标、作业队列状态和未知写入分别呈现。未知写入仅核对，不自动重放。当前实时连接在工作台组件卸载时释放，不能声称已恢复旧版所有跨页回合体验。

子 Agent 进展来自 `agent.manage` 结果与实时 `subagent_observation` 事件，按 `subtask_id` 分组、取最新 `observation_revision`；工具信封成功不代表子任务完成，`content_complete=false` 或执行未知显示为待核对。回合进行中把 `tool_call`/`tool_result` 投影为步骤列表，仅作展示，终态以服务端为准。网络设备读取与巡检结果由扩展证据渲染器呈现（部分回显、不可达、写入未知、完整证据原件）。资料文件按 `mime_type` 预览：图片、音视频与 PDF 走 `/api/storage/files/<id>/preview`，其余读取文本内容，二进制提示下载。

读取经 `frontend/src/kit/useApi.ts`：同 key 合并请求、缓存后台刷新、超过 3 秒提示较慢、刷新失败保留上次数据并标明可能过期；退出登录清空缓存。

助手终态使用既有安全 Markdown 渲染，流式阶段保留轻量纯文本路径。布局按可用宽度将导航、会话与进度移入抽屉，关闭恢复焦点；宽桌面保留辅助栏。

## 启动与验证

在仓库根运行 `bash start.sh`；脚本设置 VITE_DEV_API_TARGET 指向本机后端。未设置 `BACKEND_HOST` / `FRONTEND_HOST` 时默认监听 0.0.0.0；只有在没有任何认证（登录 / 身份 / API token）也没有显式 `LZCORE_ALLOW_UNAUTHENTICATED_NETWORK` 时回落到 127.0.0.1，前端还需 `LZCORE_ALLOW_LAN` 才会监听 0.0.0.0（规则见 `scripts/startup_security.sh` 的 `startup_security_default_hosts`）。手动 Vite 开发/preview 必须显式设置该变量，目标只接受 http://127.0.0.1 的显式端口；监听默认127.0.0.1，仅当环境显式开启 `LZCORE_ALLOW_LAN` 或 `LZCORE_ALLOW_UNAUTHENTICATED_NETWORK` 时接受 `FRONTEND_HOST` 指定的地址（如 0.0.0.0）。代理追加 X-Forwarded-For，后端据此把经代理的局域网客户端与本机区分开。生产 Nginx 提供同源 API 与 WebSocket 代理。

```bash
npm --prefix frontend ci
npm --prefix frontend run verify
npm --prefix frontend run lint:tokens
npm --prefix frontend run build
npm --prefix frontend run e2e
```

切换前的 `frontend-legacy/` 及其浏览器回归已于 v4.1.0 后删除，可从 git 历史（v4.1.0 及以前的 tag）取回。切换记录见 [2026-11-09 切换记录](validation/frontend-cutover-20261109.md)。
