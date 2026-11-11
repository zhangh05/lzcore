import { CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, NAMES } from "../contracts/naming";
import { extensionNavItems } from "../contracts/extensions";
import { IconChevronRight } from "../components/Icon";
import { Link, useLocation } from "../router";
import { useShell } from "./shellContext";

interface Crumb { label: string; path?: string }

/** 从当前路径推出「你在哪」：一级入口 › 子页。只读导航表与扩展目录，不写死页面名。 */
export function crumbsFor(pathname: string, extLabels: { path: string; label: string }[]): Crumb[] {
  if (pathname === "/review") return [{ label: NAMES.reviewInbox }];
  if (pathname === "/extensions") return [{ label: NAMES.extensions }];
  if (pathname.startsWith("/extensions/")) {
    const hit = extLabels.filter((m) => pathname === m.path || pathname.startsWith(`${m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    return [{ label: NAMES.extensions, path: "/extensions" }, { label: hit?.label ?? "扩展页面" }];
  }
  for (const s of [...CORE_NAV_BEFORE_EXTENSIONS, ...CORE_NAV_AFTER_EXTENSIONS]) {
    const root = s.key === "library" ? "/library" : s.path;
    if (pathname !== root && !pathname.startsWith(`${root}/`)) continue;
    if (!s.children) return [{ label: s.label }];
    const child = s.children.find((c) => c.path === pathname) ?? (s.key === "library" ? s.children[0] : undefined);
    if (!child) return [{ label: s.label, path: s.path }];
    return [{ label: s.label, path: s.path }, { label: child.label }];
  }
  return [];
}

export function Breadcrumb() {
  const { pathname } = useLocation();
  const { extensions, hrefFor } = useShell();
  const crumbs = crumbsFor(pathname, extensionNavItems(extensions));
  if (!crumbs.length) return null;
  return (
    <nav className="breadcrumb" aria-label="位置">
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {i > 0 ? <IconChevronRight size={14} className="breadcrumb-sep" aria-hidden="true" /> : null}
              {last || !c.path ? <span aria-current={last ? "page" : undefined} className={last ? "is-current" : ""}>{c.label}</span>
                : <Link to={hrefFor(c.path)}>{c.label}</Link>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
