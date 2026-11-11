import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES, isAdmin } from "../contracts/naming";
import { createSession } from "../pages/workbench/useSessions";
import { enc } from "../api/client";
import { extensionNavItems } from "../contracts/extensions";
import { workspaceDisplayName } from "../contracts/workspace";
import { useNavigate } from "../router";
import { useShell, withWorkspace } from "./shellContext";
import { Portal } from "../kit/ui";
import { IconArrowUpRight, IconBolt, IconSearch, IconWorkspace } from "../components/Icon";

const GROUP_ICON = { "动作": IconBolt, "前往": IconArrowUpRight, "切换工作区": IconWorkspace } as const;

export interface PaletteCommand {
  id: string;
  group: "动作" | "前往" | "切换工作区";
  label: string;
  run: () => void;
}

/**
 * 这里只匹配「动作 / 页面 / 工作区」命令，不检索会话、文件、知识或记忆内容，所以界面上叫「命令」，
 * 不再沿用 NAMES.search（"全局搜索"，属于 contracts/naming，需 Codex 同步改名）。
 */
export const COMMAND_LABEL = "命令";
export const COMMAND_HINT = "只搜索动作、页面和工作区；会话、文件、知识与记忆的内容请在对应页面检索。";

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
    <Portal><div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={COMMAND_LABEL} onKeyDown={onKey} data-testid="command-palette">
        <div className="palette-search">
          <IconSearch size={18} aria-hidden="true" />
          <input ref={inputRef} className="palette-input" placeholder="输入动作、页面或工作区名称" value={query} onChange={(e) => setQuery(e.target.value)}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={filtered[index] ? `cmd-${index}` : undefined} />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul id="palette-list" className="palette-list" role="listbox">
          {filtered.length === 0 ? <li className="palette-empty">没有匹配的命令</li> : null}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            const GroupIcon = GROUP_ICON[c.group];
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header ? <div className="palette-group">{header}</div> : null}
                <div id={`cmd-${i}`} role="option" aria-selected={i === index} className={`palette-item ${i === index ? "is-active" : ""}`}
                  onMouseEnter={() => setIndex(i)} onClick={() => runAt(i)} data-command={c.id}><GroupIcon size={16} aria-hidden="true" className="palette-item-icon" />{c.label}</div>
              </li>
            );
          })}
        </ul>
        <p className="palette-hint" data-testid="palette-hint">{COMMAND_HINT}</p>
      </div>
    </div></Portal>
  );
}
