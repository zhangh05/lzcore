import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES, type NavLeaf } from "../contracts/naming";
import { extensionNavItems } from "../contracts/extensions";
import { NavIcon } from "../components/NavIcon";
import { IconNavCollapse, IconNavExpand, IconSparkle } from "../components/Icon";
import { Link, useLocation } from "../router";
import { useShell } from "./shellContext";
import { usePrefs } from "./prefs";

function isActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * 一条导航项。收起成图标栏时文字仍留在 DOM（读屏与测试照常可读），只是视觉隐藏，悬停给 title。
 */
function NavItem({ leaf, active, extra, className = "", title }: { leaf: Pick<NavLeaf, "key" | "label" | "path" | "icon">; active: boolean; extra?: React.ReactNode; className?: string; title?: string }) {
  const { hrefFor } = useShell();
  return (
    <li>
      <Link to={hrefFor(leaf.path)} className={`nav-item ${active ? "is-active" : ""} ${className}`} aria-current={active ? "page" : undefined}
        data-nav={leaf.key} title={title ?? leaf.label}>
        <NavIcon name={leaf.icon} />
        <span className="nav-label">{leaf.label}</span>
        {extra}
      </Link>
    </li>
  );
}

/**
 * 主导航：按「做事 → 资料 → 扩展 → 系统」分组，每一项都平铺可见，不再靠展开子级找入口。
 * 系统只占一项，子页导航放在系统页内部；资料三类常显，页内不再重复分类标签。
 */
export function Sidebar({ inDrawer = false }: { inDrawer?: boolean }) {
  const { extensions, hrefFor } = useShell();
  const { pathname } = useLocation();
  const { navCollapsed, setNavCollapsed } = usePrefs();
  const collapsed = navCollapsed && !inDrawer;
  const mounts = extensionNavItems(extensions);
  const [primary, library] = [
    CORE_NAV_BEFORE_EXTENSIONS.filter((s) => s.key !== "library"),
    CORE_NAV_BEFORE_EXTENSIONS.find((s) => s.key === "library"),
  ];
  const system = CORE_NAV_AFTER_EXTENSIONS;
  return (
    <nav className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="主导航">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><IconSparkle size={15} strokeWidth={2.2} /></span>
        <span className="brand-name">{NAMES.product}</span>
        {!inDrawer ? (
          <button type="button" className="nav-collapse" onClick={() => setNavCollapsed(!navCollapsed)}
            aria-label={navCollapsed ? "展开导航" : "收起导航"} title={navCollapsed ? "展开导航" : "收起导航"} aria-pressed={navCollapsed}>
            {navCollapsed ? <IconNavExpand size={16} aria-hidden="true" /> : <IconNavCollapse size={16} aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      <ul className="nav-list">
        {primary.map((s) => <NavItem key={s.key} leaf={s} active={isActive(pathname, s.path)} />)}
      </ul>

      {library ? (
        <div className="nav-group" role="group" aria-labelledby="nav-group-library">
          <p className="nav-group-title" id="nav-group-library">{library.label}</p>
          <ul className="nav-list">
            {(library.children ?? []).map((c) => (
              <NavItem key={c.key} leaf={c} active={isActive(pathname, c.path) || (c.key === "files" && pathname === "/library")} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="nav-group" data-testid="nav-extensions">
        <Link to={hrefFor("/extensions")} className={`nav-group-title is-link ${pathname === "/extensions" ? "is-active" : ""}`} data-nav="extensions"
          aria-current={pathname === "/extensions" ? "page" : undefined} title="查看全部扩展">
          <span className="nav-label">{NAMES.extensions}</span>
        </Link>
        {extensions.kind === "loading" ? <p className="nav-note">读取扩展目录…</p> : null}
        {extensions.kind === "error" ? <p className="nav-note" role="status">扩展目录不可读：{extensions.reason}</p> : null}
        {extensions.kind === "ready" && mounts.length === 0 ? <p className="nav-note">暂无提供界面的扩展。</p> : null}
        <ul className="nav-list">
          {mounts.map((m) => (
            <NavItem key={`${m.extensionId}:${m.path}`} leaf={{ key: `ext:${m.extensionId}`, label: m.label, path: m.path, icon: m.icon }}
              active={isActive(pathname, m.path)} className={m.available ? "" : "is-unavailable"}
              title={m.available ? (m.description || m.label) : m.reason}
              extra={!m.available ? <span className="nav-pill">不可用</span> : null} />
          ))}
        </ul>
      </div>

      <ul className="nav-list nav-bottom">
        {system.map((s) => <NavItem key={s.key} leaf={s} active={isActive(pathname, s.path)} />)}
      </ul>
    </nav>
  );
}
