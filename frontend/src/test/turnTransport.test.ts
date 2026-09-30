import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ state: null as any, sockets: [] as any[] }));
vi.mock('../api/index.ts', () => ({
  runtimeAuditApi: { run: vi.fn(async () => ({})), trace: vi.fn(async () => ({ events: [] })) },
  agentApi: { run: vi.fn() }, jobsApi: { list: vi.fn(async () => ({ jobs: [] })), cancel: vi.fn() }, sessionsApi: { messages: vi.fn(async () => ({ messages: [] })) },
}));
vi.mock('../api/client.ts', () => ({
  ensureLocalBrowserToken: async () => '', getApiAccessToken: () => '', realtimeEndpoint: () => 'ws://review/ws/agent',
}));
vi.mock('../stores/workbench.ts', () => ({ useWorkbenchStore: { getState: () => fixture.state } }));
vi.mock('../stores/session.ts', () => ({ useSessionStore: { getState: () => ({ setCurrentSession() {} }) } }));
import { recoverStreamingTurns, disconnectTurnTransport, resetTurnTransport, sendTurn } from '../realtime/turnTransport.ts';
beforeEach(() => {
  fixture.sockets.length = 0;
  fixture.state = {
    bySession: { session: [{ id: 'bubble', role: 'assistant', text: 'before', status: 'streaming', client_request_id: 'request', streamSeq: 0, toolCalls: [] }] },
    activeTurns: {},
    beginTurn(s: string, r: string) { this.activeTurns[s] = r; },
    endTurn(s: string) { delete this.activeTurns[s]; },
    updateAssistant(id: string, patch: any, s: string) { const m = this.bySession[s]?.find((x: any) => x.id === id); if (m) Object.assign(m, patch); },
    appendUser(text: string, s: string) { this.bySession[s].push({ id: 'new-user', role: 'user', text }); return 'new-user'; },
    appendAssistantStreaming(s: string, r: string) { this.bySession[s].push({ id: 'new-bubble', role: 'assistant', text: '', status: 'streaming', client_request_id: r, streamSeq: 0, toolCalls: [] }); return 'new-bubble'; },
    setLatestResult() {},
    discardMessages(ids: string[], s: string) { this.bySession[s] = this.bySession[s].filter((m: any) => !ids.includes(m.id)); },
  };
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; onopen?: () => void; onmessage?: (e: any) => void; onclose?: () => void; sent: any[] = [];
    constructor() { fixture.sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose?.(); }
    frame(m: any) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => { for (const socket of fixture.sockets) socket.onclose = undefined; resetTurnTransport(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('does not reconnect after explicit application teardown', async () => {
  await recoverStreamingTurns('default');
  disconnectTurnTransport();
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.sockets).toHaveLength(1);
});
it('restores tool cards while a refreshed turn is still running', async () => {
  await recoverStreamingTurns('default');
  fixture.sockets[0].frame({ type: 'event', name: 'tool_call', session_id: 'session', client_request_id: 'request', seq: 1, data: { tool_id: 'web.manage', call_id: 'call' } });
  expect(fixture.state.bySession.session[0].toolCalls).toHaveLength(1);
});
it('does not apply a different request terminal to the only active turn', async () => {
  await recoverStreamingTurns('default');
  fixture.sockets[0].frame({ type: 'done', session_id: 'other-session', client_request_id: 'other-request', seq: 2, final_response: 'other answer' });
  expect(fixture.state.bySession.session[0].status).toBe('streaming');
});
it('opens the application subscription even when no turn needs recovery', async () => {
  fixture.state.bySession = {};
  await recoverStreamingTurns('default');
  expect(fixture.sockets).toHaveLength(1);
});
it('does not advance the saved cursor past token text still waiting for render', async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const pending = sendTurn({ text: 'hello', attachments: [], effectiveSessionId: 'session' }, { workspaceId: 'default', sessionId: 'session', llmHealth: {} });
  await vi.waitFor(() => expect(fixture.sockets[0]?.sent.some((m: any) => m.type === 'message')).toBe(true));
  const request = fixture.sockets[0].sent.find((m: any) => m.type === 'message').metadata.client_request_id;
  fixture.sockets[0].frame({ type: 'token', client_request_id: request, seq: 1, content: 'buffered text' });
  fixture.sockets[0].frame({ type: 'event', client_request_id: request, seq: 2, name: 'tool_result', data: { tool_id: 'web.manage', call_id: 'call', ok: true } });
  const snapshot = { ...fixture.state.bySession.session.at(-1) };
  fixture.sockets[0].frame({ type: 'done', client_request_id: request, session_id: 'session', seq: 3, final_response: 'done', metadata: {} });
  await pending;
  expect(snapshot.streamSeq).toBe(2);
  expect(snapshot.text).toBe("buffered text");
});

it('recovers stage boundaries, hidden reasoning and final inspector metadata through the same reducer', async () => {
  fixture.state.bySession.session[0].streamSeq = 5;
  fixture.state.bySession.session[0].streamFilterState = { mode: 'open', pending: '' };
  await recoverStreamingTurns('default');
  const socket = fixture.sockets[0];
  const frame = (payload: any) => socket.frame({ session_id: 'session', client_request_id: 'request', ...payload });
  frame({ type: 'token', seq: 6, content: 'private reasoning</think>visible' });
  frame({ type: 'event', seq: 7, name: 'tool_call', data: { tool_id: 'web.manage', call_id: 'call' } });
  expect(fixture.state.bySession.session[0].stageOutputs[0].text).toBe('beforevisible');
  expect(fixture.state.bySession.session[0].text).toBe('');
  frame({ type: 'done', seq: 8, final_response: 'final answer', turn_id: 'turn', trace_id: 'trace',
    tool_calls: [{ call_id: 'call', tool_id: 'web.manage', ok: true }], metadata: { cognitive: { goal: 'goal' } } });
  await vi.waitFor(() => expect(fixture.state.bySession.session[0].status).toBe('ready'));
  expect(fixture.state.bySession.session[0].trace_id).toBe('trace');
  expect(fixture.state.bySession.session[0].result.metadata.cognitive.goal).toBe('goal');
  expect(fixture.state.bySession.session[0].toolCalls[0].status).toBe('done');
  expect(fixture.state.activeTurns).toEqual({});
});
it('ignores frames for a different session or workspace even with the same request id', async () => {
  await recoverStreamingTurns('default');
  fixture.sockets[0].frame({ type: 'done', session_id: 'other', client_request_id: 'request', seq: 1 });
  fixture.sockets[0].frame({ type: 'done', workspace_id: 'other', session_id: 'session', client_request_id: 'request', seq: 1 });
  expect(fixture.state.bySession.session[0].status).toBe('streaming');
});
it('reconnects an idle application subscription and receives topology updates', async () => {
  fixture.state.bySession = {};
  const { onTopologyUpdated } = await import('../realtime/turnTransport');
  const seen = vi.fn();
  const unsubscribe = onTopologyUpdated(seen);
  await recoverStreamingTurns('default');
  fixture.sockets[0].close();
  await vi.waitFor(() => expect(fixture.sockets).toHaveLength(2));
  fixture.sockets[1].frame({ type: 'event', name: 'topology_updated', data: { workspace_id: 'default', topology_id: 'topo', version: 2 } });
  expect(seen).toHaveBeenCalledOnce();
  unsubscribe();
});
it('does not let an old connection finish a new identity turn', async () => {
  await recoverStreamingTurns('default');
  const oldHandler = fixture.sockets[0].onmessage;
  disconnectTurnTransport();
  fixture.state.bySession.session[0].text = 'new identity';
  oldHandler?.({ data: JSON.stringify({ type: 'done', session_id: 'session', client_request_id: 'request', seq: 1, final_response: 'old identity' }) });
  await Promise.resolve();
  expect(fixture.state.bySession.session[0].text).toBe('new identity');
  expect(fixture.state.bySession.session[0].status).toBe('streaming');
});
it('treats an in-progress idempotent redirect as a resume control response', async () => {
  await recoverStreamingTurns('default');
  fixture.sockets[0].frame({ type: 'done', session_id: 'session', client_request_id: 'request',
    metadata: { idempotent: true, idempotent_redirect: { job_id: 'job', status: 'running', client_request_id: 'request' } } });
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.state.bySession.session[0].status).toBe('streaming');
  expect(fixture.sockets[0].sent.filter((item: any) => item.type === 'resume')).toHaveLength(2);
});
it('restores the complete applied buffer rather than partially revealed text', async () => {
  fixture.state.bySession.session[0].text = 'part';
  fixture.state.bySession.session[0].streamDraft = 'partial full buffer';
  fixture.state.bySession.session[0].streamSeq = 1;
  await recoverStreamingTurns('default');
  fixture.sockets[0].frame({ type: 'token', session_id: 'session', client_request_id: 'request', seq: 2, content: ' suffix' });
  fixture.sockets[0].frame({ type: 'event', session_id: 'session', client_request_id: 'request', seq: 3, name: 'tool_result', data: {} });
  expect(fixture.state.bySession.session[0].text).toBe('partial full buffer suffix');
});

it('reconciles a missed terminal from the matching durable job and messages', async () => {
  vi.useFakeTimers();
  const { jobsApi, sessionsApi } = await import('../api');
  vi.mocked(jobsApi.list).mockResolvedValueOnce({ jobs: [{ job_id: 'job', status: 'succeeded', metadata: { active_turn: { client_request_id: 'request', session_id: 'session', status: 'succeeded' } } } as any] });
  vi.mocked(sessionsApi.messages).mockResolvedValueOnce({ ok: true, count: 1, messages: [{ role: 'assistant', content: 'durable answer', created_at: '', metadata: { client_request_id: 'request' } }] });
  await recoverStreamingTurns('default');
  await vi.advanceTimersByTimeAsync(2500);
  expect(fixture.state.bySession.session[0].status).toBe('ready');
  expect(fixture.state.bySession.session[0].text).toBe('durable answer');
  vi.useRealTimers();
});
