# 前端开发入口

源码在 src/；使用 React、TypeScript、Vite、Zustand、Axios，测试使用 Vitest 和 Playwright。业务状态、授权和终态来自后端。

```bash
npm ci
npm run dev -- --host 127.0.0.1
npm run typecheck
npm run lint:tokens
npm test -- --run
npm run build
npm run e2e
```

在 frontend/ 执行。开发端口 5273，/api 代理由 VITE_DEV_API_TARGET 设置，默认 http://127.0.0.1:8011。分离部署用 VITE_API_BASE；不要将凭据编译到环境变量。

app/App.tsx 装配路由，api/ 处理资源与实时通道，stores/ 保留视图状态，pages/layouts/components 实现界面，types/ 描述 API，test/ 和 e2e/ 验证。

页面不持有回合连接、不合成权限；发送用户原话和独立选区。详见 [前端合同](../docs/FRONTEND.md) 和 [API](../docs/API.md)。
