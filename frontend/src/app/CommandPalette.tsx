import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES, isAdmin } from "../contracts/naming";
import { createSession } from "../pages/workbench/useSessions";
import { enc } from "../api/client";
import { extensionNavItems } from "../contracts/extensions";
import { workspaceDisplayName } from "../contracts/workspace";
import { useNavigate } from "../router";
import { useShell, withWorkspace } from "./shellContext";

export interface PaletteCommand {
  id: string;
  group: "动作" | "前往" | "切换工作区";
  label: string;
  run: () => void;
}

/** Ctrl K 命令面板：分组结果 + 动作（不只是跳转）。「新建会话」永远在第一位。 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { hrefFor, workspaces, workspaceId, switchWorkspace, extensions, auth } = useShell();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (path: string) => () => navigate(hrefFor(path));
    const list: PaletteCommand[] = [
      { id: "new-session", group: "动作", label: NAMES.newSession, run: () => {
        // 阶段 2：真正创建会话（POST /api/sessions），成功后直接进入该会话的输入框。
        if (!workspaceId) return;
        void createSession(workspaceId).then((r) => navigate(withWorkspace(r.session ? `/workbench?session=${enc(r.session.session_id)}` : "/workbench?notice=create_failed", workspaceId)));
      } },
      { id: "open-review", group: "动作", label: `打开${NAMES.reviewInbox}`, run: go("/review") },
    ];
    for (const s of [...CORE_NAV_BEFORE_EXTENSIONS, ...CORE_NAV_AFTER_EXTENSIONS]) {
      list.push({ id: `go:${s.key}`, group: "前往", label: s.label, run: go(s.path) });
      for (const c of s.children ?? []) if (c.path !== s.path && (!c.adminOnly || isAdmin(auth))) list.push({ id: `go:${c.key}`, group: "前往", label: `${s.label} / ${c.label}`, run: go(c.path) });
    }
    list.push({ id: "go:extensions", group: "前往", label: NAMES.extensions, run: go("/extensions") });
    for (const m of extensionNavItems(extensions)) list.push({ id: `go:ext:${m.path}`, group: "前往", label: `${NAMES.extensions} / ${m.label}`, run: go(m.path) });
    if (workspaces.kind === "ready") {
      for (const w of workspaces.list) {
        if (w.workspace_id !== workspaceId) list.push({ id: `ws:${w.workspace_id}`, group: "切换工作区", label: workspaceDisplayName(w), run: () => switchWorkspace(w.workspace_id) });
      }
    }
    return list;
  }, [navigate, hrefFor, workspaceId, workspaces, switchWorkspace, extensions, auth]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => { setIndex(0); }, [query]);

  const runAt = (i: number) => { const c = filtered[i]; if (!c) return; onClose(); c.run(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); runAt(index); }
    if (e.key === "Tab") e.preventDefault(); // 焦点留在面板内
  };

  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={NAMES.search} onKeyDown={onKey} data-testid="command-palette">
        <input ref={inputRef} className="palette-input" placeholder="输入命令或页面名" value={query} onChange={(e) => setQuery(e.target.value)}
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={filtered[index] ? `cmd-${index}` : undefined} />
        <ul id="palette-list" className="palette-list" role="listbox">
          {filtered.length === 0 ? <li className="palette-empty">没有匹配的命令</li> : null}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header ? <div className="palette-group">{header}</div> : null}
                <div id={`cmd-${i}`} role="option" aria-selected={i === index} className={`palette-item ${i === index ? "is-active" : ""}`}
                  onMouseEnter={() => setIndex(i)} onClick={() => runAt(i)} data-command={c.id}>{c.label}</div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
