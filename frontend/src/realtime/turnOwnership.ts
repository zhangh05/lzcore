type TurnTerminalHook = (sessionId: string, requestId: string) => void;

const hooks = new Set<TurnTerminalHook>();

export function onTurnTerminal(hook: TurnTerminalHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

export function notifyTurnTerminal(sessionId: string, requestId: string): void {
  if (!sessionId || !requestId) return;
  for (const hook of hooks) hook(sessionId, requestId);
}
