import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "./components/arc/foundation.css";
import "./styles/arc-overrides.css";
import "./styles/tokens.css";
import "./styles/semantic.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/markdown.css";
import "./desktop/desktop.css";
import { BrowserRouter } from "./router";
import { AuthGateView } from "./app/AuthGate";
import { applyStoredPrefs } from "./app/prefs";
import { ErrorBoundary } from "./app/ErrorBoundary";

applyStoredPrefs();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <BrowserRouter>
        <AuthGateView />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
