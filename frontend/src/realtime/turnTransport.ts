import { agentApi, jobsApi, sessionsApi, runtimeAuditApi } from "../api";
import { ensureLocalBrowserToken, getApiAccessToken, realtimeEndpoint } from "../api/client";
import { useSessionStore } from "../stores/session";
import { useWorkbenchStore, type ChatMsg } from "../stores/workbench";
import type { AgentResult, CognitiveEvent, CognitiveSummary, InlineToolCall, RuntimeEvent, ToolCallResult } from "../types";
import { isApiError } from "../types";
import { beginModelStep, canFallbackToHttp, finalizeStreamText, runningIdempotentRedirectJobId } from "../utils/agentStream";
import { notifyRunCompleted } from "../utils/appEvents";
import { filterStreamingThink, sanitizeAssistantText, toolLabel, type ThinkFilterState } from "../utils/displayText";
import { claimJobCancellation, releaseJobCancellation } from "../utils/jobCancellation";
import { normalizeStageOutputs } from "../utils/stageOutputs";
import { createStreamActivityWatchdog, STREAM_IDLE_TIMEOUT_MS } from "../utils/streamActivity";
import { createStreamRenderCoordinator } from "../utils/streamCoordinator";
import { nextStreamRevealLength } from "../utils/streamReveal";
import { decideStreamFrame } from "../utils/streamSequence";
import { progressPatchForStreamStage, stageElapsedSince } from "../utils/streamStage";
import { agentResultFromWsDone } from "../utils/wsResult";

export type ChatStreamAttachment = {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  kind: "image" | "file";
  previewUrl?: string;
};

export type ChatStreamCallbacks = {
  onSessionResolved: (sessionId: string) => void;
  onResult?: (result: AgentResult, scratchSessionId: string) => void;
  onInterruption?: (message: string) => void;
};

export type ChatStreamParams = {
  workspaceId: string | null;
  sessionId: string | null;
  llmHealth: { visionSupported?: boolean };
};

const WS_TIMEOUT_MS = 10_000;

type Subscriber = {
  getParams: () => ChatStreamParams;
  getCallbacks: () => ChatStreamCallbacks;
};

type TopologyListener = (data: { workspace_id?: string; topology_id?: string; version?: number }) => void;

type LiveTurn = {
  sessionId: string;
  clientRequestId: string;
  workspaceId: string;
  scratch: string;
  streamingMsgId: string;
  userMessageId: string;
  cursor: number;
  terminal: boolean;
  handle: (msg: Record<string, unknown>) => void;
  finish: () => void;
  stopRequested: boolean;
};

const subscribers = new Set<Subscriber>();
const topologyListeners = new Set<TopologyListener>();
const resumedListeners = new Set<() => void>();
const turns = new Map<string, LiveTurn>();
const cancellationClaims = new Set<string>();

let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
let workspaceId = "";
let opening = false;
let generation = 0;
let subscriptionEnabled = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;
let retryDelay = 250;


export function subscribeTurn(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function onTopologyUpdated(listener: TopologyListener): () => void {
  topologyListeners.add(listener);
  return () => topologyListeners.delete(listener);
}

export function onTransportResumed(listener: () => void): () => void {
  resumedListeners.add(listener);
  return () => resumedListeners.delete(listener);
}

export function disconnectTurnTransport(): void {
  subscriptionEnabled = false;
  generation += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconnectTimer = null;
  reconciliationTimer = null;
  connecting = null;
  opening = false;
  reconciling = false;
  const previous = socket;
  socket = null;
  if (previous) {
    previous.onclose = null;
    previous.onmessage = null;
    try { previous.close(); } catch { /* detached already */ }
  }
  for (const turn of turns.values()) {
    turn.finish();
    useWorkbenchStore.getState().endTurn(turn.sessionId, turn.clientRequestId);
  }
  turns.clear();
  cancellationClaims.clear();
  workspaceId = "";
}

export function resetTurnTransport(): void {
  disconnectTurnTransport();
  subscribers.clear();
  topologyListeners.clear();
  resumedListeners.clear();
}

function emitCallbacks(sessionId: string, fn: (callbacks: ChatStreamCallbacks) => void): void {
  for (const subscriber of subscribers) {
    const params = subscriber.getParams();
    if (params.sessionId && params.sessionId !== sessionId) continue;
    fn(subscriber.getCallbacks());
  }
}

export async function ensureTurnSocket(nextWorkspaceId: string): Promise<WebSocket> {
  if (workspaceId && workspaceId !== nextWorkspaceId) disconnectTurnTransport();
  workspaceId = nextWorkspaceId;
  subscriptionEnabled = true;
  if (!reconciliationTimer) reconciliationTimer = setInterval(() => { void reconcileFinishedTurns(); }, 2500);
  if (socket && socket.readyState === WebSocket.OPEN && !connecting) return socket;
  if (connecting) return connecting;
  const epoch = generation;
  const attempt = openSocket(nextWorkspaceId, epoch);
  connecting = attempt;
  try {
    const connected = await attempt;
    if (epoch !== generation) throw new Error("transport_detached");
    retryDelay = 250;
    return connected;
  } finally {
    if (connecting === attempt) { connecting = null; opening = false; }
  }
}

function scheduleReconnect(): void {
  if (!subscriptionEnabled || !workspaceId || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnectOpenTurns();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 5000);
}

function openSocket(nextWorkspaceId: string, epoch: number): Promise<WebSocket> {
  opening = true;
  return new Promise((resolve, reject) => {
    const next = new WebSocket(realtimeEndpoint("/ws/agent"));
    socket = next;
    const timer = window.setTimeout(() => {
      try { next.close(); } catch { /* noop */ }
      reject(new Error("ws_timeout"));
    }, WS_TIMEOUT_MS);
    next.onmessage = (event) => {
      if (epoch === generation && socket === next) onSocketMessage(event);
    };
    next.onopen = () => {
      void authFrame().then((auth) => {
        if (epoch !== generation || socket !== next || !subscriptionEnabled) {
          next.close();
          throw new Error("transport_detached");
        }
        // The subscription authentication precedes every message/resume.
        next.send(JSON.stringify({ type: "ping", workspace_id: nextWorkspaceId, ...auth }));
        window.clearTimeout(timer);
        opening = false;
        resolve(next);
      }).catch((error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
        next.close();
      });
    };
    next.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("ws_error"));
    };
    next.onclose = () => {
      window.clearTimeout(timer);
      reject(new Error("ws_closed"));
      if (epoch !== generation || socket !== next) return;
      socket = null;
      opening = false;
      scheduleReconnect();
    };
  });
}

