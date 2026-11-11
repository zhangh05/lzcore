import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES, isAdmin, type NavSection } from "../contracts/naming";
import { extensionNavItems } from "../contracts/extensions";
import { NavIcon } from "../components/NavIcon";
import { IconSparkle } from "../components/Icon";
import { Link, useLocation } from "../router";
import { useShell } from "./shellContext";

function isActive(pathname: string, path: string, exact = false): boolean {
  return exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
}

function sectionRoot(section: NavSection): string {
  return section.key === "library" ? "/library" : section.path;
}

function CoreSection({ section }: { section: NavSection }) {
  const { pathname } = useLocation();
  const { hrefFor, auth } = useShell();
  const admin = isAdmin(auth);
  const active = isActive(pathname, sectionRoot(section));
  return (
    <li>
      <Link to={hrefFor(section.path)} className={`nav-item ${active ? "is-active" : ""}`} aria-current={active && !section.children ? "page" : undefined} data-nav={section.key}>
        <NavIcon name={section.icon} />
        <span>{section.label}</span>
      </Link>
      {section.children && active ? (
        <ul className="nav-children">
          {section.children.filter((c) => !c.adminOnly || admin).map((child) => {
            const childActive = isActive(pathname, child.path, child.path === section.path && section.key === "system");
            return (
              <li key={child.key}>
                <Link to={hrefFor(child.path)} className={`nav-item nav-child ${childActive ? "is-active" : ""}`} aria-current={childActive ? "page" : undefined} data-nav={child.key}>
                  <span>{child.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

export function Sidebar() {
  const { extensions, hrefFor } = useShell();
  const { pathname } = useLocation();
  const mounts = extensionNavItems(extensions);
  return (
    <nav className="app-sidebar" aria-label="主导航">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><IconSparkle size={15} strokeWidth={2.2} /></span><span className="brand-name">{NAMES.product}</span></div>
      <ul className="nav-list">
        {CORE_NAV_BEFORE_EXTENSIONS.map((s) => <CoreSection key={s.key} section={s} />)}
      </ul>
      <div className="nav-group" data-testid="nav-extensions">
        <Link to={hrefFor("/extensions")} className={`nav-group-title ${pathname === "/extensions" ? "is-active" : ""}`} data-nav="extensions">
          {NAMES.extensions}
        </Link>
        {extensions.kind === "loading" ? <p className="nav-note">读取扩展目录…</p> : null}
        {extensions.kind === "error" ? <p className="nav-note" role="status">扩展目录不可读：{extensions.reason}</p> : null}
        {extensions.kind === "ready" && mounts.length === 0 ? <p className="nav-note">暂无提供界面的扩展。</p> : null}
        <ul className="nav-list">
          {mounts.map((m) => {
            const active = isActive(pathname, m.path);
            return (
              <li key={`${m.extensionId}:${m.path}`}>
                <Link to={hrefFor(m.path)} className={`nav-item ${active ? "is-active" : ""} ${m.available ? "" : "is-unavailable"}`}
                  aria-current={active ? "page" : undefined} title={m.available ? m.description : m.reason} data-nav={`ext:${m.extensionId}`}>
                  <NavIcon name={m.icon} />
                  <span>{m.label}</span>
                  {!m.available ? <span className="nav-pill">不可用</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <ul className="nav-list nav-bottom">
        {CORE_NAV_AFTER_EXTENSIONS.map((s) => <CoreSection key={s.key} section={s} />)}
      </ul>
    </nav>
  );
}
