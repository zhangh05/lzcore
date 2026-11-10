import { DesktopSettingsButton } from "../desktop/DesktopHost";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { canSignOut } from "../contracts/auth";
import { NAMES } from "../contracts/naming";
import { inboxBadge } from "../contracts/reviewInbox";
import { workspaceDisplayName } from "../contracts/workspace";
import { IconInbox, IconSearch, IconUser } from "../components/Icon";
import { useNavigate } from "../router";
import { usePrefs } from "./prefs";
import { useShell } from "./shellContext";
import { InboxList } from "./InboxList";

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

function ReviewInboxButton() {
  const { inbox, inboxError, hrefFor } = useShell();
  const navigate = useNavigate();
  const { open, setOpen, ref } = usePopover();
  const badge = inboxBadge(inbox);
  const n = inbox?.entries.length ?? 0;
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className="topbar-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        aria-label={NAMES.reviewInbox} title={inboxError ? `待核对读取失败：${inboxError}` : badge.title} data-testid="inbox-button">
        <IconInbox size={18} aria-hidden="true" />
        <span>{NAMES.reviewInbox}</span>
        <span className={`count-badge ${n ? "tone-unknown" : ""}`} data-testid="inbox-count">{inboxError ? "!" : badge.text}</span>
      </button>
      {open ? (
        <div className="popover inbox-popover" role="dialog" aria-label={NAMES.reviewInbox}>
          <InboxList compact onNavigate={() => setOpen(false)} />
          <button type="button" className="btn ghost popover-footer" onClick={() => { setOpen(false); navigate(hrefFor("/review")); }}>查看全部待核对</button>
        </div>
      ) : null}
    </div>
  );
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
        <IconUser size={18} aria-hidden="true" /><span>{label}</span>
      </button>
      {open ? (
        <div className="popover menu" role="menu" aria-label="账户菜单" ref={menuRef} onKeyDown={onMenuKey}>
          <button role="menuitem" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>主题：{theme === "dark" ? "深色" : "浅色"}</button>
          <button role="menuitem" type="button" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}>密度：{density === "compact" ? "紧凑" : "舒适"}</button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); navigate(hrefFor("/system/settings")); }}>{NAMES.settings}</button>
          {canSignOut(auth)
            ? <button role="menuitem" type="button" onClick={() => { setOpen(false); void signOut(); }}>退出</button>
            : <span role="menuitem" aria-disabled="true" tabIndex={-1} className="menu-note">{auth.auth_type === "api_token" ? "API token 模式下不提供退出" : "未启用登录，无需退出"}</span>}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ onOpenPalette, onToggleNav }: { onOpenPalette: () => void; onToggleNav?: () => void }) {
  return (
    <header className="app-topbar">
      {onToggleNav ? <button type="button" className="topbar-btn" onClick={onToggleNav} aria-label="打开主导航">☰</button> : null}
      <WorkspaceSwitcher />
      <button type="button" className="topbar-search" onClick={onOpenPalette} aria-label={NAMES.search} data-testid="open-palette">
        <IconSearch size={16} aria-hidden="true" /><span>{NAMES.search}</span><kbd>Ctrl K</kbd>
      </button>
      <div className="topbar-right">
        <ReviewInboxButton />
        <DesktopSettingsButton />
        <AvatarMenu />
      </div>
    </header>
  );
}
