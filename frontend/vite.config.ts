/// <reference types="vitest" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { assertLoopbackListenHost, resolveDevApiTarget } from "./vite.guard.ts";

/**
 * frontend-next Vite config（阶段 7 起为产品前端）。
 *
 * - `vite`（dev）与 `vite preview` 都 REQUIRE `VITE_DEV_API_TARGET`；没有默认后端。
 *   缺失 / 非 http://127.0.0.1:<port> 的目标直接中止启动。start.sh / start.ps1
 *   会显式设为 http://127.0.0.1:$BACKEND_PORT（默认 8011）。
 * - 监听地址只允许 127.0.0.1（CLI `--host` 覆盖同样经过守卫）。
 * - 默认端口 5273（产品默认）；`npm run dev` 仍显式用 5280 跑本地 mock 预览。
 * - `vite build` 与 vitest 不启动代理、不联网。
 */
function loopbackOnly(): Plugin {
  return {
    name: "lzcore-loopback-only",
    configResolved(config) {
      if (config.command !== "serve" || process.env.VITEST) return;
      assertLoopbackListenHost(config.server.host, "dev server");
      assertLoopbackListenHost(config.preview.host, "preview server");
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isVitest = Boolean(process.env.VITEST);
  const proxyTarget = command === "serve" && !isVitest
    ? resolveDevApiTarget(process.env.VITE_DEV_API_TARGET ?? env.VITE_DEV_API_TARGET)
    : null;
  const proxy = proxyTarget
    ? {
        "/api": { target: proxyTarget, changeOrigin: false },
        "/__mock": { target: proxyTarget, changeOrigin: false },
        // 工作台 WebSocket（/ws/agent）。目标同样经过 resolveDevApiTarget 守卫。
        "/ws": { target: proxyTarget.replace(/^http/, "ws"), ws: true, changeOrigin: false },
      }
    : undefined;

  return {
    plugins: [react(), loopbackOnly()],
    server: {
      host: "127.0.0.1",
      port: 5273,
      strictPort: true,
      proxy,
    },
    // start.sh 默认以 preview 模式运行产品前端，同样需要 /api、/ws 代理。
    preview: {
      host: "127.0.0.1",
      port: 5273,
      strictPort: true,
      proxy,
    },
    test: {
      globals: true,
      environment: "happy-dom",
      setupFiles: "./src/test/setup.ts",
      css: false,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
  };
});
