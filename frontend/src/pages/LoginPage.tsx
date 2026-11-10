import { useEffect, useRef, useState, type FormEvent } from "react";
import { httpRequest } from "../api/http";
import { classifyLoginResponse, LOGIN_COPY, type LoginResult } from "../contracts/auth";
import { Button } from "../components/Button";
import { IconKey } from "../components/Icon";

export function LoginPage({ oidcEnabled, onSignedIn }: { oidcEnabled: boolean; onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Exclude<LoginResult, { kind: "ok" }> | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  // 焦点落在第一个空着的字段：通常是账户框（P-18）。
  useEffect(() => { userRef.current?.focus(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await httpRequest("POST", "/api/auth/login", { username, password });
    const result = classifyLoginResponse(outcome);
    setBusy(false);
    if (result.kind === "ok") return onSignedIn();
    setError(result);
    if (result.kind === "invalid_credentials") passRef.current?.select();
  };

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit} aria-describedby="login-subtitle" noValidate>
        <h1>{LOGIN_COPY.title}</h1>
        <p id="login-subtitle" className="login-subtitle">{LOGIN_COPY.subtitle}</p>
        <label className="field">
          <span>{LOGIN_COPY.username}</span>
          <input ref={userRef} name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>{LOGIN_COPY.password}</span>
          <input ref={passRef} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? (
          <p className={`login-error tone-${error.kind === "invalid_credentials" ? "danger" : "warn"}`} role="alert" data-testid={`login-error-${error.kind}`}>
            {error.message}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !username || !password} aria-busy={busy || undefined}>
          {busy ? "正在登录…" : LOGIN_COPY.submit}
        </Button>
        {oidcEnabled ? (
          <div className="login-sso">
            <a className="btn" href="/api/auth/oidc/start" data-testid="login-sso">
              <IconKey size={16} aria-hidden="true" /> {LOGIN_COPY.sso}
            </a>
            <p className="login-note">{LOGIN_COPY.ssoNote}</p>
          </div>
        ) : null}
      </form>
    </main>
  );
}
