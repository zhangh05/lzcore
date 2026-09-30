import { test, expect } from './fixtures';
import type { WebSocketRoute } from '@playwright/test';

test('24. route changes retain one connection and refresh resumes the applied cursor', async ({ page, api, workspaceId }) => {
  const created = await api.post('/api/sessions', { data: { workspace_id: workspaceId, title: 'transport recovery' } });
  const sessionId = (await created.json()).session.session_id as string;
  const sockets: WebSocketRoute[] = [];
  const incoming: Record<string, any>[] = [];
  await page.routeWebSocket('**/ws/agent', socket => {
    sockets.push(socket);
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      incoming.push(frame);
      if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
  });
  await page.goto('/workbench');
  await expect.poll(() => incoming.filter(frame => frame.type === 'ping').length).toBe(1);
  await page.evaluate(async ({ sessionId, workspaceId }) => {
    const transportPath = '/src/realtime/turnTransport.ts';
    const storePath = '/src/stores/workbench.ts';
    const { sendTurn } = await import(/* @vite-ignore */ transportPath);
    const { useWorkbenchStore } = await import(/* @vite-ignore */ storePath);
    useWorkbenchStore.getState().switchSession(sessionId);
    void sendTurn({ text: 'recovery test', attachments: [], effectiveSessionId: sessionId }, { workspaceId, sessionId, llmHealth: {} });
  }, { sessionId, workspaceId });
  await expect.poll(() => incoming.some(frame => frame.type === 'message')).toBe(true);
  const requestId = incoming.find(frame => frame.type === 'message')!.metadata.client_request_id;
  const send = (payload: Record<string, unknown>) => sockets.at(-1)!.send(JSON.stringify({ session_id: sessionId, client_request_id: requestId, ...payload }));
  send({ type: 'token', seq: 1, content: 'buffered text' });
  await page.getByTestId('nav-group-system').click();
  await expect(page).toHaveURL(/diagnostics/);
  send({ type: 'event', seq: 2, name: 'tool_call', data: { call_id: 'call', tool_id: 'web.manage' } });
  const snapshot = () => page.evaluate(async sessionId => {
    const path = '/src/stores/workbench.ts';
    const { useWorkbenchStore } = await import(/* @vite-ignore */ path);
    return useWorkbenchStore.getState().bySession[sessionId]?.at(-1);
  }, sessionId);
  await expect.poll(async () => (await snapshot())?.streamSeq).toBe(2);
  expect((await snapshot())?.stageOutputs[0].text).toBe('buffered text');
  expect(sockets).toHaveLength(1);
  await page.reload();
  await expect.poll(() => incoming.filter(frame => frame.type === 'resume').length).toBe(1);
  const resume = incoming.find(frame => frame.type === 'resume')!;
  expect(resume.client_request_id).toBe(requestId);
  expect(resume.stream_seq).toBe(2);
  send({ type: 'event', seq: 3, name: 'tool_result', data: { call_id: 'call', tool_id: 'web.manage', ok: true } });
  await expect.poll(async () => (await snapshot())?.toolCalls[0].status).toBe('done');
  send({ type: 'done', seq: 4, final_response: 'recovered answer', turn_id: 'run-recovered', trace_id: 'trace-recovered', metadata: {} });
  await expect.poll(async () => (await snapshot())?.status).toBe('ready');
  expect((await snapshot())?.text).toBe('recovered answer');
  expect((await snapshot())?.trace_id).toBe('trace-recovered');
  expect(sockets).toHaveLength(2);
});

test('24b. an idle application adopts a topology version broadcast before any turn completes', async ({ page, workspaceId }) => {
  let socket: WebSocketRoute | undefined;
  let version = 1;
  let reads = 0;
  const topologyId = 'broadcast-topology';
  const drawing = () => ({ topology_id: topologyId, name: 'broadcast drawing', version,
    nodes: version === 1 ? [] : [{ node_id: 'broadcast-node', display_name: '服务端新增节点', device_type: 'router', x: 100, y: 100 }],
    links: [], groups: [], canvas_items: [],
  });
  await page.route('**/api/extensions/network.operations/topologies**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/revisions')) return route.fulfill({ json: { revisions: [] } });
    if (url.pathname.endsWith(`/${topologyId}`)) { reads += 1; return route.fulfill({ json: { topology: drawing() } }); }
    return route.fulfill({ json: { topologies: [drawing()] } });
  });
  await page.routeWebSocket('**/ws/agent', route => {
    socket = route;
    route.onMessage(raw => { if (JSON.parse(String(raw)).type === 'ping') route.send(JSON.stringify({ type: 'pong' })); });
  });
  await page.goto(`/topology?topology=${topologyId}`);
  await expect(page.locator('.netops-cytoscape')).toBeVisible();
  await expect.poll(() => Boolean(socket)).toBe(true);
  version = 2;
  socket!.send(JSON.stringify({ type: 'event', name: 'topology_updated', data: { workspace_id: workspaceId, topology_id: topologyId, version } }));
  await page.locator('.canvas-search-wrap input').first().fill('服务端新增节点');
  await expect(page.locator('.canvas-search-results button').first()).toContainText('服务端新增节点');
  const updatedReads = reads;
  socket!.send(JSON.stringify({ type: 'event', name: 'topology_updated', data: { workspace_id: workspaceId, topology_id: topologyId, version } }));
  await page.waitForTimeout(100);
  expect(reads).toBe(updatedReads);
});
