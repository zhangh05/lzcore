import type { ReactNode } from "react";
import { CORE_NAV_AFTER_EXTENSIONS, isAdmin } from "../contracts/naming";
import { NavIcon } from "../components/NavIcon";
import { Link, useLocation } from "../router";
import { useShell } from "./shellContext";

/**
 * 系统的二级导航放在页内左栏，而不是挤进主导航：主导航只保留「系统」一项，
 * 进入后左侧列出它的全部子页（非管理员看不到管理页）。
 */
export function SystemLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { auth, hrefFor } = useShell();
  const admin = isAdmin(auth);
  const system = CORE_NAV_AFTER_EXTENSIONS.find((s) => s.key === "system");
  const items = (system?.children ?? []).filter((c) => !c.adminOnly || admin);
  const general = items.filter((c) => !c.adminOnly);
  const manage = items.filter((c) => c.adminOnly);
  const renderList = (list: typeof items) => (
    <ul className="subnav-list">
      {list.map((c) => {
        const active = pathname === c.path;
        return (
          <li key={c.key}>
            <Link to={hrefFor(c.path)} className={`subnav-item ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined} data-subnav={c.key}>
              <NavIcon name={c.icon} size={16} /><span>{c.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="section-layout">
      <nav className="subnav" aria-label="系统页面">
        <p className="subnav-title">{system?.label}</p>
        {renderList(general)}
        {manage.length ? <><p className="subnav-group">管理</p>{renderList(manage)}</> : null}
      </nav>
      <div className="section-content">{children}</div>
    </div>
  );
}
