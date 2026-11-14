import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES, type NavLeaf } from "../contracts/naming";
import { extensionNavItems } from "../contracts/extensions";
import { NavIcon } from "../components/NavIcon";
import { useLayoutEffect, useRef } from "react";
import { IconNavCollapse, IconNavExpand } from "../components/Icon";
import { Link, useLocation } from "../router";
import { useShell } from "./shellContext";
import { usePrefs } from "./prefs";

/** 产品标识：一个中枢节点连着三个端点，对应「联智中枢」。 */
function BrandGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 8 3.5 4M8 8l4.5-4M8 8v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="8" r="2.3" fill="currentColor" />
      <circle cx="3.5" cy="4" r="1.5" fill="currentColor" />
      <circle cx="12.5" cy="4" r="1.5" fill="currentColor" />
      <circle cx="8" cy="13" r="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Windows 11 导航选中指示条：整栏只有一条，切换页面时从旧位置滑到新位置，
 * 而不是每一项各画一条。没有选中项（例如扩展总览）时淡出。
 */
function useNavIndicator(deps: unknown[]) {
  const navRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const bar = barRef.current;
    if (!nav || !bar) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>(".nav-item.is-active");
      if (!active) { bar.style.opacity = "0"; return; }
      const navBox = nav.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      const first = !bar.dataset.placed;
      if (first) bar.style.transition = "none";
      bar.style.opacity = "1";
      bar.style.transform = `translate(${box.left - navBox.left}px, ${box.top - navBox.top + nav.scrollTop + (box.height - 16) / 2}px)`;
      if (first) {
        // 首次定位直接落位，之后的切换才滑动。
        void bar.offsetWidth;
        bar.style.transition = "";
        bar.dataset.placed = "1";
      }
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(nav);
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { navRef, barRef };
}

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
  const { navRef, barRef } = useNavIndicator([pathname, collapsed, mounts.length]);
  return (
    <nav ref={navRef} className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="主导航">
      <span ref={barRef} className="nav-indicator" aria-hidden="true" />
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><BrandGlyph /></span>
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
