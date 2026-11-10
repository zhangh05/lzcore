import { useCallback, useEffect, useRef, useState } from "react";
import type { HttpOutcome } from "../contracts/auth";
import { api, type Query } from "../api/client";

export type Loadable<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T; status: number }
  | { state: "error"; outcome: HttpOutcome };

/** GET 读取 hook。path 为 null 时不读取。 */
export function useApi<T = Record<string, unknown>>(path: string | null, query?: Query) {
  const [value, setValue] = useState<Loadable<T>>(path ? { state: "loading" } : { state: "idle" });
  const [tick, setTick] = useState(0);
  const key = path ? `${path}|${JSON.stringify(query ?? {})}` : null;
  const seq = useRef(0);
  useEffect(() => {
    if (!path) { setValue({ state: "idle" }); return; }
    const mine = ++seq.current;
    setValue((v) => (v.state === "ok" ? v : { state: "loading" }));
    void api.get(path, query).then((o) => {
      if (mine !== seq.current) return;
      if (o.kind === "http" && o.status >= 200 && o.status < 300) setValue({ state: "ok", data: o.body as T, status: o.status });
      else setValue({ state: "error", outcome: o });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return [value, reload] as const;
}

export function listOf<T>(v: Loadable<Record<string, unknown>>, key: string): T[] {
  if (v.state !== "ok") return [];
  const list = (v.data as Record<string, unknown>)?.[key];
  return Array.isArray(list) ? (list as T[]) : [];
}
