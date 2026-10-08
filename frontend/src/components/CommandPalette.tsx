import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "../router";
import { sessionsApi } from "../api";
import type { Session } from "../types";
import type { NavItem } from "../config/nav";
import { useSessionStore, useUIStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";
import { preloadRoute } from "../routes";
import { IconChat, IconMoon, IconSearch, IconSun } from "./Icon";

/**
 * Keyboard jump list (Ctrl/⌘ K): every navigation destination the current user
 * can already reach, the active sessions of the current workspace, and the
 * theme switch. It only navigates or selects — it never creates, deletes or
 * writes anything — so it adds a faster path, not a new capability.
 */
interface PaletteEntry {
  id: string;
  group: "页面" | "会话" | "偏好";
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: NavItem[] }) {
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const switchWbSession = useWorkbenchStore((s) => s.switchSession);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus({ preventScroll: true });
    const ctrl = new AbortController();
    if (currentWorkspaceId) {
      sessionsApi.list(currentWorkspaceId, "active", ctrl.signal)
        .then((res) => setSessions(res.sessions ?? []))
        .catch(() => setSessions([]));
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      ctrl.abort();
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [open, currentWorkspaceId]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const pages: PaletteEntry[] = items.map((item) => {
      const Icon = item.Icon;
      return {
        id: `page:${item.to}`,
        group: "页面",
        label: item.label,
        hint: item.to.split("?")[0],
        icon: <Icon size={16} />,
        run: () => navigate(item.to),
      };
    });
    const sessionEntries: PaletteEntry[] = sessions.slice(0, 30).map((sess) => ({
      id: `session:${sess.session_id}`,
      group: "会话",
      label: sess.title || sess.session_id,
      hint: sess.message_count > 0 ? `${sess.message_count} 条消息` : undefined,
      icon: <IconChat size={16} />,
      run: () => {
        setCurrentSession(sess.session_id);
        switchWbSession(sess.session_id);
        navigate("/workbench");
      },
    }));
    const prefs: PaletteEntry[] = [{
      id: "pref:theme",
      group: "偏好",
      label: theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
      icon: theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />,
      run: () => setTheme(theme === "dark" ? "light" : "dark"),
    }];
    const q = query.trim().toLocaleLowerCase();
    const all = [...pages, ...sessionEntries, ...prefs];
    return q ? all.filter((entry) => `${entry.label} ${entry.hint ?? ""}`.toLocaleLowerCase().includes(q)) : all;
  }, [items, sessions, theme, query, navigate, setCurrentSession, switchWbSession, setTheme]);

  useEffect(() => { setActive((index) => Math.min(index, Math.max(entries.length - 1, 0))); }, [entries.length]);

  const choose = useCallback((entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  }, [onClose]);

  useEffect(() => {
    const entry = entries[active];
    if (entry?.group === "页面") void preloadRoute(entry.id.slice(5));
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, entries, listId]);

  if (!open) return null;

  let lastGroup = "";
  return createPortal(
    <div className="command-backdrop" onClick={onClose} data-testid="command-palette">
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
          if (event.key === "Tab") { event.preventDefault(); inputRef.current?.focus(); return; }
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (entries.length ? (index + 1) % entries.length : 0)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => (entries.length ? (index - 1 + entries.length) % entries.length : 0)); }
          if (event.key === "Enter") { event.preventDefault(); choose(entries[active]); }
        }}
      >
        <div className="command-input-row">
          <IconSearch size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            className="command-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={entries.length ? `${listId}-${active}` : undefined}
            aria-label="搜索页面、会话或偏好"
            placeholder="搜索页面、会话或偏好…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          />
          <kbd className="command-kbd">Esc</kbd>
        </div>
        <ul className="command-list" id={listId} role="listbox" aria-label="跳转目标">
          {entries.length === 0 ? <li className="command-empty" role="presentation">没有匹配的页面或会话</li> : null}
          {entries.map((entry, index) => {
            const heading = entry.group !== lastGroup ? entry.group : "";
            lastGroup = entry.group;
            return (
              <li key={entry.id} role="presentation">
                {heading ? <div className="command-group" role="presentation">{heading}</div> : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={"command-option" + (index === active ? " active" : "")}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(entry)}
                >
                  <span className="command-option-icon" aria-hidden="true">{entry.icon}</span>
                  <span className="command-option-label">{entry.label}</span>
                  {entry.hint ? <span className="command-option-hint">{entry.hint}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="command-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
