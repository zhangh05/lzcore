import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/semantic.css";
import "./styles/app.css";
import "./desktop/desktop.css";
import { BrowserRouter } from "./router";
import { AuthGateView } from "./app/AuthGate";
import { applyStoredPrefs } from "./app/prefs";

applyStoredPrefs();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGateView />
    </BrowserRouter>
  </StrictMode>,
);
