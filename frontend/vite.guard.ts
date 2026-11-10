/**
 * Dev / preview server guard.
 *
 * 阶段 7 切流后 frontend-next 就是产品前端：start.sh / start.ps1 会用产品默认端口
 * （Vite 5273，后端 8011）启动它。守卫因此不再拒绝 8011 / 5273，但仍保持：
 *
 * - 代理目标必须显式设置 `VITE_DEV_API_TARGET`；没有任何默认后端，不会悄悄回退。
 * - 代理目标只允许 `http://127.0.0.1:<port>`（端口必须显式写出）。
 * - Vite 监听地址只允许 127.0.0.1；拒绝 0.0.0.0、::、局域网地址以及不带值的 `--host`。
 */
export const LOOPBACK_HOST = "127.0.0.1";

export function resolveDevApiTarget(raw: string | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    throw new Error(
      "[frontend-next] VITE_DEV_API_TARGET 未设置。必须显式指向本机后端或 mock，例如 VITE_DEV_API_TARGET=http://127.0.0.1:8011（start.sh 会自动设置）或 http://127.0.0.1:19001（本地 mock）。不会回退到任何默认后端。",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[frontend-next] VITE_DEV_API_TARGET 不是合法 URL：${value}`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`[frontend-next] VITE_DEV_API_TARGET 只允许 http://127.0.0.1:<port>：${value}`);
  }
  if (url.hostname !== LOOPBACK_HOST) {
    throw new Error(`[frontend-next] VITE_DEV_API_TARGET 只允许 127.0.0.1：${value}`);
  }
  if (!url.port) {
    throw new Error(`[frontend-next] VITE_DEV_API_TARGET 必须显式写端口（http://127.0.0.1:<port>）：${value}`);
  }
  if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`[frontend-next] VITE_DEV_API_TARGET 只能是 http://127.0.0.1:<port>，不得带路径、查询或凭据：${value}`);
  }
  return `${url.protocol}//${url.host}`;
}

/** Vite 监听地址守卫：只允许 127.0.0.1（`--host` 不带值时 Vite 传入 true，同样拒绝）。 */
export function assertLoopbackListenHost(host: unknown, label = "server"): string {
  if (host === undefined || host === null || host === "") return LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(
      `[frontend-next] Vite ${label} 只允许监听 127.0.0.1，拒绝 ${String(host)}（不暴露到 0.0.0.0 / 局域网）。`,
    );
  }
  return LOOPBACK_HOST;
}
