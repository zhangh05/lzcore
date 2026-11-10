let principal = "";
export function setDesktopPrincipal(value: string) { principal = value; desktopDirty("bootstrap", false); }
import { usePrefs } from '../app/prefs';
export type DesktopInfo = {
  ok: boolean; admin?: boolean; error?: string; version: string; commit: string; mode: string; data_dir: string;
  signed: boolean; webview2: string; active_jobs: number; dirty: boolean; tray: boolean; restore: string;
  shutdown: { status: string; message?: string };
  settings: { close_to_tray?: boolean; notifications?: boolean; autostart?: boolean; previous_version?: string };
  update: {status: string; version?: string; progress?: number; message?: string; notes?: string};
};
declare global {
  interface Window { __LZCORE_DESKTOP__?: {platform?: string; theme: 'light' | 'dark'; ui: {themePreference?: "light" | "dark" | "system"}}; }
}
export const isDesktop = () => Boolean(window.__LZCORE_DESKTOP__);
export async function nativeCall(method: string, ...args: unknown[]): Promise<Record<string, unknown>> {
  const host = window as Window & {pywebview?: {api?: Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>}};
  const fn = host.pywebview?.api?.[method];
  if (!fn) throw new Error('桌面连接尚未就绪，请稍后重试');
  const result = await fn(...args);
  if (!result.ok) throw new Error(String(result.error === 'cancelled' ? '已取消' : result.error || '操作失败'));
  return result;
}
const dirty = new Set<string>();
const dirtyListeners = new Set<(isDirty: boolean) => void>();
export function isAnyDirty() { return dirty.size > 0; }
export function dirtyKeys() { return [...dirty]; }
export function onDirtyChange(listener: (isDirty: boolean) => void) { dirtyListeners.add(listener); return () => { dirtyListeners.delete(listener); }; }
export function resetDirty() { for (const key of [...dirty]) desktopDirty(key, false); }

export function desktopDirty(key: string, value: boolean) {
  const before = dirty.size > 0;
  if (value) dirty.add(key); else dirty.delete(key);
  if (before !== (dirty.size > 0)) dirtyListeners.forEach((listener) => listener(dirty.size > 0));
  if (isDesktop()) void nativeCall('report_state', {dirty: dirty.size > 0, principal, title: document.title.replace(/联智中枢\s*[·—-]?\s*/g, '')}).catch(() => {});
}
export function desktopPreferences() {
  const {theme, themePreference} = usePrefs.getState();
  return {ui: {theme, themePreference}};
}
