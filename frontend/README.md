# 联智中枢产品前端

这是默认产品前端，保持正式工程 frontend/ 路径。回退实现位于 ../frontend-legacy/。

在仓库根运行 bash start.sh。单独开发：

```bash
npm --prefix frontend ci
VITE_DEV_API_TARGET=http://127.0.0.1:8011 npm --prefix frontend run dev
npm --prefix frontend run verify
npm --prefix frontend run build
npm --prefix frontend run e2e
```

开发及 preview 监听127.0.0.1；API/实时消息同源代理至显式本机目标。离线合成 mock 可使用 mock/mock_server.py；产品默认启动不使用 mock。

[接口与迁移边界](../docs/FRONTEND.md)。
