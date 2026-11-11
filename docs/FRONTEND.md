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
| 网络设备（清单、拓扑、巡检、上下文） | /extensions/network.operations/manage |
| 网络 Skill（Skill、巡检脚本） | /extensions/network.operations/skills |
| 系统状态与设置 | /system、/system/settings |
| 身份与工作区 | /system/users、/system/workspaces |
| 备份、生态与 worker | /system/backups、/system/ecosystem、/system/workers |

网络扩展 UI 通过 `frontend/src/extension-modules/registry.tsx` 挂载。设备、连接、Skill 与图纸仍由扩展后端管理，前端不能授予权限。网络扩展的当前产品 UI 在 frontend/src/extension-modules/network-operations；根 extensions/network_operations/frontend 仅保留旧版回退桥接。两个入口来自扩展清单的两条 `frontend_routes`，挂同一模块，按挂载路径分派到设备工作区或 Skill 工作区；旧深链 `/manage?tab=skills|scripts` 自动跳到 `/skills`。改清单后需重启后端（扩展清单有缓存）。

## 视觉系统

视觉语言基于 [Arc UI](https://uiarc.dev) 的免费 MIT 基础层：`frontend/src/components/arc/foundation.css`（中性 oklch 色阶、单一强调色、冷色调分类色、柔和分层阴影、焦点规则）与 `lib/motion-tokens.ts`（时长、缓动、弹簧）。基础层不进 CSS layer，同名变量（`--surface`、`--accent`、`--danger` 等）以它为准；`styles/arc-overrides.css` 把控件高度、圆角调到适合高密度控制台的尺寸，并补上中文字体回退；`styles/tokens.css` 的产品变量全部从基础层取值，深色主题随之切换。只有 `tokens.css` 与基础层持有字面颜色；拓扑画布无法读取 CSS 变量，`topologyPalette.ts` 保存换算后的十六进制，并由测试校验与 CSS 一致。字体为 Inter Variable（正文）与 Geist Variable（标题、数字），中文回落到各平台系统字体。需要更多 Arc 组件时，从 `https://uiarc.dev/r/<name>.json` 取免费组件源码放入 `components/arc/`，保留 LICENSE。

## 版式

- 主导航按「做事（工作台、任务、工作流）→ 资料（文件、知识、记忆）→ 扩展区 → 系统」分组平铺，每个入口常显，不靠展开子级寻找；可收起为图标栏（偏好存 `lzcore-next:nav-collapsed`）。资料的分类只在导航里，页内不再重复分类页签。
- 顶栏：工作区切换 │ 面包屑（`app/Breadcrumb.tsx`，从导航表与扩展目录推出「一级入口 › 子页」）… 命令入口、待核对、账户。
- 页头：标题 + 一句面向用户的说明，页面级主操作放在页头右侧；单独一个主按钮的操作行靠右。
- 系统等多子页入口用 `app/SystemLayout.tsx`：主导航只占一项，子页导航在页内左栏（非管理员看不到管理页），窄屏变为横向滚动条。
- 画布型扩展页（网络扩展「拓扑」）：页头只留给读屏，位置由面包屑表达，页签贴顶，画布铺满主区且主区不滚动；画布外围工具栏收紧。
- 网络设备：顶部「设备概览」四格（设备数、连接健康条、需关注、最近巡检），下方主从布局——左侧设备清单带搜索与健康筛选（全部 / 需关注 / 未测试），右侧设备详情；连接以卡片挂在所属设备下，测试、指纹确认、删除都在卡片里完成，选中设备存在 `?device=`。
- 网络 Skill：顶部三步流程（设备与连接 → 编排 Skill → 发布到工作台）带实时计数，Skill 与巡检脚本以卡片网格呈现，卡片给出发布状态、范围计数、审批标记、工具与命令预览。
- 模型服务（`pages/system/ModelSettings.tsx`）：顶部「当前模型」卡显示状态、端点与一键连通测试（含耗时）；下方分「已接入」（有密钥、当前、本机地址或自定义的服务）与「添加模型服务」画廊。点画廊或「配置」打开侧边抽屉：协议、名称、API Key（可显隐）、模型（带建议），高级项收起地址、温度与 max_tokens；「测试连接」用抽屉里的草稿参数直接探测，不落盘；可「保存」或「保存并设为当前」。非平台管理员不能改已有服务的地址。
- 强调色为 Arc `blue`（`index.html` 的 `data-accent`）：主按钮、当前导航、页签指示、链接与焦点用强调色，结构保持中性。拓扑画布的选中色随之取同一值，测试按 `data-accent` 解析校验。

## 框架合同

工作区来自已认证的 GET /api/workspaces，不伪造默认身份。Skill 与 resource_ids 来自服务端目录，使用 metadata.workbench_selection；后端重新校验范围与权限。附件使用托管 file.file_id，不使用 artifact_id 替代原件身份。个人模式写请求、multipart 与实时消息沿用内存 local-token，不将令牌持久化。

工作台通过 WebSocket /ws/agent 发起和续传回合，client_request_id 标识请求。断线只续传/回读，不自动重发写入。终态消息和 task-state 来自服务端；工具尝试、用户目标、作业队列状态和未知写入分别呈现。未知写入仅核对，不自动重放。当前实时连接在工作台组件卸载时释放，不能声称已恢复旧版所有跨页回合体验。

子 Agent 进展来自 `agent.manage` 结果与实时 `subagent_observation` 事件，按 `subtask_id` 分组、取最新 `observation_revision`；工具信封成功不代表子任务完成，`content_complete=false` 或执行未知显示为待核对。回合进行中把 `tool_call`/`tool_result` 投影为步骤列表，仅作展示，终态以服务端为准。网络设备读取与巡检结果由扩展证据渲染器呈现（部分回显、不可达、写入未知、完整证据原件）。资料文件按 `mime_type` 预览：图片、音视频与 PDF 走 `/api/storage/files/<id>/preview`，其余读取文本内容，二进制提示下载。

读取经 `frontend/src/kit/useApi.ts`：同 key 合并请求、缓存后台刷新、超过 3 秒提示较慢、刷新失败保留上次数据并标明可能过期；退出登录清空缓存。待核对优先读 `/api/runtime/session-tasks`，旧后端回退逐会话 task-state。

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

`frontend-legacy/` 保留切换前完整源码与原浏览器回归，默认不启动。旧回归的断言证明旧实现的兼容基线，新版浏览器检查单独运行；不能把旧版通过项算作新版能力验收。切换记录与未迁移能力见 [2026-11-09 切换记录](validation/frontend-cutover-20261109.md)。没有通过这次源码切换宣称 Windows 原生、真实模型或真实设备验收。
