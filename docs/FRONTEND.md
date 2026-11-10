# 前端：产品入口与框架合同

产品源码位于 `frontend/`，React 18、TypeScript、Vite、Zustand 与 Phosphor Icons；入口 `frontend/src/main.tsx`，共享壳 `frontend/src/app/AppShell.tsx`，导航 `frontend/src/contracts/naming.ts`，路由 `frontend/src/app/routes.tsx`。默认启动、Docker、桌面宿主与 Windows 打包继续沿用 frontend/dist，不变更后端或运行数据目录。

## 当前路由

| 页面 | 路由 |
| --- | --- |
| 工作台 | /workbench |
| 任务 | /tasks |
| 文件、知识、记忆 | /library/files、/library/knowledge、/library/memory |
| 工作流 | /workflows |
| 扩展目录 | /extensions |
| 网络扩展 | /extensions/network.operations/manage |
| 系统状态与设置 | /system、/system/settings |
| 身份与工作区 | /system/users、/system/workspaces |
| 备份、生态与 worker | /system/backups、/system/ecosystem、/system/workers |

网络扩展 UI 通过 `frontend/src/extension-modules/registry.tsx` 挂载。设备、连接、Skill 与图纸仍由扩展后端管理，前端不能授予权限。网络扩展的当前产品 UI 在 frontend/src/extension-modules/network-operations；根 extensions/network_operations/frontend 仅保留旧版回退桥接。

## 框架合同

工作区来自已认证的 GET /api/workspaces，不伪造默认身份。Skill 与 resource_ids 来自服务端目录，使用 metadata.workbench_selection；后端重新校验范围与权限。附件使用托管 file.file_id，不使用 artifact_id 替代原件身份。个人模式写请求、multipart 与实时消息沿用内存 local-token，不将令牌持久化。

工作台通过 WebSocket /ws/agent 发起和续传回合，client_request_id 标识请求。断线只续传/回读，不自动重发写入。终态消息和 task-state 来自服务端；工具尝试、用户目标、作业队列状态和未知写入分别呈现。未知写入仅核对，不自动重放。当前实时连接在工作台组件卸载时释放，不能声称已恢复旧版所有跨页回合体验。

助手终态使用既有安全 Markdown 渲染，流式阶段保留轻量纯文本路径。布局按可用宽度将导航、会话与进度移入抽屉，关闭恢复焦点；宽桌面保留辅助栏。

## 启动与验证

在仓库根运行 `bash start.sh`；脚本设置 VITE_DEV_API_TARGET 指向本机后端。手动 Vite 开发/preview 必须显式设置该变量，目标只接受 http://127.0.0.1 的显式端口；监听默认127.0.0.1。生产 Nginx 提供同源 API 与 WebSocket 代理。

```bash
npm --prefix frontend ci
npm --prefix frontend run verify
npm --prefix frontend run lint:tokens
npm --prefix frontend run build
npm --prefix frontend run e2e
```

`frontend-legacy/` 保留切换前完整源码与原浏览器回归，默认不启动。旧回归的断言证明旧实现的兼容基线，新版浏览器检查单独运行；不能把旧版通过项算作新版能力验收。切换记录与未迁移能力见 [2026-11-09 切换记录](validation/frontend-cutover-20261109.md)。没有通过这次源码切换宣称 Windows 原生、真实模型或真实设备验收。
