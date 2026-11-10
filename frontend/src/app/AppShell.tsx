import { DesktopHost } from "../desktop/DesktopHost";
import { useShell, withWorkspace } from "./shellContext";
import { useNavigate } from "../router";
import { useEffect, useState } from "react";
import { useLocation } from "../router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";
import { Drawer } from "../kit/ui";
import { useMediaQuery } from "../kit/useMediaQuery";
import { RouteView } from "./routes";

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaces } = useShell();
  const compactNav = useMediaQuery("(max-width: 900px)");
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [location.pathname, compactNav]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 路由切换后把焦点移到主区标题，便于读屏。
  useEffect(() => {
    document.querySelector<HTMLElement>("main#app-main h1")?.focus?.();
  }, [location.pathname]);

  return (
    <div className="app-frame">
      {!compactNav ? <Sidebar /> : navOpen ? <Drawer title="主导航" onClose={() => setNavOpen(false)}><Sidebar /></Drawer> : null}
      <div className="app-column">
        <TopBar onToggleNav={compactNav ? () => setNavOpen(true) : undefined} onOpenPalette={() => setPaletteOpen(true)} />
        <main id="app-main" className="app-main" tabIndex={-1}>
          <RouteView />
        </main>
      </div>
      <DesktopHost onTask={(target) => {
        if (workspaces.kind !== "ready" || !workspaces.list.some((w) => w.workspace_id === target.workspace_id)) return;
        navigate(withWorkspace(`/workbench${target.session_id ? `?session=${encodeURIComponent(target.session_id)}` : ""}`, target.workspace_id));
      }} />
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}