async function authFrame(): Promise<Record<string, string>> {
  return {
    auth_token: getApiAccessToken(),
    local_token: await ensureLocalBrowserToken(),
  };
}

function onSocketMessage(event: MessageEvent): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(event.data)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg.type === "pong") return;
  if (msg.type === "event" && msg.name === "heartbeat" && !msg.client_request_id) {
    for (const turn of turns.values()) turn.handle(msg);
    return;
  }
  if (msg.type === "event" && msg.name === "topology_updated") {
    const data = (msg.data && typeof msg.data === "object" ? msg.data : {}) as TopologyListener extends (arg: infer T) => void ? T : never;
    for (const listener of topologyListeners) listener(data);
    return;
  }
  if (msg.type === "event" && msg.name === "job_updated") return;
  if (msg.type === "event" && msg.name === "turn_frame" && msg.data && typeof msg.data === "object") {
    msg = msg.data as Record<string, unknown>;
  }
  const data = msg.data && typeof msg.data === "object" ? msg.data as Record<string, unknown> : {};
  const requestId = String(msg.client_request_id || data.client_request_id || "");
  const sessionId = String(msg.session_id || data.session_id || "");
  const frameWorkspace = String(msg.workspace_id || data.workspace_id || "");
  const turn = requestId ? turns.get(requestId) : undefined;
  if (!turn || turn.workspaceId !== workspaceId) return;
  if (sessionId && sessionId !== turn.sessionId) return;
  if (frameWorkspace && frameWorkspace !== turn.workspaceId) return;
  turn.handle(msg);
}

async function reconnectOpenTurns(): Promise<void> {
  if (!subscriptionEnabled || !workspaceId || opening) return;
  const epoch = generation;
  try {
    const next = await ensureTurnSocket(workspaceId);
    const auth = await authFrame();
    if (epoch !== generation) return;
    for (const turn of turns.values()) {
      if (turn.terminal) continue;
      next.send(JSON.stringify({
        type: "resume", workspace_id: turn.workspaceId, session_id: turn.sessionId,
        client_request_id: turn.clientRequestId, stream_seq: turn.cursor, ...auth,
      }));
    }
    for (const listener of resumedListeners) listener();
  } catch {
    if (epoch === generation) scheduleReconnect();
  }
}

