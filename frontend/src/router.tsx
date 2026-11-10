/* Copied from frontend/src/router.tsx @ f1664ce (safeTarget same-origin guard). Only this copy is edited. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export type AppLocation = {
  pathname: string;
  search: string;
  hash: string;
};

type RouterValue = {
  location: AppLocation;
  navigate: (target: string, options?: { replace?: boolean }) => void;
};

const RouterContext = createContext<RouterValue | null>(null);

export function safeTarget(raw: string): string {
  const value = String(raw || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) {
    throw new Error("Only same-origin application paths are allowed");
  }
  const parsed = new URL(value, window.location.origin);
  if (parsed.origin !== window.location.origin) {
    throw new Error("Cross-origin navigation is not allowed");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// ── 应用内跳转守卫（阶段 6 扩展：拓扑未保存守卫）。只拦本路由器内的 navigate / Link，外加 beforeunload。
type NavigationGuard = (target: string) => boolean;
let activeGuard: NavigationGuard | null = null;

/** 返回 false 表示取消这次跳转。 */
function guardAllows(target: string): boolean {
  return activeGuard ? activeGuard(target) : true;
}

/**
 * 有未保存改动时拦截应用内跳转与关闭页面。`shouldBlock(target)` 决定是否需要询问；
 * 询问默认用 window.confirm，可注入 confirmFn（测试）。
 */
export function useNavigationGuard(when: boolean, message: string, shouldBlock: (target: string) => boolean = () => true, confirmFn: (m: string) => boolean = (m) => window.confirm(m)) {
  useEffect(() => {
    if (!when) return;
    const guard: NavigationGuard = (target) => !shouldBlock(target) || confirmFn(message);
    activeGuard = guard;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = message; return message; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      if (activeGuard === guard) activeGuard = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [when, message, shouldBlock, confirmFn]);
}

function readWindowLocation(): AppLocation {
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search,
    hash: window.location.hash,
  };
}

export function BrowserRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<AppLocation>(readWindowLocation);

  useEffect(() => {
    const onPopState = () => setLocation(readWindowLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((raw: string, options?: { replace?: boolean }) => {
    const target = safeTarget(raw);
    if (!guardAllows(target)) return;
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", target);
    setLocation(readWindowLocation());
  }, []);

  return <RouterContext.Provider value={{ location, navigate }}>{children}</RouterContext.Provider>;
}

export function MemoryRouter({ children, initialEntries = ["/"] }: { children: ReactNode; initialEntries?: string[] }) {
  const initial = safeTarget(initialEntries[0] || "/");
  const [target, setTarget] = useState(initial);
  const location = useMemo<AppLocation>(() => {
    const parsed = new URL(target, window.location.origin);
    return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  }, [target]);
  const navigate = useCallback((next: string) => { const t = safeTarget(next); if (guardAllows(t)) setTarget(t); }, []);
  return <RouterContext.Provider value={{ location, navigate }}>{children}</RouterContext.Provider>;
}

export function useLocation(): AppLocation {
  const router = useContext(RouterContext);
  if (!router) throw new Error("Router context is required");
  return router.location;
}

export function useNavigate() {
  const router = useContext(RouterContext);
  if (!router) {
    return (raw: string, options?: { replace?: boolean }) => {
      if (typeof window !== "undefined") {
        const target = safeTarget(raw);
        window.history[options?.replace ? "replaceState" : "pushState"]({}, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    };
  }
  return router.navigate;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className"> & {
  to: string;
  className?: string | ((state: { isActive: boolean }) => string);
  viewTransition?: boolean;
};

function InternalLink({ to, className, viewTransition, onClick, children, activeAware: _activeAware, ...props }: LinkProps & { activeAware?: boolean }) {
  const { location, navigate } = useContext(RouterContext) ?? {};
  if (!location || !navigate) throw new Error("Router context is required");
  const target = safeTarget(to);
  const pathname = new URL(target, window.location.origin).pathname;
  const isActive = location.pathname === pathname;
  const resolvedClass = typeof className === "function" ? className({ isActive }) : className;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const perform = () => navigate(target);
    const documentWithTransition = document as Document & { startViewTransition?: (callback: () => void) => void };
    if (viewTransition && documentWithTransition.startViewTransition) {
      documentWithTransition.startViewTransition(perform);
    } else {
      perform();
    }
  };

  return <a {...props} href={target} className={resolvedClass} onClick={handleClick}>{children}</a>;
}

export function Link(props: LinkProps) {
  return <InternalLink {...props} />;
}

export function NavLink(props: LinkProps) {
  return <InternalLink {...props} activeAware />;
}

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}

type SearchParamsInit = URLSearchParams | Record<string, string> | Array<[string, string]>;

export function useSearchParams(): [URLSearchParams, (next: SearchParamsInit, options?: { replace?: boolean }) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const setParams = useCallback((next: SearchParamsInit, options?: { replace?: boolean }) => {
    const query = new URLSearchParams(next).toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}${location.hash}`, options);
  }, [location.hash, location.pathname, navigate]);
  return [params, setParams];
}
