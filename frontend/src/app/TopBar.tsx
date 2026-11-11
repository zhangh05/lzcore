import { DesktopSettingsButton } from "../desktop/DesktopHost";
import { COMMAND_HINT, COMMAND_LABEL } from "./CommandPalette";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { canSignOut } from "../contracts/auth";
import { NAMES } from "../contracts/naming";
import { workspaceDisplayName } from "../contracts/workspace";
import { IconChevronDown, IconMenu, IconMoon, IconRows, IconSearch, IconSettings, IconSignOut, IconSun } from "../components/Icon";
import { useNavigate } from "../router";
import { usePrefs } from "./prefs";
import { useShell } from "./shellContext";
import { Breadcrumb } from "./Breadcrumb";

function WorkspaceSwitcher() {
  const { workspaces, workspaceId, switchWorkspace } = useShell();
  if (workspaces.kind === "loading") return <span className="ws-switch muted">读取工作区…</span>;
  if (workspaces.kind === "error") return <span className="ws-switch tone-warn" role="status">{workspaces.reason}</span>;
  if (workspaces.list.length === 0) return <span className="ws-switch muted">没有可访问的工作区</span>;
  return (
    <label className="ws-switch">
      <span className="sr-only">{NAMES.workspace}</span>
      <select aria-label={`切换${NAMES.workspace}`} value={workspaceId ?? ""} onChange={(e) => switchWorkspace(e.target.value)} data-testid="workspace-switcher">
        {workspaces.list.map((w) => <option key={w.workspace_id} value={w.workspace_id}>{workspaceDisplayName(w)}</option>)}
      </select>
      <IconChevronDown size={14} className="ws-switch-caret" aria-hidden="true" />
    </label>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

function AvatarMenu() {
  const { auth, signOut, hrefFor } = useShell();
  const { theme, density, setTheme, setDensity } = usePrefs();
  const navigate = useNavigate();
  const { open, setOpen, ref } = usePopover();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [open]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
  };
  const label = auth.username || "本地模式";
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="topbar-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={label} data-testid="avatar-button">
        <span className="topbar-avatar" aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span><span>{label}</span>
      </button>
      {open ? (
        <div className="popover menu" role="menu" aria-label="账户菜单" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="menu-header" aria-hidden="true">
            <span className="topbar-avatar">{label.slice(0, 1).toUpperCase()}</span>
            <span><span className="menu-header-name">{label}</span><br /><span className="menu-header-meta">{auth.auth_type === "session" ? "已登录" : auth.auth_type === "api_token" ? "API token" : "未启用登录"}</span></span>
          </div>
          <button role="menuitem" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <IconMoon size={16} aria-hidden="true" /> : <IconSun size={16} aria-hidden="true" />}主题<span className="menu-value">{theme === "dark" ? "深色" : "浅色"}</span></button>
          <button role="menuitem" type="button" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}><IconRows size={16} aria-hidden="true" />密度<span className="menu-value">{density === "compact" ? "紧凑" : "舒适"}</span></button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); navigate(hrefFor("/system/settings")); }}><IconSettings size={16} aria-hidden="true" />{NAMES.settings}</button>
          {canSignOut(auth)
            ? <button role="menuitem" type="button" onClick={() => { setOpen(false); void signOut(); }}><IconSignOut size={16} aria-hidden="true" />退出</button>
            : <span role="menuitem" aria-disabled="true" tabIndex={-1} className="menu-note">{auth.auth_type === "api_token" ? "API token 模式下不提供退出" : "未启用登录，无需退出"}</span>}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ onOpenPalette, onToggleNav }: { onOpenPalette: () => void; onToggleNav?: () => void }) {
  return (
    <header className="app-topbar">
      {onToggleNav ? <button type="button" className="topbar-btn" onClick={onToggleNav} aria-label="打开主导航"><IconMenu size={18} aria-hidden="true" /></button> : null}
      <WorkspaceSwitcher />
      <span className="topbar-divider" aria-hidden="true" />
      <Breadcrumb />
      <button type="button" className="topbar-search" onClick={onOpenPalette} aria-label={`${COMMAND_LABEL}（Ctrl K）`} title={COMMAND_HINT} data-testid="open-palette">
        <IconSearch size={15} aria-hidden="true" /><span>{COMMAND_LABEL}：跳转或新建…</span><kbd>Ctrl K</kbd>
      </button>
      <div className="topbar-right">
        <DesktopSettingsButton />
        <AvatarMenu />
      </div>
    </header>
  );
}