async function reconcileFinishedTurns(): Promise<void> {
  if (reconciling || !subscriptionEnabled || !workspaceId || !turns.size) return;
  const epoch = generation;
  reconciling = true;
  try {
    const response = await jobsApi.list(workspaceId);
    if (epoch !== generation) return;
    for (const turn of [...turns.values()]) {
      const active = response.jobs.find((job) => job.metadata?.active_turn?.client_request_id === turn.clientRequestId)?.metadata?.active_turn;
      if (!active || !["succeeded", "failed", "cancelled"].includes(active.status || "")) continue;
      const history = await sessionsApi.messages(turn.sessionId, turn.workspaceId);
      if (epoch !== generation || turn.terminal) return;
      const terminal = [...history.messages].reverse().find((message) => message.role === "assistant"
        && (message.metadata?.client_request_id === turn.clientRequestId || (active.run_id && message.run_id === active.run_id)));
      if (!terminal) continue; // Job completion may precede durable message persistence.
      let detail: Partial<AgentResult> | null = null;
      if (active.run_id) {
        const [record, trace] = await Promise.allSettled([
          runtimeAuditApi.run(turn.workspaceId, active.run_id), runtimeAuditApi.trace(turn.workspaceId, active.run_id),
        ]);
        if (epoch !== generation || turn.terminal) return;
        if (record.status === "fulfilled" && record.value && typeof record.value === "object") {
          const data = record.value as Record<string, unknown>;
          detail = {
            final_response: String(data.final_response_summary || ""),
            tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls as ToolCallResult[] : [],
            events: trace.status === "fulfilled" ? trace.value.events || [] : active.events || [],
            metadata: (data.metadata || terminal.metadata || {}) as AgentResult["metadata"],
            errors: Array.isArray(data.errors) ? data.errors as string[] : active.error ? [active.error] : [],
          };
        }
      }
      if (epoch !== generation || turn.terminal) return;
      turn.handle({ ...(detail || {}), type: "done", session_id: turn.sessionId, client_request_id: turn.clientRequestId,
        final_response: detail?.final_response || terminal.content, turn_id: terminal.run_id || active.run_id, trace_id: terminal.trace_id || active.trace_id,
        events: detail?.events || active.events || [], tool_calls: detail?.tool_calls || [],
        metadata: detail?.metadata || terminal.metadata || {}, errors: detail?.errors || (active.error ? [active.error] : []),
      });
      for (const listener of resumedListeners) listener();
    }
  } catch { /* A failed read leaves the ongoing turn untouched. */ }
  finally { if (epoch === generation) reconciling = false; }
}

function requestCancel(jobId: string, turnWorkspaceId: string, clientRequestId: string): void {
  const claim = claimJobCancellation(cancellationClaims, turnWorkspaceId, jobId, clientRequestId);
  if (!claim) return;
  void jobsApi.cancel(jobId, turnWorkspaceId, clientRequestId).catch(() => {
    releaseJobCancellation(cancellationClaims, claim);
  });
}

export function stopTurn(sessionId: string | null): void {
  if (!sessionId) return;
  const store = useWorkbenchStore.getState();
  const requestId = store.activeTurns[sessionId];
  const turn = requestId ? turns.get(requestId) : undefined;
  if (turn) turn.stopRequested = true;
  const messages = store.bySession[sessionId] || [];
  const activeJobId = [...messages].reverse().find(
    (message) => message.role === "assistant" && message.status === "streaming" && message.activeJobId,
  )?.activeJobId;
  const currentWorkspace = workspaceId;
  const epoch = generation;
  if (activeJobId && currentWorkspace) {
    requestCancel(activeJobId, currentWorkspace, requestId || "");
    return;
  }
  if (currentWorkspace && requestId) {
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (epoch !== generation) return;
        const current = turns.get(requestId);
        if (current && !current.stopRequested) return;
        try {
          const jobs = await jobsApi.list(currentWorkspace);
          if (epoch !== generation) return;
          const job = (jobs.jobs || []).find((item) =>
            item.status === "running"
            && item.metadata?.active_turn?.client_request_id === requestId,
          );
          if (job?.job_id) {
            requestCancel(job.job_id, currentWorkspace, requestId);
            return;
          }
        } catch { /* durable job state remains authoritative */ }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    })();
  }
}

