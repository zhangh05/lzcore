import { useCallback, useEffect, useState } from "react";
import { httpGet } from "../api/http";
import { classifyAuthStatus, type AuthGate } from "../contracts/auth";
import { LoginPage } from "../pages/LoginPage";
import { StatusScreen } from "../pages/StatusScreen";
import { AppShell } from "./AppShell";
import { ShellProvider } from "./shellContext";

export function AuthGateView() {
  const [gate, setGate] = useState<AuthGate>({ kind: "checking" });
  const check = useCallback(() => {
    setGate({ kind: "checking" });
    void httpGet("/api/auth/status").then((o) => setGate(classifyAuthStatus(o)));
  }, []);
  useEffect(() => { check(); }, [check]);

  switch (gate.kind) {
    case "checking":
      return <StatusScreen kind="checking" title="正在确认登录状态" detail="正在读取服务端登录状态。" />;
    case "backend_unreachable":
      return <StatusScreen kind="unreachable" title="后端不可达" detail={gate.detail} onRetry={check} />;
    case "server_error":
      return <StatusScreen kind="server_error" title="服务器错误" detail={gate.detail} onRetry={check} />;
    case "login_required":
      return <LoginPage oidcEnabled={gate.oidcEnabled} onSignedIn={check} />;
    case "signed_in":
    case "open":
      return (
        <ShellProvider auth={gate.status} onSignedOut={check}>
          <AppShell />
        </ShellProvider>
      );
  }
}
