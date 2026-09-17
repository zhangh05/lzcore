import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// Cascade order is declared in one place, not decided by import order.
// See styles/layers.css for the order and the rules that keep it stable.
import "./styles/layers.css";
// Shared component styles load from the entry rather than from whichever page
// module imports the component first: a page deciding the cascade position of a
// shared stylesheet is how the order became accidental in the first place.
import "./components/RuntimeEventTimeline.css";
import "./styles/global.css";
import "./styles/product-shell.css";
import "./styles/console-system.css";
import "./pages/AgentWorkbench/AgentWorkbench.css";
import "./styles/typography.css";
// Page refinements come last: they exist to outrank the design system above.
// See styles/pages.css.
import "./styles/pages.css";
// Narrow-width adaptations last: they must outrank the unconditional rules they
// refine, and a declared layer is what makes that true regardless of import
// order. See styles/responsive.css.
import "./styles/responsive.css";

// Theme initialization — read from Zustand persist store (lzcore_ui) or
// fall back to prefers-color-scheme. We do this BEFORE React mounts so
// the first paint uses the correct tokens and there's no flash.
(function initTheme() {
  try {
    const raw = localStorage.getItem("lzcore_ui");
    if (raw) {
      const ui = JSON.parse(raw);
      if (ui.state?.theme === "light" || ui.state?.theme === "dark") {
        document.documentElement.setAttribute("data-theme", ui.state.theme);
        return;
      }
    }
  } catch {
    /* ignore */
  }
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
})();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

// v3.27.1: StrictMode restored. The previous "Maximum update depth exceeded"
// turned out to come from `Diagnostics.tsx` returning a fresh
// `JSON.parse(...)` object from `useSyncExternalStore`'s getSnapshot on
// every render, violating React 18's snapshot-stability contract — not
// from StrictMode double-invocation.
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
