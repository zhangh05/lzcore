import { useCallback, useEffect, useRef, useState } from "react";
import type { HttpOutcome } from "../contracts/auth";
import { api, type Query } from "../api/client";

/**
 * GET 读取状态。
 * - loading.slow：等待超过 SLOW_AFTER_MS，界面提示「后端响应较慢」，但不放弃请求（读取没有超时副作用）。
 * - ok.refreshing：正在用缓存数据后台重新读取（stale-while-revalidate）。
 * - ok.refreshError：后台重读失败，仍展示上一次成功读取的数据，并明确标出它可能已过期。
 */
export type Loadable<T> =
  | { state: "idle" }
  | { state: "loading"; slow?: boolean }
  | { state: "ok"; data: T; status: number; at?: number; refreshing?: boolean; refreshError?: HttpOutcome }
  | { state: "error"; outcome: HttpOutcome };

interface CacheEntry { data: unknown; status: number; at: number }

/** 同一 key 在这段时间内视为新鲜：重复挂载（StrictMode、切回同一页）不再发请求。 */
export const FRESH_MS = 2_000;
export const SLOW_AFTER_MS = 3_000;
const MAX_ENTRIES = 300;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HttpOutcome>>();
const listeners = new Map<string, Set<() => void>>();

export function apiKey(path: string, query?: Query): string {
  return `${path}|${JSON.stringify(query ?? {})}`;
}

function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** 同 key 并发读取合并为一个请求。 */
function fetchShared(key: string, path: string, query?: Query): Promise<HttpOutcome> {
  const running = inflight.get(key);
  if (running) return running;
  const p = api.get(path, query).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * 使缓存失效并让已挂载的读取立即重读。写操作成功（或结果未知）后调用，
 * match 为路径前缀（如 "/api/sessions"）或谓词；不传则全部失效。
 */
export function invalidateApi(match?: string | ((path: string) => boolean)) {
  const test = (key: string) => {
    const path = key.slice(0, key.indexOf("|"));
    if (match === undefined) return true;
    return typeof match === "string" ? path.startsWith(match) : match(path);
  };
  for (const key of [...cache.keys()]) if (test(key)) cache.delete(key);
  for (const [key, fns] of listeners) if (test(key)) fns.forEach((fn) => fn());
}

/** 身份变化（退出、切换账号）时清空，避免上一身份的数据被当作当前数据展示。 */
export function clearApiCache() {
  cache.clear();
  inflight.clear();
}

function initial<T>(key: string | null): Loadable<T> {
  if (!key) return { state: "idle" };
  const hit = cache.get(key);
  return hit ? { state: "ok", data: hit.data as T, status: hit.status, at: hit.at } : { state: "loading" };
}

/** GET 读取 hook。path 为 null 时不读取。返回 [状态, 重新读取]。 */
export function useApi<T = Record<string, unknown>>(path: string | null, query?: Query) {
  const key = path ? apiKey(path, query) : null;
  const [value, setValue] = useState<Loadable<T>>(() => initial<T>(key));
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const lastTick = useRef(tick);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!key) return;
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(reload);
    return () => { set!.delete(reload); if (!set!.size) listeners.delete(key); };
  }, [key, reload]);

  useEffect(() => {
    if (!path || !key) { setValue({ state: "idle" }); return; }
    const mine = ++seq.current;
    const forced = lastTick.current !== tick;
    lastTick.current = tick;
    const hit = cache.get(key);
    if (hit && !forced && Date.now() - hit.at < FRESH_MS) {
      setValue({ state: "ok", data: hit.data as T, status: hit.status, at: hit.at });
      return;
    }
    // 有缓存：先展示旧数据并标记后台刷新；无缓存：保留当前成功数据（同 key 重读）或进入 loading。
    setValue((v) => {
      if (hit) return { state: "ok", data: hit.data as T, status: hit.status, at: hit.at, refreshing: true };
      if (v.state === "ok" && !forced) return { state: "loading" };
      return v.state === "ok" ? { ...v, refreshing: true, refreshError: undefined } : { state: "loading" };
    });
    const slowTimer = setTimeout(() => {
      if (mine === seq.current) setValue((v) => (v.state === "loading" ? { state: "loading", slow: true } : v));
    }, SLOW_AFTER_MS);
    void fetchShared(key, path, query).then((o) => {
      clearTimeout(slowTimer);
      if (mine !== seq.current) return;
      if (o.kind === "http" && o.status >= 200 && o.status < 300) {
        const entry = { data: o.body, status: o.status, at: Date.now() };
        remember(key, entry);
        setValue({ state: "ok", data: o.body as T, status: o.status, at: entry.at });
      } else {
        setValue((v) => (v.state === "ok" ? { ...v, refreshing: false, refreshError: o } : { state: "error", outcome: o }));
      }
    });
    return () => clearTimeout(slowTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  return [value, reload] as const;
}

export function listOf<T>(v: Loadable<Record<string, unknown>>, key: string): T[] {
  if (v.state !== "ok") return [];
  const list = (v.data as Record<string, unknown>)?.[key];
  return Array.isArray(list) ? (list as T[]) : [];
}