export async function sendTurn(args: {
  text: string;
  attachments: ChatStreamAttachment[];
  effectiveSessionId: string | null;
  turnMetadata?: Record<string, unknown>;
}, params: ChatStreamParams): Promise<void> {
  const workspace = params.workspaceId;
  if (!workspace) return;
  const effectiveSessionId = args.effectiveSessionId ?? params.sessionId;
  if (!effectiveSessionId) return;
  if (workspaceId && workspaceId !== workspace) disconnectTurnTransport();
  const epoch = generation;
  const store = useWorkbenchStore.getState();
  if (store.activeTurns?.[effectiveSessionId]) return;
  const hasImages = args.attachments.some((item) => item.mime_type.startsWith("image/"));
  if (hasImages && params.llmHealth.visionSupported === false) return;

  const clientRequestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const turnMetadata: Record<string, unknown> = { ...(args.turnMetadata || {}), client_request_id: clientRequestId };
  const selectedSkill = turnMetadata.workbench_selection && typeof turnMetadata.workbench_selection === "object"
    ? turnMetadata.workbench_selection as { skill_id?: unknown; skill_name?: unknown }
    : undefined;
  const skillSnapshot = selectedSkill && typeof selectedSkill.skill_id === "string" && typeof selectedSkill.skill_name === "string"
    ? { skill_id: selectedSkill.skill_id, name: selectedSkill.skill_name }
    : undefined;
  const userMessageId = store.appendUser(
    args.text, effectiveSessionId,
    args.attachments.length ? args.attachments : undefined,
    clientRequestId, skillSnapshot,
  );
  const streamingMsgId = store.appendAssistantStreaming(effectiveSessionId, clientRequestId);
  store.beginTurn(effectiveSessionId, clientRequestId);

  let submitted = false;
  try {
    let current: WebSocket;
    try {
      current = await ensureTurnSocket(workspace);
    } catch (firstError) {
      try {
        current = await ensureTurnSocket(workspace);
      } catch {
        throw firstError;
      }
    }
    const auth = await authFrame();
    if (epoch !== generation) return;
    // Install the reducer before sending, so even an immediate response is routed.
    const completed = runTurn({
      clientRequestId, effectiveSessionId, streamingMsgId, userMessageId,
      workspaceId: workspace, activeSessionId: params.sessionId || "",
    });
    submitted = true;
    try {
      current.send(JSON.stringify({
        type: "message", user_input: args.text, session_id: effectiveSessionId,
        workspace_id: workspace, metadata: turnMetadata, ...auth,
      }));
    } catch {
      void reconnectOpenTurns(); // Resume the accepted identity; never re-execute.
    }
    await completed;
  } catch {
    if (epoch !== generation) return;
    if (!canFallbackToHttp(submitted)) {
      const interruption = "实时连接在请求提交后中断；为避免重复执行，未自动重放。可等待会话任务恢复或手动重试。";
      useWorkbenchStore.getState().updateAssistant(streamingMsgId, {
        status: "error", text: interruption, error: interruption,
      }, effectiveSessionId);
      emitCallbacks(effectiveSessionId, (callbacks) => callbacks.onInterruption?.(interruption));
      return;
    }
    await runHttpFallback({
      text: args.text, workspaceId: workspace, effectiveSessionId,
      activeSessionId: params.sessionId, streamingMsgId, userMessageId, turnMetadata, scratch: effectiveSessionId,
    });
  } finally {
    if (epoch === generation) {
      turns.delete(clientRequestId);
      useWorkbenchStore.getState().endTurn(effectiveSessionId, clientRequestId);
    }
  }
}

