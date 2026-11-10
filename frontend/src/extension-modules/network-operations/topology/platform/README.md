# platform 适配层

旧网络扩展拓扑画布（从审计副本 `extensions/network_operations/frontend/` 只读复制，未重写）原本 import 旧 `frontend/src/*`。
这里按同样的模块路径提供最小适配，把旧调用接到新壳：

| 旧模块 | 适配 |
|---|---|
| `api/client` `apiRequest` | 新 `src/api/http.ts`（同源 `/api`，失败抛旧形状 `ApiError`，读请求不自动重试） |
| `api` `sessionsApi` | `/api/sessions` 的 list / get / create / rename |
| `stores/session` | 极小 zustand store：工作区由新壳 URL 注入（`TopologyMount`），不读旧 localStorage |
| `router` | 直接复用新 `src/router.tsx` |
| `desktop/bridge` `desktopDirty` | 汇总未保存键，供 `TopologyMount` 接 `useNavigationGuard`；接入平台桌面宿主 |
| `realtime/turnTransport` | 本地事件总线（`onTopologyUpdated` / `onTransportResumed`）；新工作台 WS 未向画布推送 |
| `utils/userScope` | 用户名与工作区从 store 读，不回落写死的工作区 |
| `components/*`、`utils/format`、`utils/saveBlob` | 旧文件原样复制 |
