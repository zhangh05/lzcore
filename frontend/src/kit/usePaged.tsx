import { useCallback, useEffect, useRef, useState } from "react";
import { api, bodyOf, type Query } from "../api/client";
import type { HttpOutcome } from "../contracts/auth";
import { Button } from "../components/Button";
import { FailureNote } from "./ui";
import { listOf, useApi, type Loadable } from "./useApi";

/**
 * 服务端分页列表：首页走 useApi（缓存 / 重读），后续页按服务端给的续页标记追加。
 * 续页标记只用服务端返回的值（cursor 用 next_cursor，offset 用 next_offset），前端不自己推算。
 */
export interface PageSpec {
  /** 列表字段名，如 "files" / "records" / "entries"。 */
  listKey: string;
  /** 请求续页时用的 query 参数名，如 "cursor" / "offset"。 */
  param: string;
  /** 响应里下一页标记的字段名，如 "next_cursor" / "next_offset"。 */
  next: string;
}

export interface Paged<T> {
  first: Loadable<Record<string, unknown>>;
  reload: () => void;
  items: T[];
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: HttpOutcome | null;
  loadMore: () => void;
}

function nextMark(body: Record<string, unknown> | null, field: string): string | number | null {
  const v = body?.[field];
  return (typeof v === "string" && v) || (typeof v === "number" && Number.isFinite(v)) ? (v as string | number) : null;
}

export function usePaged<T>(path: string | null, query: Query, spec: PageSpec): Paged<T> {
  const [first, reload] = useApi(path, query);
  const [extra, setExtra] = useState<T[]>([]);
  const [mark, setMark] = useState<string | number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<HttpOutcome | null>(null);
  const gen = useRef(0);
  const firstData = first.state === "ok" ? (first.data as Record<string, unknown>) : null;

  // 首页变化（换筛选、重读）时丢弃已追加的页，从首页的续页标记重新开始。
  useEffect(() => {
    gen.current += 1;
    setExtra([]);
    setMoreError(null);
    setLoadingMore(false);
    setMark(nextMark(firstData, spec.next));
  }, [firstData, spec.next]);

  const loadMore = useCallback(() => {
    if (!path || mark === null || loadingMore) return;
    const mine = gen.current;
    setLoadingMore(true);
    setMoreError(null);
    void api.get(path, { ...query, [spec.param]: mark }).then((o) => {
      if (mine !== gen.current) return;
      setLoadingMore(false);
      const body = bodyOf<Record<string, unknown>>(o);
      const list = body?.[spec.listKey];
      if (o.kind !== "http" || o.status >= 300 || !Array.isArray(list)) { setMoreError(o); return; }
      setExtra((x) => [...x, ...(list as T[])]);
      setMark(nextMark(body, spec.next));
    });
  }, [path, query, spec, mark, loadingMore]);

  const total = typeof firstData?.total === "number" ? (firstData.total as number) : null;
  return { first, reload, items: [...listOf<T>(first, spec.listKey), ...extra], total, hasMore: mark !== null, loadingMore, moreError, loadMore };
}

/** 列表底部：如实显示已加载多少、共多少，还有下一页时给「加载更多」。 */
export function LoadMore<T>({ paged, testId }: { paged: Paged<T>; testId?: string }) {
  const { items, total, hasMore, loadingMore, moreError, loadMore } = paged;
  if (!hasMore && (total === null || total <= items.length)) return null;
  return (
    <div className="row-actions" data-testid={testId ?? "load-more"}>
      <span className="muted">已显示 {items.length}{total !== null ? ` / 共 ${total}` : ""} 项</span>
      {hasMore ? <Button variant="ghost" className="sm" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "加载中…" : "加载更多"}</Button> : null}
      {moreError ? <FailureNote outcome={moreError} /> : null}
    </div>
  );
}