async function runTurn(input: {
  clientRequestId: string;
  effectiveSessionId: string;
  streamingMsgId: string;
  userMessageId: string;
  workspaceId: string;
  activeSessionId: string;
  recovered?: ChatMsg;
}): Promise<void> {
  const epoch = generation;
  const tokenBuffer = { pending: "" };
  const thinkFilter: { mode: ThinkFilterState; pending?: string } = { ...(input.recovered?.streamFilterState || { mode: "idle" }) };
  let streamState = { draft: input.recovered?.streamDraft ?? input.recovered?.text ?? "" };
  let streamedText = streamState.draft;
  let resolvedSid = input.activeSessionId || input.effectiveSessionId;
  let stageStartedAt: number | null = null;
  let terminalFrameReceived = false;
  let lastStreamSequence = input.recovered?.streamSeq || 0;
  let interruptionReason = "";
  const streamClockNow = () => performance.now();
  const turnStartedAt = streamClockNow();
  const streamingResult: {
    session_id?: string;
    turn_id?: string;
    trace_id?: string;
    events?: AgentResult["events"];
    tool_calls_count?: number;
    tool_calls?: ToolCallResult[];
    metadata?: AgentResult["metadata"];
    errors?: string[];
    warnings?: string[];
    tool_decision?: AgentResult["tool_decision"];
    no_tool_reason?: string;
  } = { events: input.recovered?.runtimeEvents || [], metadata: input.recovered?.result?.metadata };

  await new Promise<void>((resolve) => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let pendingStartedAt: number | null = null;
    let lastRevealAt = performance.now();
    const scratch = input.effectiveSessionId;
    const flushTokenBuffer = (force = false) => {
      if (epoch !== generation) return;
      if (!tokenBuffer.pending) {
        if (lastStreamSequence > 0) {
          useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { streamSeq: lastStreamSequence, streamFilterState: { ...thinkFilter } }, scratch);
        }
        return;
      }
      const now = performance.now();
      if (pendingStartedAt === null) pendingStartedAt = now;
      const visibleLength = nextStreamRevealLength(
        tokenBuffer.pending.length, now - lastRevealAt, now - pendingStartedAt, { force, reducedMotion },
      );
      streamState.draft += tokenBuffer.pending.slice(0, visibleLength);
      streamedText = streamState.draft;
      tokenBuffer.pending = tokenBuffer.pending.slice(visibleLength);
      if (!tokenBuffer.pending) pendingStartedAt = null;
      lastRevealAt = now;
      streamRender.markText(streamedText);
      if (!tokenBuffer.pending) {
        useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
          text: streamedText,
          streamDraft: streamedText,
          streamSeq: lastStreamSequence,
          streamFilterState: { ...thinkFilter },
        }, scratch);
      }
    };
    const streamRender = createStreamRenderCoordinator({
      commit: (patch) => {
        if (epoch !== generation) return;
        useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
          ...patch,
          streamSeq: lastStreamSequence,
          streamDraft: streamState.draft + tokenBuffer.pending,
          streamFilterState: { ...thinkFilter },
        }, scratch);
      },
      onFrame: () => {
        if (!tokenBuffer.pending) return false;
        flushTokenBuffer();
        return Boolean(tokenBuffer.pending);
      },
    });
    const flushAllTokenBuffer = () => {
      flushTokenBuffer(true);
      streamRender.flush();
    };
    const archiveModelOutput = () => {
      flushAllTokenBuffer();
      const currentStore = useWorkbenchStore.getState();
      const current = currentStore.bySession[scratch]?.find((item) => item.id === input.streamingMsgId);
      if (streamState.draft.trim()) {
        const stages = current?.stageOutputs || [];
        currentStore.updateAssistant(input.streamingMsgId, {
          stageOutputs: [...stages, {
            id: `model-${stages.length + 1}`,
            label: `模型输出 ${stages.length + 1}`,
            text: streamState.draft,
          }],
          streamSeq: lastStreamSequence,
        }, scratch);
      }
      streamState = beginModelStep();
      streamedText = "";
      thinkFilter.mode = "idle";
      thinkFilter.pending = "";
      currentStore.updateAssistant(input.streamingMsgId, { text: "", streamDraft: "", streamSeq: lastStreamSequence, streamFilterState: { ...thinkFilter } }, scratch);
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      watchdog.stop();
      flushAllTokenBuffer();
      streamRender.cancel();
      resolve();
    };
    const createWatchdog = () => createStreamActivityWatchdog({
      now: streamClockNow,
      onTick: () => {
        streamRender.setElapsed(streamClockNow() - turnStartedAt, stageElapsedSince(stageStartedAt, streamClockNow()) ?? 0);
      },
      onTimeout: () => {
        if (epoch !== generation) return;
        interruptionReason = `实时连接已超过 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有收到服务器消息，正在恢复连接…`;
        useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { progressText: interruptionReason }, scratch);
        if (socket) socket.close();
        else scheduleReconnect();
        watchdog = createWatchdog();
      },
    });
    let watchdog = createWatchdog();
    if (!input.recovered) useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { progressText: "等待 SSOT Runtime 调度…" }, scratch);
    const turn: LiveTurn = {
      sessionId: input.effectiveSessionId,
      clientRequestId: input.clientRequestId,
      workspaceId: input.workspaceId,
      scratch,
      streamingMsgId: input.streamingMsgId,
      userMessageId: input.userMessageId,
      cursor: lastStreamSequence,
      terminal: false,
      stopRequested: false,
      finish,
      handle: (msg) => {
        if (epoch !== generation) return;
        watchdog.touch();
        const redirect = (msg.metadata as { idempotent_redirect?: { job_id?: string; status?: string; client_request_id?: string } } | undefined)?.idempotent_redirect;
        if (msg.type === "done" && redirect?.job_id && ["running", "conflict"].includes(redirect.status || "")
            && !(Array.isArray(msg.errors) && msg.errors.includes("client_request_payload_mismatch"))) {
          const targetId = redirect.client_request_id || input.clientRequestId;
          if (targetId !== input.clientRequestId) {
            turns.delete(input.clientRequestId);
            useWorkbenchStore.getState().endTurn(scratch, input.clientRequestId);
            if (input.userMessageId) useWorkbenchStore.getState().discardMessages([input.userMessageId], scratch);
            input.clientRequestId = targetId;
            turn.clientRequestId = targetId;
            turn.cursor = 0;
            lastStreamSequence = 0;
            useWorkbenchStore.getState().beginTurn(scratch, targetId);
            turns.set(targetId, turn);
          }
          useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { activeJobId: redirect.job_id, client_request_id: targetId }, scratch);
          void authFrame().then((auth) => {
            if (epoch === generation && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: "resume", workspace_id: turn.workspaceId, session_id: turn.sessionId,
              client_request_id: targetId, stream_seq: turn.cursor, ...auth,
            }));
          });
          return;
        }
        const sequenceDecision = decideStreamFrame(msg, lastStreamSequence, terminalFrameReceived);
        if (!sequenceDecision.accept) {
          const sequence = Number(msg.seq ?? msg.stream_seq);
          if (!terminalFrameReceived && Number.isSafeInteger(sequence) && sequence > lastStreamSequence + 1) socket?.close();
          return;
        }
        if (msg.type !== "token") flushAllTokenBuffer();
        lastStreamSequence = sequenceDecision.nextSequence;
        turn.cursor = lastStreamSequence;
        switch (msg.type) {
          case "token": {
            const visible = filterStreamingThink(String(msg.content || ""), thinkFilter);
            if (visible) {
              if (!tokenBuffer.pending) pendingStartedAt = performance.now();
              tokenBuffer.pending += visible;
              streamRender.request();
            }
            break;
          }
          case "event": {
            const data = msg.data && typeof msg.data === "object" ? msg.data as Record<string, unknown> : undefined;
            const stageName = String(msg.name || "");
            if (data && stageName !== "heartbeat") {
              streamingResult.events = [...(streamingResult.events || []), { ...data, event_id: String(data.event_id || `live-${input.clientRequestId}-${lastStreamSequence}`), event_type: String(data.event_type || data.type || stageName) } as RuntimeEvent];
            }
            if (stageName.startsWith("cognitive_") && data) {
              const rawPayload = data.payload;
              const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, unknown> : {};
              const previous: CognitiveSummary = streamingResult.metadata?.cognitive ?? {};
              const nextSummary: CognitiveSummary = {
                ...previous,
                revision: Number(data.state_revision ?? previous.revision ?? 0) || previous.revision,
                ...(typeof payload.goal === "string" ? { goal: payload.goal } : {}),
                ...(typeof payload.outcome === "string" ? { outcome: payload.outcome } : {}),
                ...(typeof payload.visible_summary === "string" ? { visible_summary: payload.visible_summary } : {}),
              };
              const priorEvents = streamingResult.metadata?.cognitive_events ?? [];
              const cognitiveEvent: CognitiveEvent = { ...data, event_id: String(data.event_id || `cognitive-${lastStreamSequence}`), type: String(data.type || stageName) };
              streamingResult.metadata = {
                ...(streamingResult.metadata ?? {}),
                cognitive: nextSummary,
                cognitive_events: priorEvents.some((item) => item.event_id === cognitiveEvent.event_id)
                  ? priorEvents
                  : [...priorEvents, cognitiveEvent],
              };
            }
            if (data && stageName !== "heartbeat") {
              const storeState = useWorkbenchStore.getState();
              const currentMessage = storeState.bySession[scratch]?.find((item) => item.id === input.streamingMsgId);
              const runtimeEvent = {
                ...data,
                event_id: String(data.event_id || `live-${input.clientRequestId}-${msg.seq || Date.now()}`),
                event_type: String(data.event_type || data.type || stageName),
                type: String(data.type || stageName),
              };
              storeState.updateAssistant(input.streamingMsgId, {
                runtimeEvents: [...(currentMessage?.runtimeEvents || []), runtimeEvent],
                activeJobId: String(data.job_id || currentMessage?.activeJobId || "") || undefined,
                streamSeq: lastStreamSequence,
              }, scratch);
            }
            if (stageName === "model_started") archiveModelOutput();
            const progressPatch = progressPatchForStreamStage(stageName, data);
            if (progressPatch) {
              const stageNow = streamClockNow();
              stageStartedAt = stageNow;
              useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
                progressText: progressPatch.progressText,
                progressElapsedMs: Math.max(0, stageNow - turnStartedAt),
                stageElapsedMs: 0,
                streamSeq: lastStreamSequence,
              }, scratch);
            }
            if (turn.stopRequested && data?.job_id) requestCancel(String(data.job_id), input.workspaceId, input.clientRequestId);
            if (stageName === "tool_call" || stageName === "tool_result") {
              streamingResult.tool_calls_count = (streamingResult.tool_calls_count || 0) + 1;
              const tid = String(data?.tool_id || data?.name || "");
              const callId = String(data?.call_id || data?.node_id || tid || "");
              if (tid && callId) {
                const storeState = useWorkbenchStore.getState();
                const curr = storeState.bySession[scratch]?.find((item) => item.id === input.streamingMsgId);
                const prevCalls = (curr?.toolCalls || []) as InlineToolCall[];
                if (stageName === "tool_result") {
                  const ok = Boolean(data?.ok ?? data?.status === "ok");
                  storeState.updateAssistant(input.streamingMsgId, {
                    toolCalls: prevCalls.map((item) => item.call_id === callId ? { ...item, status: ok ? "done" : "fail", ok, summary: String(data?.summary || "") } : item),
                    streamSeq: lastStreamSequence,
                  }, scratch);
                } else if (!prevCalls.find((item) => item.call_id === callId)) {
                  storeState.updateAssistant(input.streamingMsgId, {
                    toolCalls: [...prevCalls, { call_id: callId, tool_id: tid, tool_name: toolLabel(tid), ok: false, status: "running" }],
                    streamSeq: lastStreamSequence,
                  }, scratch);
                }
              }
            }
            if (stageName === "tool_call") archiveModelOutput();
            useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { streamSeq: lastStreamSequence, streamFilterState: { ...thinkFilter } }, scratch);
            break;
          }
          case "done": {
            terminalFrameReceived = true;
            turn.terminal = true;
            flushAllTokenBuffer();
            resolvedSid = String(msg.session_id || input.activeSessionId || input.effectiveSessionId);
            streamedText = finalizeStreamText(streamState.draft, String(msg.final_response || ""));
            streamingResult.session_id = String(msg.session_id || "");
            streamingResult.turn_id = String(msg.turn_id || "");
            streamingResult.trace_id = String(msg.trace_id || "");
            streamingResult.events = (msg.events as AgentResult["events"]) || streamingResult.events || [];
            streamingResult.tool_calls_count = Number(msg.tool_calls_count || streamingResult.tool_calls_count || 0);
            streamingResult.tool_calls = (msg.tool_calls as ToolCallResult[]) || [];
            streamingResult.metadata = { ...(streamingResult.metadata ?? {}), ...((msg.metadata as AgentResult["metadata"]) || {}) };
            streamingResult.errors = (msg.errors as string[]) || [];
            streamingResult.warnings = (msg.warnings as string[]) || [];
            streamingResult.tool_decision = msg.tool_decision as AgentResult["tool_decision"];
            streamingResult.no_tool_reason = String(msg.no_tool_reason || "");
            useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { progressText: "", streamSeq: lastStreamSequence }, scratch);
            finish();
            break;
          }
          case "error": {
            terminalFrameReceived = true;
            turn.terminal = true;
            streamingResult.errors = [String(msg.message || msg.error || "Unknown error")];
            useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, { progressText: "", streamSeq: lastStreamSequence }, scratch);
            finish();
            break;
          }
          default:
            break;
        }
      },
    };
    turns.set(input.clientRequestId, turn);

  });

  if (epoch !== generation) return;
  turns.delete(input.clientRequestId);
  useWorkbenchStore.getState().endTurn(input.effectiveSessionId, input.clientRequestId);
  const scratch = input.effectiveSessionId;
  if (!terminalFrameReceived) {
    const interruption = interruptionReason || "实时连接已中断，未收到本轮完成消息。请重试。";
    streamingResult.errors = [interruption];
    if (!streamedText.trim()) streamedText = interruption;
    emitCallbacks(scratch, (callbacks) => callbacks.onInterruption?.(interruption));
  } else if (streamingResult.errors?.length && !streamedText.trim()) {
    streamedText = streamingResult.errors[0];
  }
  if (!input.activeSessionId && resolvedSid) {
    useWorkbenchStore.getState().moveSessionMessages(scratch, resolvedSid);
    useSessionStore.getState().setCurrentSession(resolvedSid);
    useWorkbenchStore.getState().switchSession(resolvedSid);
    emitCallbacks(resolvedSid, (callbacks) => callbacks.onSessionResolved(resolvedSid));
  }
  const wsResult = agentResultFromWsDone(streamingResult, streamedText, resolvedSid);
  const cleanText = sanitizeAssistantText(wsResult.final_response);
  const cleanResult = { ...wsResult, final_response: sanitizeAssistantText(wsResult.final_response ?? "") };
  const trackingSummary = cleanResult.metadata?.tracking_summary;
  const trackingPending = Boolean(trackingSummary?.task_id && !(trackingSummary.done || trackingSummary.terminal));
  const toolCalls: InlineToolCall[] = (cleanResult.tool_calls ?? []).map((tc) => ({
    call_id: tc.call_id,
    tool_id: tc.tool_id,
    tool_name: toolLabel(tc.tool_id),
    ok: tc.ok,
    status: trackingPending && tc.ok ? "pending" : tc.ok ? "done" : "fail",
    summary: tc.summary,
    duration_ms: tc.duration_ms ?? undefined,
    errors: tc.errors,
    artifacts: tc.artifacts as InlineToolCall["artifacts"],
    orchestration: (tc.metadata?.orchestration || undefined) as InlineToolCall["orchestration"],
  }));
  useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
    status: wsResult.errors?.length ? "error" : "ready",
    text: cleanText,
    result: cleanResult,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    error: wsResult.errors?.[0],
    trace_id: wsResult.trace_id,
    run_id: wsResult.turn_id,
    runtimeEvents: cleanResult.events || [],
    streamSeq: lastStreamSequence,
    ...(cleanResult.metadata.stage_outputs ? { stageOutputs: normalizeStageOutputs(cleanResult.metadata.stage_outputs) } : {}),
  }, resolvedSid);
  queueMicrotask(() => {
    if (epoch !== generation) return;
    useWorkbenchStore.getState().setLatestResult(wsResult, resolvedSid);
    notifyRunCompleted();
    emitCallbacks(resolvedSid, (callbacks) => callbacks.onResult?.(wsResult, scratch));
  });
  if (resolvedSid && input.workspaceId) {
    sessionsApi.messages(resolvedSid, input.workspaceId)
      .then((response) => { if (epoch === generation && response.messages?.length) useWorkbenchStore.getState().mergeFromBackend(resolvedSid, response.messages); })
      .catch(() => {});
  }
}

