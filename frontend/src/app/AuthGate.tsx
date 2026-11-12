import { useCallback, useEffect, useState } from "react";
import { AUTH_LOST_EVENT, httpGet } from "../api/http";
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
  // 已进入产品后某个业务请求返回 401（会话过期、账号被禁用）：重新读取登录状态，让登录入口可达。
  useEffect(() => {
    const onLost = () => setGate((g) => {
      if (g.kind === "signed_in") void httpGet("/api/auth/status").then((o) => setGate(classifyAuthStatus(o)));
      return g;
    });
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onLost);
  }, []);

  switch (gate.kind) {
    case "checking":
      return <StatusScreen kind="checking" title="正在确认登录状态" detail="正在读取服务端登录状态。" />;
    case "backend_unreachable":
      return <StatusScreen kind="unreachable" title="后端不可达" detail={gate.detail} onRetry={check} />;
    case "server_error":
      return <StatusScreen kind="server_error" title="服务器错误" detail={gate.detail} onRetry={check} />;
    case "token_required":
      return <StatusScreen kind="server_error" title="此部署只接受 API 令牌" detail="服务端开启了 API 令牌鉴权，且没有可在浏览器里完成的登录方式，所以网页无法使用。请让管理员开启账号登录，或通过 API 客户端携带令牌访问。" onRetry={check} />;
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
