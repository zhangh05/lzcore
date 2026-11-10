/** Personal-mode browser credential. Kept only in memory; never persisted. */
let token = "";
let unused = false;
let pending: Promise<string> | null = null;
let generation = 0;

export function clearLocalAuth() {
  generation += 1;
  token = "";
  unused = false;
  pending = null;
}
export function currentLocalToken() { return token; }
export async function ensureLocalBrowserToken(): Promise<string> {
  if (token || unused) return token;
  if (pending) return pending;
  const started = generation;
  const request = (async () => {
    try {
      const res = await fetch("/api/local-token", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const body = await res.json();
      if (started !== generation) return "";
      if (res.ok && typeof body?.token === "string") token = body.token;
      if (res.status === 404 && body?.error === "local_token_unused") unused = true;
    } catch { /* The actual request reports its own transport result; never replay it. */ }
    return started === generation ? token : "";
  })();
  pending = request;
  try { return await request; }
  finally { if (pending === request) pending = null; }
}
export async function localAuthHeaders(): Promise<Record<string, string>> {
  const credential = await ensureLocalBrowserToken();
  return credential ? { "X-LZCore-Local-Token": credential } : {};
}