async function runHttpFallback(input: {
  text: string;
  workspaceId: string;
  effectiveSessionId: string;
  activeSessionId: string | null;
  streamingMsgId: string;
  userMessageId: string;
  turnMetadata: Record<string, unknown>;
  scratch: string;
}): Promise<void> {
  const epoch = generation;
  try {
    const res = await agentApi.run({
      message: input.text,
      workspace_id: input.workspaceId,
      session_id: input.effectiveSessionId,
      metadata: input.turnMetadata,
    });
    if (epoch !== generation) return;
    const redirectJobId = runningIdempotentRedirectJobId(res.metadata);
    if (redirectJobId && !res.errors?.includes("client_request_payload_mismatch")) {
      const response = await jobsApi.get(redirectJobId, input.workspaceId);
      if (epoch !== generation) return;
      const requestId = response.job.metadata?.active_turn?.client_request_id;
      if (!requestId) throw new Error("既有回合的请求标识暂不可用，请等待其完成后刷新会话。");
      const live = useWorkbenchStore.getState();
      live.discardMessages([input.userMessageId], input.effectiveSessionId);
      live.endTurn(input.effectiveSessionId, String(input.turnMetadata.client_request_id || ""));
      live.updateAssistant(input.streamingMsgId, { client_request_id: requestId, activeJobId: redirectJobId, status: "streaming" }, input.effectiveSessionId);
      live.beginTurn(input.effectiveSessionId, requestId);
      const recovered = live.bySession[input.effectiveSessionId]?.find((message) => message.id === input.streamingMsgId);
      const completed = runTurn({ clientRequestId: requestId, effectiveSessionId: input.effectiveSessionId,
        streamingMsgId: input.streamingMsgId, userMessageId: "", workspaceId: input.workspaceId,
        activeSessionId: input.effectiveSessionId, recovered,
      });
      void reconnectOpenTurns();
      await completed;
      return;
    }
    const resolvedSid = (res.session_id && res.session_id !== "—" ? res.session_id : input.activeSessionId) ?? undefined;
    if (!input.activeSessionId && resolvedSid) {
      useWorkbenchStore.getState().moveSessionMessages(input.scratch, resolvedSid);
      useSessionStore.getState().setCurrentSession(resolvedSid);
      useWorkbenchStore.getState().switchSession(resolvedSid);
      emitCallbacks(resolvedSid, (callbacks) => callbacks.onSessionResolved(resolvedSid));
    }
    useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
      status: res.ok ? "ready" : "error",
      text: sanitizeAssistantText(res.final_response ?? ""),
      result: res,
      error: !res.ok ? res.errors?.[0] : undefined,
      trace_id: res.trace_id,
      run_id: res.turn_id,
      runtimeEvents: res.events || [],
      toolCalls: (res.tool_calls || []).map((call) => ({ ...call, tool_name: toolLabel(call.tool_id), status: call.ok ? "done" as const : "fail" as const, duration_ms: call.duration_ms ?? undefined })),
      stageOutputs: normalizeStageOutputs(res.metadata?.stage_outputs),
    }, resolvedSid);
    useWorkbenchStore.getState().setLatestResult(res, resolvedSid);
    notifyRunCompleted();
    emitCallbacks(resolvedSid || input.scratch, (callbacks) => callbacks.onResult?.(res, input.scratch));
  } catch (err: unknown) {
    if (epoch !== generation) return;
    const message = isApiError(err) ? err.message : String(err);
    const stubResult: AgentResult = {
      ok: false, final_response: sanitizeAssistantText(`(error) ${message}`),
      events: [], trace_id: isApiError(err) ? err.request_id ?? "—" : "—",
      session_id: input.effectiveSessionId, turn_id: `turn-${Date.now()}`,
      tool_calls: [], warnings: [], errors: [message], error_type: "network",
      metadata: { source_count: 0, source_summary: [] },
    };
    useWorkbenchStore.getState().updateAssistant(input.streamingMsgId, {
      status: "error", text: stubResult.final_response, result: stubResult, error: message,
    }, input.effectiveSessionId);
    useWorkbenchStore.getState().setLatestResult(stubResult, input.effectiveSessionId);
    emitCallbacks(input.effectiveSessionId, (callbacks) => callbacks.onResult?.(stubResult, input.scratch));
  }
}

