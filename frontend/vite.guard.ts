/**
 * Dev / preview server guard.
 *
 * 阶段 7 切流后 frontend-next 就是产品前端：start.sh / start.ps1 会用产品默认端口
 * （Vite 5273，后端 8011）启动它。守卫因此不再拒绝 8011 / 5273，但仍保持：
 *
 * - 代理目标必须显式设置 `VITE_DEV_API_TARGET`；没有任何默认后端，不会悄悄回退。
 * - 代理目标只允许 `http://127.0.0.1:<port>`（端口必须显式写出）。
 * - Vite 监听地址默认只允许 127.0.0.1。部署方已在环境中显式开启局域网访问
 *   （LZCORE_ALLOW_LAN 或 LZCORE_ALLOW_UNAUTHENTICATED_NETWORK，与 start.sh 的网络暴露校验一致）时，
 *   才接受显式给出的地址（如 .env.local 的 FRONTEND_HOST=0.0.0.0）。不带值的 `--host` 始终拒绝。
 * - 代理始终追加 X-Forwarded-For，后端据此识别经代理而来的局域网客户端，不把它们当作本机。
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

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** 部署方是否显式开启了局域网访问（同 backend/core/auth.py 与 start.sh 使用的开关）。 */
export function lanListenAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return ["LZCORE_ALLOW_LAN", "LZCORE_ALLOW_UNAUTHENTICATED_NETWORK"].some((k) => TRUE_VALUES.has(String(env[k] ?? "").trim().toLowerCase()));
}

/**
 * Vite 监听地址守卫：默认只允许 127.0.0.1；显式开启局域网访问时接受显式地址。
 * `--host` 不带值时 Vite 传入 true，始终拒绝（必须写出要监听的地址）。
 */
export function assertLoopbackListenHost(host: unknown, label = "server", env: Record<string, string | undefined> = process.env): string {
  if (host === undefined || host === null || host === "") return LOOPBACK_HOST;
  if (host === LOOPBACK_HOST) return LOOPBACK_HOST;
  if (typeof host === "string" && host.trim() && lanListenAllowed(env)) return host.trim();
  throw new Error(
    `[frontend-next] Vite ${label} 默认只监听 127.0.0.1，拒绝 ${String(host)}。如需局域网访问，请在 .env.local 中开启 LZCORE_ALLOW_LAN=true 并写明 FRONTEND_HOST。`,
  );
}
