import { DesktopSettingsButton } from "../desktop/DesktopHost";
import { BrowserRouter, Link, Navigate, NavLink, useLocation } from "../router";
import { Suspense, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { SkeletonList, SkeletonTable } from "../components/common";
import { AppLayout } from "../layouts/AppLayout";
import { ToastHost } from "../components/ToastHost";
import { ConfirmHost } from "../components/ConfirmDialog";
import { FormDialogHost } from "../components/FormDialog";
import { useSessionStore, useUIStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";
import { disconnectTurnTransport, recoverStreamingTurns } from "../realtime/turnTransport";
import { initWebVitals } from "../utils/webVitals";
import { authApi, systemApi } from "../api";
import { isApiError } from "../types";
import { ACTIVE_USER_KEY, scopedLocalStorageKey, setActiveUserScope, setActiveWorkspaceScope } from "../utils/userScope";
import {
  IconChevronLeft,
  IconSettings,
  IconMoon,
  IconSun,
  IconMenu,
  IconHelp,
  IconSearch,
  IconSidebarSimple,
  IconSignOut,
  IconRows,
  IconShield,
  IconChecklist,
  IconWorkspace,
} from "../components/Icon";
import { CommandPalette } from "../components/CommandPalette";
import { FeatureDescriptionDrawer } from "../components/FeatureDescriptionDrawer";
import { NAV_ITEMS, buildNavGroups } from "../config/nav";
import type { NavGroup, NavItem } from "../config/nav";
import { ExtensionRegistryProvider, useExtensionRegistry } from "../extensions/registry";
import {
  TaskWorkbench,
  OperationsPage,
  Settings,
  Diagnostics,
  KnowledgeLibrary,
  DataCenter,
  MemoryPage,
  NetworkTopology,
  UserManagement,
  preloadRoute,
} from "../routes";

function formatVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function clearUserScopedFrontendState(nextSession?: Awaited<ReturnType<typeof authApi.status>>) {
  disconnectTurnTransport();
  const allowed = nextSession?.workspace_ids || [];
  const currentWorkspace = useSessionStore.getState().currentWorkspaceId;
  const nextWorkspace = nextSession?.platform_admin
    ? (currentWorkspace || nextSession.home_workspace_id || "default")
    : (nextSession?.home_workspace_id || (allowed.includes(currentWorkspace) ? currentWorkspace : allowed[0]) || "");
  setActiveUserScope(nextSession?.username || "", nextWorkspace);
  useSessionStore.getState().resetForUser(nextWorkspace);
  if (nextSession?.username) void useWorkbenchStore.persist.rehydrate();
  else {
    try {
      localStorage.removeItem(scopedLocalStorageKey("lzcore_workbench"));
      localStorage.removeItem(scopedLocalStorageKey("lzcore_session", false));
    } catch { /* storage can be unavailable */ }
    void useWorkbenchStore.persist.rehydrate();
  }
  try { sessionStorage.removeItem("workbench_auto_prompt"); } catch { /* noop */ }
}

function applyAuthenticatedSession(nextSession: Awaited<ReturnType<typeof authApi.status>>) {
  let previousUsername = "";
  try { previousUsername = localStorage.getItem(ACTIVE_USER_KEY) || ""; } catch { /* noop */ }
  const currentWorkspace = useSessionStore.getState().currentWorkspaceId;
  const allowed = nextSession.workspace_ids || [];
  const invalidWorkspace = !nextSession.platform_admin && !allowed.includes(currentWorkspace);
  if (previousUsername !== nextSession.username || invalidWorkspace) {
    clearUserScopedFrontendState(nextSession);
  } else if (nextSession.home_workspace_id && !currentWorkspace) {
    useSessionStore.getState().setCurrentWorkspace(nextSession.home_workspace_id);
  }
}

const NavGroupItem = memo(function NavGroupItem({ group, currentPath, currentSearch }: { group: NavGroup; currentPath: string; currentSearch?: string }) {
  const active = group.items.some((item) => {
    const [itemPath, itemQuery] = item.to.split("?");
    if (itemPath !== currentPath) return false;
    if (!itemQuery) return true;
    const itemParams = new URLSearchParams(itemQuery);
    const itemTab = itemParams.get("tab");
    const currentParams = new URLSearchParams(currentSearch || "");
    const currentTab = currentParams.get("tab") || "devices";
    return itemTab === (currentTab === "skills" ? "skills" : "devices");
  });
  const warmGroup = useCallback(() => {
    void preloadRoute(group.to);
    group.items.forEach((item) => void preloadRoute(item.to));
  }, [group]);
  const Icon = group.Icon;
  const hasMenu = group.items.length > 1;
  // The menu is revealed by CSS (:hover / :focus-within). aria-expanded must
  // report that visibility, not whether the group holds the current route:
  // track the same two conditions, and let Escape dismiss it for keyboard use.
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const expanded = hasMenu && (hovered || focusWithin) && !dismissed;
  return (
    <div
      className={"app-nav-group" + (active ? " active" : "") + (hasMenu ? " has-menu" : "") + (hasMenu && dismissed ? " menu-dismissed" : "")}
      onMouseEnter={() => { warmGroup(); setHovered(true); setDismissed(false); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => { warmGroup(); setFocusWithin(true); }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusWithin(false);
        setDismissed(false);
      }}
      onKeyDown={(event) => {
        if (!hasMenu || event.key !== "Escape" || dismissed) return;
        setDismissed(true);
        event.currentTarget.querySelector<HTMLElement>(".app-nav-group-trigger")?.focus();
      }}
    >
      <NavLink
        to={group.to}
        data-testid={group.testid}
        className={() => "app-nav-item app-nav-group-trigger" + (active ? " active" : "")}
        onPointerDown={warmGroup}
        onTouchStart={warmGroup}
        aria-haspopup={hasMenu ? "menu" : undefined}
        aria-expanded={hasMenu ? (expanded ? "true" : "false") : undefined}
        viewTransition
      >
        {/*
          Text only. The global switcher is a destination list, not an icon
          wall: repeating an icon beside every domain doubles the signal for no
          extra information. The domain icon lives in the menu it opens, and in
          the surfaces where an icon genuinely aids scanning (dropdown rows,
          sidebar, mobile navigation).
        */}
        <span>{group.label}</span>
        {hasMenu ? <span className="app-nav-caret" aria-hidden="true" /> : null}
      </NavLink>
      {hasMenu ? (
        <div className="app-nav-menu" role="menu" aria-label={group.label}>
          <div className="app-nav-menu-head">
            <Icon size={14} weight="duotone" />
            <strong>{group.label}</strong>
            <span>{group.description}</span>
          </div>
          {group.items.map((item) => {
            const ChildIcon = item.Icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                data-testid={item.testid}
                className={({ isActive }) => "app-nav-menu-item" + (isActive ? " active" : "")}
                onMouseEnter={() => preloadRoute(item.to)}
                onFocus={() => preloadRoute(item.to)}
                viewTransition
                role="menuitem"
              >
                <ChildIcon size={14} weight="duotone" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

const SettingsNav = memo(function SettingsNav({ items, currentPath }: { items: NavItem[]; currentPath: string }) {
  if (items.length === 0) return null;
  const active = items.some((item) => item.to === currentPath);
  const closeMenu = (event: MouseEvent<HTMLAnchorElement>) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
  };
  return (
    <details className={"app-settings-menu" + (active ? " active" : "")}>
      <summary className="settings-nav-trigger" aria-label="打开设置菜单" data-testid="btn-settings-menu">
        <IconSettings size={16} weight="duotone" />
        <span className="sr-only">设置</span>
      </summary>
      <div className="app-nav-menu" role="menu" aria-label="设置菜单">
        <div className="app-nav-menu-head">
          <strong>设置</strong>
          <span>模型配置、工作区设置与用户权限</span>
        </div>
        {items.map((item) => {
          const Icon = item.Icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              data-testid={item.testid}
              className={({ isActive }) => "app-nav-menu-item" + (isActive ? " active" : "")}
              onMouseEnter={() => preloadRoute(item.to)}
              onFocus={() => preloadRoute(item.to)}
              onClick={closeMenu}
              viewTransition
              role="menuitem"
            >
              <Icon size={14} weight="duotone" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </details>
  );
});

/** Per-route skeleton shown while a lazily-loaded page chunk is fetched, so
 *  navigation feels instant instead of flashing an empty spinner. */
const SKELETON_BY_PATH: Record<string, "list" | "table"> = {
  "/workbench": "list",
  "/runs": "list",
  "/knowledge": "list",
  "/data": "table",
  "/memory": "list",
  "/diagnostics": "list",
  "/topology": "list",
};

function RouteFallback() {
  const { pathname } = useLocation();
  const kind = SKELETON_BY_PATH[pathname] ?? "list";
  return (
    <div className="route-fallback route-skeleton" role="status" aria-live="polite" aria-busy="true">
      <div className="route-skeleton-inner">
        {kind === "table" ? <SkeletonTable rows={8} cols={4} /> : <SkeletonList rows={9} />}
      </div>
      <span className="sr-only">页面加载中…</span>
    </div>
  );
}

function AppRoutes({ canManageUsers }: { canManageUsers: boolean }) {
  const location = useLocation();
  const extensionRegistry = useExtensionRegistry();
  const routes: Record<string, ReactNode> = {
    "/workbench": <ErrorBoundary><TaskWorkbench /></ErrorBoundary>,
    "/knowledge": <ErrorBoundary><KnowledgeLibrary /></ErrorBoundary>,
    "/data": <ErrorBoundary><DataCenter /></ErrorBoundary>,
    "/memory": <ErrorBoundary><MemoryPage /></ErrorBoundary>,
    "/capabilities": <Navigate to="/workbench" replace />,
    "/topology": <ErrorBoundary><NetworkTopology /></ErrorBoundary>,
    "/diagnostics": <ErrorBoundary><Diagnostics /></ErrorBoundary>,
    "/settings": <ErrorBoundary><Settings /></ErrorBoundary>,
    "/runs": <ErrorBoundary><OperationsPage /></ErrorBoundary>,
    "/users": canManageUsers ? <ErrorBoundary><UserManagement /></ErrorBoundary> : <Navigate to="/workbench" replace />,
    "/organizations": <Navigate to={canManageUsers ? "/users" : "/workbench"} replace />,
  };
  const searchTab = new URLSearchParams(location.search).get("tab");
  const isSkillRoute = location.pathname.startsWith("/extensions/network.operations") && searchTab === "skills";
  const routeKey = location.pathname.startsWith("/extensions/network.operations")
    ? `${location.pathname}?tab=${isSkillRoute ? "skills" : "devices"}`
    : location.pathname;
  const extensionRoute = extensionRegistry.routes.find((route) => route.path === location.pathname);
  const content = location.pathname === "/" ? (
    <Navigate to="/workbench" replace />
  ) : extensionRoute ? (
    <ErrorBoundary><extensionRoute.Component key={routeKey} /></ErrorBoundary>
  ) : !extensionRegistry.ready && location.pathname.startsWith("/extensions/") ? (
    <RouteFallback />
  ) : routes[location.pathname] ?? (
    <ErrorBoundary>
      <div className="hero hero-not-found">
        <div className="hero-mark">404</div>
        <h1 className="hero-title">页面不存在</h1>
        <p className="hero-sub">这个地址没有对应的页面，可能已移动或输入有误。可以回到工作台，或按 Ctrl K 快速跳转。</p>
        <div className="hero-actions">
          <Link className="btn primary" to="/workbench" viewTransition>返回工作台</Link>
          <Link className="btn" to="/runs" viewTransition>查看任务记录</Link>
        </div>
      </div>
    </ErrorBoundary>
  );
  return (
    <Suspense fallback={<RouteFallback />}>
      <div className="route-view" key={routeKey} data-route={location.pathname}>
        {content}
      </div>
    </Suspense>
  );
}

function LoginScreen({ onLogin }: { onLogin: (status: Awaited<ReturnType<typeof authApi.status>>) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    authApi.status()
      .then((status) => { if (active) setOidcEnabled(Boolean(status.oidc_enabled)); })
      .catch(() => { /* password login remains available */ });
    return () => { active = false; };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await authApi.login(username.trim(), password);
      onLogin(await authApi.status());
    } catch (err) {
      if (isApiError(err) && err.status === 403) {
        setError("当前访问地址未被后端允许，请联系管理员检查访问地址配置");
      } else if (isApiError(err) && err.code === "network") {
        setError("无法连接后端服务，请检查访问地址或端口是否放通");
      } else {
        setError("账号或密码不正确");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      {/* Product context for wide windows; purely presentational, so it is
          hidden from assistive technology and collapses away on narrow screens. */}
      <aside className="login-showcase" aria-hidden="true">
        <div className="login-showcase-brand">
          <span className="brand-mark brand-mark-lg">联</span>
          <span>联智中枢</span>
        </div>
        <div className="login-showcase-copy">
          <h2>把运维任务交给 Agent，<br />每一步都有据可查。</h2>
          <ul>
            <li><IconChecklist size={18} /><span><strong>调用工具，留下证据</strong>每次读取与执行都记录来源和结果。</span></li>
            <li><IconShield size={18} /><span><strong>写入先核对，不盲目重试</strong>结果未知的操作只回查，不自动重放。</span></li>
            <li><IconWorkspace size={18} /><span><strong>按工作区隔离</strong>会话、文件与记忆只在授权的工作区内可见。</span></li>
          </ul>
        </div>
        <small>AI Operations Workspace</small>
      </aside>
      <section className="login-panel" aria-labelledby="login-title">
        {/*
          Brand, one line of description, then the form. The category line is set
          in the product's metadata voice — the same restrained mono treatment
          used for identifiers elsewhere — and carries the product's own identity
          rather than a decorative motif with invented ids in it.
        */}
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg" aria-hidden="true">联</span>
          <h1 id="login-title">登录联智中枢</h1>
          <p>使用工作区账户继续。Agent 会调用工具、留下证据，并说明结论。</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            <span>账户</span>
            <input
              autoComplete="username"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              autoFocus
            />
          </label>
          {error ? <div className="login-error" role="alert">{error}</div> : null}
          <button type="submit" className={"login-submit" + (submitting ? " is-loading" : "")} disabled={submitting || !username.trim() || !password}>
            {submitting ? "正在登录…" : "登录"}
          </button>
          {oidcEnabled ? (
            <button
              type="button"
              className="login-submit secondary"
              disabled={submitting}
              onClick={() => window.location.assign("/api/auth/oidc/start")}
            >
              企业单点登录
            </button>
          ) : null}
        </form>
        <p className="login-footnote">登录状态仅保存在当前浏览器；共享设备使用后请退出。</p>
      </section>
    </main>
  );
}

const ROLE_LABELS: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读成员", operator: "操作员" };

function AccountMenu({ session, density, onDensity }: {
  session: Awaited<ReturnType<typeof authApi.status>> | null;
  density: "comfortable" | "compact";
  onDensity: (value: "comfortable" | "compact") => void;
}) {
  const name = session?.username || "本地模式";
  const role = session?.platform_admin ? "平台管理员" : (session?.role ? ROLE_LABELS[session.role] ?? session.role : "未启用登录");
  const workspace = useSessionStore((s) => s.currentWorkspaceId);
  return (
    <details className="app-account">
      <summary className="app-account-trigger" title="账户与显示偏好" data-testid="btn-account-menu">
        <span className="app-account-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="app-account-name">{name}</span>
        <span className="sr-only">账户与显示偏好</span>
      </summary>
      <div className="app-nav-menu app-account-menu" role="group" aria-label="账户与显示偏好">
        <div className="app-account-head">
          <span className="app-account-avatar lg" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{name}</strong>
            <span>{role}{workspace ? ` · ${workspace}` : ""}</span>
          </div>
        </div>
        <div className="app-account-section">
          <span className="app-account-label"><IconRows size={14} aria-hidden="true" />显示密度</span>
          <div className="segmented app-density" role="group" aria-label="显示密度">
            <button type="button" className={density === "comfortable" ? "active" : ""} aria-pressed={density === "comfortable"} onClick={() => onDensity("comfortable")}>舒适</button>
            <button type="button" className={density === "compact" ? "active" : ""} aria-pressed={density === "compact"} onClick={() => onDensity("compact")}>紧凑</button>
          </div>
        </div>
      </div>
    </details>
  );
}

function AppShell({ canLogout, onLogout, session }: { canLogout: boolean; onLogout: () => void; session: Awaited<ReturnType<typeof authApi.status>> | null }) {
  const [version, setVersion] = useState<string | null>(null);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const mobileNavOpen = useUIStore((s) => s.mobileNavOpen);
  const toggleMobileNav = useUIStore((s) => s.toggleMobileNav);
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);
  const [featureDescOpen, setFeatureDescOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = useUIStore((s) => s.density);
  const setDensity = useUIStore((s) => s.setDensity);

  const location = useLocation();
  const extensionRegistry = useExtensionRegistry();
  const canManageUsers = session?.platform_admin === true;
  const availableNavigationItems = [...NAV_ITEMS.filter((item) => !item.adminOnly || canManageUsers), ...extensionRegistry.navItems];
  const navigationItems = availableNavigationItems.filter((item) => !item.utility);
  const settingsNavigationItems = availableNavigationItems.filter((item) => item.utility === "settings");
  const navigationGroups = useMemo(() => buildNavGroups(navigationItems), [navigationItems]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (density === "compact") document.documentElement.dataset.density = "compact";
    else delete document.documentElement.dataset.density;
  }, [density]);

  // Header disclosure menus (settings, account) close on an outside press or
  // Escape, returning focus to their trigger, like any other menu.
  useEffect(() => {
    const closeOthers = (target: Node | null) => {
      document.querySelectorAll<HTMLDetailsElement>(".app-header details[open]").forEach((menu) => {
        if (!target || !menu.contains(target)) menu.removeAttribute("open");
      });
    };
    const onPointer = (event: PointerEvent) => closeOthers(event.target as Node | null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open = document.querySelector<HTMLDetailsElement>(".app-header details[open]");
      if (!open) return;
      open.removeAttribute("open");
      open.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Ctrl/⌘ K opens the jump list from anywhere, including text fields, the
  // way every desktop command palette behaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Best-effort RUM: ship Core Web Vitals to the backend (silently no-ops if absent).
  useEffect(() => {
    initWebVitals();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    systemApi
      .version(ctrl.signal)
      .then((res) => setVersion(res.version || "unknown"))
      .catch(() => setVersion(null));
    return () => ctrl.abort();
  }, []);

  // Close the off-canvas drawer whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname, setMobileNavOpen]);

  // Route chunks are warmed only from navigation intent (hover, focus, touch).
  // Do not bulk-preload the console shortly after login: it competes with input,
  // WebSocket streaming and the first operational request on constrained links.

  useEffect(() => {
    if (!currentWorkspaceId) return;
    let active = true;
    setActiveWorkspaceScope(currentWorkspaceId);
    void Promise.resolve(useWorkbenchStore.persist.rehydrate()).then(() => {
      if (active) return recoverStreamingTurns(currentWorkspaceId);
    }).catch(() => { /* Reconnection remains owned by the transport. */ });
    return () => { active = false; disconnectTurnTransport(); };
  }, [session?.username, currentWorkspaceId]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          type="button"
          className="nav-toggle"
          data-testid="btn-mobile-nav"
          aria-label={mobileNavOpen ? "关闭导航" : "打开导航"}
          aria-expanded={mobileNavOpen}
          aria-controls="layout-left"
          onClick={toggleMobileNav}
        >
          {mobileNavOpen ? <IconChevronLeft size={16} /> : <IconMenu size={16} />}
        </button>

        <div className="brand-zone">
          <Link className="brand" to="/workbench" viewTransition>
            <span className="brand-mark" aria-hidden="true">联</span>
            <span className="brand-text">
              <span>联智中枢</span>
              <small>{version ? formatVersion(version) : ""}</small>
            </span>
          </Link>
          <button
            type="button"
            className={`sidebar-toggle-btn ${sidebarOpen ? "is-active" : ""}`}
            data-tip={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            data-testid="btn-toggle-sidebar"
            aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <IconSidebarSimple size={16} />
          </button>
        </div>

        <nav className="app-nav" aria-label="主导航">
          {navigationGroups.map((group) => <NavGroupItem key={group.id} group={group} currentPath={location.pathname} currentSearch={location.search} />)}
        </nav>

        <div className="app-actions" aria-label="页面操作">
          <button
            type="button"
            className="command-trigger"
            data-testid="btn-command-palette"
            aria-keyshortcuts="Control+K Meta+K"
            title="快速跳转（Ctrl K）"
            aria-haspopup="dialog"
            onClick={() => setPaletteOpen(true)}
          >
            <IconSearch size={15} aria-hidden="true" />
            <span className="command-trigger-label">搜索页面与会话</span>
            <kbd aria-hidden="true">Ctrl K</kbd>
          </button>
          <button
            type="button"
            className="header-icon-btn feature-desc-btn"
            data-testid="btn-feature-desc"
            aria-label="功能描述"
            data-tip="功能描述"
            onClick={() => setFeatureDescOpen(true)}
          >
            <IconHelp size={17} aria-hidden="true" />
          </button>
          <DesktopSettingsButton />
          <SettingsNav items={settingsNavigationItems} currentPath={location.pathname} />

          <button
            type="button"
            className="header-icon-btn theme-toggle"
            data-tip={theme === "dark" ? "切换浅色" : "切换深色"}
            aria-label="切换主题"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
          </button>

          <AccountMenu session={session} density={density} onDensity={setDensity} />

          {canLogout ? (
            <button
            type="button"
            className="logout-btn"
            aria-label="退出登录"
            title={session?.username ? `当前用户：${session.username}` : "退出登录"}
            onClick={onLogout}
            >
              <IconSignOut size={15} aria-hidden="true" />
              <span>退出</span>
            </button>
          ) : null}
        </div>
      </header>

      <div className="app-main">
        {/* AppLayout renders the persistent sidebar + main grid once; the
            Suspense boundary keeps it visible while a route's chunk loads,
            so navigation never tears down the shell. */}
        <AppLayout navigationItems={navigationItems} settingsNavigationItems={settingsNavigationItems}>
          <AppRoutes canManageUsers={canManageUsers} />
        </AppLayout>
      </div>
      <ToastHost />
      <ConfirmHost />
      <FormDialogHost />
      <FeatureDescriptionDrawer open={featureDescOpen} onClose={() => setFeatureDescOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={availableNavigationItems} />
    </div>
  );
}

export function App() {
  const [authState, setAuthState] = useState<"checking" | "public" | "authenticated" | "login">("checking");
  const [session, setSession] = useState<Awaited<ReturnType<typeof authApi.status>> | null>(null);
  const [showAuthLoading, setShowAuthLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const loadingTimer = window.setTimeout(() => setShowAuthLoading(true), 280);
    authApi
      .status(ctrl.signal)
      .then((res) => {
        clearTimeout(loadingTimer);
        if (res.authenticated) {
          applyAuthenticatedSession(res);
          setSession(res);
          setAuthState("authenticated");
          return;
        }
        if (!res.login_enabled) {
          setSession(res);
          setAuthState("public");
          return;
        }
        setAuthState("login");
      })
      .catch((err) => {
        clearTimeout(loadingTimer);
        // React StrictMode intentionally mounts, cleans up, and mounts effects
        // again in development. The first auth request is therefore aborted on
        // refresh; treating that cancellation as an authentication failure
        // briefly mounts LoginScreen before the second request succeeds.
        if (ctrl.signal.aborted || (isApiError(err) && err.code === "aborted")) {
          return;
        }
        setAuthState("login");
      });
    return () => {
      clearTimeout(loadingTimer);
      ctrl.abort();
    };
  }, []);

  const handleLogin = useCallback((nextSession: Awaited<ReturnType<typeof authApi.status>>) => {
    applyAuthenticatedSession(nextSession);
    setSession(nextSession);
    setAuthState("authenticated");
  }, []);

  const handleLogout = useCallback(() => {
    authApi.logout().finally(() => {
      clearUserScopedFrontendState();
      setSession(null);
      setAuthState("login");
    });
  }, []);

  if (authState === "checking") {
    return <div className={`auth-loading${showAuthLoading ? " visible" : ""}`} role="status" aria-label="加载中" />;
  }

  if (authState === "login") {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <BrowserRouter>
      <ExtensionRegistryProvider>
        <AppShell
          canLogout={authState === "authenticated" && session?.auth_type !== "api_token"}
          onLogout={handleLogout}
          session={session}
        />
      </ExtensionRegistryProvider>
    </BrowserRouter>
  );
}