export async function recoverStreamingTurns(nextWorkspaceId: string): Promise<void> {
  if (workspaceId && workspaceId !== nextWorkspaceId) disconnectTurnTransport();
  const epoch = generation;
  const current = await ensureTurnSocket(nextWorkspaceId);
  const auth = await authFrame();
  if (epoch !== generation) return;
  const store = useWorkbenchStore.getState();
  for (const [sessionId, messages] of Object.entries(store.bySession)) {
    const message = [...messages].reverse().find((item) => item.role === "assistant"
      && item.status === "streaming" && item.client_request_id && typeof item.streamSeq === "number");
    if (!message?.client_request_id || turns.has(message.client_request_id)) continue;
    const requestId = message.client_request_id;
    store.beginTurn(sessionId, requestId);
    // Same reducer and finalization path as a newly submitted turn.
    void runTurn({ clientRequestId: requestId, effectiveSessionId: sessionId,
      streamingMsgId: message.id, userMessageId: "", workspaceId: nextWorkspaceId,
      activeSessionId: sessionId, recovered: message,
    }).catch(() => { /* Recovery is retried from the persisted cursor. */ });
    current.send(JSON.stringify({ type: "resume", workspace_id: nextWorkspaceId,
      session_id: sessionId, client_request_id: requestId, stream_seq: message.streamSeq || 0, ...auth,
    }));
  }
}
