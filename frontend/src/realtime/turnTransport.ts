import { currentLocalToken } from "../api/localAuth";
/**
 * /ws/agent 实时通道（规则迁自旧 frontend/src/realtime/turnTransport.ts，实现重写）。
 *
 * - 每个回合有 `client_request_id`（幂等键），随 `metadata.client_request_id` 发送。
 * - 每帧带 `seq` / `stream_seq`；按回合记 cursor，重复帧丢弃。
 * - 断线后**只发 `resume`**（传输日志续传），绝不自动重发 `message`（不重放执行）。
 * - 2.5 秒回读兜底：通道不可用期间，定时回读会话消息；服务端终态优先。
 * - 续接任务（task resume）不是这里的 resume：它是一条新 message，带 `metadata.resume_task_id`。
 */

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => WebSocketLike;

export type Frame = Record<string, unknown> & { type?: string };

export interface TurnHandlers {
  onToken: (text: string) => void;
  onEvent: (name: string, data: Record<string, unknown>) => void;
  onDone: (frame: Frame) => void;
  onError: (frame: Frame) => void;
  /** 通道中断：回合可能仍在服务端执行；界面应显示「连接中断 · 正在续传/回读」，而不是失败。 */
  onTransport: (state: "interrupted" | "resumed" | "readback_terminal") => void;
}

interface LiveTurn {
  clientRequestId: string;
  sessionId: string;
  workspaceId: string;
  cursor: number;
  terminal: boolean;
  /** 续传暂不可用（resume_pending 等控制错误）：回合仍未结束，靠有界重试 resume + 回读等待终态。 */
  held?: boolean;
  /** 收到过属于本回合的帧（服务端已受理）。 */
  acked?: boolean;
  /** 本回合由 sendMessage 发起（首发 message），而不是 resumeTurn 接上。 */
  sentMessage?: boolean;
  resumeRetries?: number;
  handlers: TurnHandlers;
}

export const READBACK_INTERVAL_MS = 2500;
/** 服务端按工作区广播、不带 client_request_id 的事件名。 */
export const BROADCAST_EVENTS = new Set(["topology_updated", "job_updated"]);
/** resume 的控制错误：说明续传暂时接不上，不是回合的执行终态（backend/ws/agent_ws.py _attach_turn_replay）。 */
export const RESUME_CONTROL_ERRORS = new Set(["resume_pending", "replay_interrupted", "resume_not_found", "resume_limit_exceeded"]);
export const RESUME_RETRY_MS = 1500;
export const RESUME_MAX_RETRIES = 40;
const OPEN = 1;

export interface TransportOptions {
  url: string;
  wsFactory?: WsFactory;
  /** 回读：返回 true 表示服务端已有该回合终态。 */
  readback: (sessionId: string, clientRequestId: string) => Promise<boolean>;
  /** 工作区广播（如 topology_updated）：不属于任何回合，不能混进回合事件。 */
  onBroadcast?: (name: string, data: Record<string, unknown>) => void;
  /** 连接鉴权被拒（local_token_required / unauthorized）：刷新凭据。随后的重连会自动续传。 */
  onAuthRejected?: () => Promise<unknown> | void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class TurnTransport {
  private socket: WebSocketLike | null = null;
  private turns = new Map<string, LiveTurn>();
  private reconnectHandle: unknown = null;
  private readbackHandle: unknown = null;
  private closedByUser = false;
  /** 订阅了工作区广播（服务端要求连接先发 ping 注册，重连后要重新注册）。 */
  private broadcastWorkspace: string | null = null;
  private retryDelay = 250;
  readonly sent: Frame[] = [];

  constructor(private opts: TransportOptions) {}

  private factory(): WsFactory {
    return this.opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  private setTimer(fn: () => void, ms: number) { return (this.opts.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms); }
  private clearTimer(h: unknown) { if (h) (this.opts.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h); }

  connected(): boolean { return this.socket?.readyState === OPEN; }

  private ensureSocket(): WebSocketLike {
    if (this.socket && this.socket.readyState <= OPEN) return this.socket;
    const ws = this.factory()(this.opts.url);
    this.socket = ws;
    ws.onopen = () => {
      this.retryDelay = 250;
      this.stopReadback();
      this.registerBroadcasts();
      // 只续传，不重放：对每个未终结的回合发 resume。
      for (const t of this.turns.values()) {
        if (t.terminal) continue;
        this.raw({ type: "resume", workspace_id: t.workspaceId, session_id: t.sessionId, client_request_id: t.clientRequestId, stream_seq: t.cursor });
        t.handlers.onTransport("resumed");
      }
    };
    ws.onmessage = (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(String(ev.data)); } catch { return; }
      this.route(frame);
    };
    ws.onclose = () => {
      if (this.socket === ws) this.socket = null;
      if (this.closedByUser) return;
      const open = [...this.turns.values()].filter((t) => !t.terminal);
      for (const t of open) t.handlers.onTransport("interrupted");
      if (open.length) this.startReadback();
      this.reconnectHandle = this.setTimer(() => { this.reconnectHandle = null; this.ensureSocket(); }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
    ws.onerror = () => { /* onclose 处理 */ };
    return ws;
  }

  private raw(frame: Frame) {
    this.sent.push(frame);
    const ws = this.socket;
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify({ ...frame, ...(currentLocalToken() ? { local_token: currentLocalToken() } : {}) }));
  }

  private route(frame: Frame) {
    if (frame.type === "pong" || (frame.type === "event" && frame.name === "heartbeat")) return;
    const data = (frame.data && typeof frame.data === "object" ? frame.data : {}) as Record<string, unknown>;
    const id = String(frame.client_request_id || data.client_request_id || "");
    if (frame.type === "event" && !id && BROADCAST_EVENTS.has(String(frame.name ?? ""))) {
      // job_updated 是工作区广播：只有 active_turn 的请求 ID 与本地回合一致时才算该回合的事件，绝不按「唯一活动回合」兜底。
      const owner = frame.name === "job_updated" ? String((data.active_turn as Record<string, unknown> | undefined)?.client_request_id ?? "") : "";
      const mine = owner ? this.turns.get(owner) : undefined;
      if (mine && !mine.terminal) mine.handlers.onEvent("job_updated", data);
      else this.opts.onBroadcast?.(String(frame.name), data);
      return;
    }
    if (frame.type === "error" && !id && (frame.message === "local_token_required" || frame.message === "unauthorized")) {
      this.authRejected(String(frame.message));
      return;
    }
    let turn = id ? this.turns.get(id) : undefined;
    if (!turn && !id) {
      const open = [...this.turns.values()].filter((t) => !t.terminal);
      if (open.length === 1) turn = open[0];
    }
    if (!turn || turn.terminal) return;
    const seq = Number(frame.seq ?? frame.stream_seq);
    if (Number.isSafeInteger(seq)) {
      if (seq <= turn.cursor) return; // 重复帧
      turn.cursor = seq;
    }
    turn.acked = true;
    if (frame.type === "token" || frame.type === "event") turn.held = false;
    switch (frame.type) {
      case "token": turn.handlers.onToken(String(frame.content ?? "")); break;
      case "event": turn.handlers.onEvent(String(frame.name ?? ""), data); break;
      case "done": if (!this.followRedirect(turn, frame)) { turn.terminal = true; turn.handlers.onDone(frame); this.turns.delete(turn.clientRequestId); } break;
      case "error": {
        const code = String(frame.error_code || frame.message || "");
        if (RESUME_CONTROL_ERRORS.has(code)) { this.holdTurn(turn, code); break; }
        turn.terminal = true; turn.handlers.onError(frame); this.turns.delete(turn.clientRequestId); break;
      }
      default: break;
    }
  }

  /**
   * 幂等回执：同一请求已在执行（running / conflict）时，服务端回的 done 只是「已受理过」，
   * 不是执行终态。改为跟踪它指向的实际回合，只续传日志，绝不重发 message。
   */
  private followRedirect(turn: LiveTurn, frame: Frame): boolean {
    const meta = (frame.metadata && typeof frame.metadata === "object" ? frame.metadata : {}) as Record<string, unknown>;
    const redirect = meta.idempotent_redirect as { job_id?: string; status?: string; client_request_id?: string } | undefined;
    if (!redirect || (redirect.status !== "running" && redirect.status !== "conflict")) return false;
    const target = String(redirect.client_request_id || turn.clientRequestId);
    if (redirect.job_id) turn.handlers.onEvent("idempotent_redirect", { job_id: redirect.job_id, client_request_id: target });
    if (target !== turn.clientRequestId) {
      if (this.turns.has(target)) { turn.terminal = true; this.turns.delete(turn.clientRequestId); return true; }
      this.turns.delete(turn.clientRequestId);
      turn.clientRequestId = target;
      this.turns.set(target, turn);
    }
    turn.cursor = 0;
    this.raw({ type: "resume", workspace_id: turn.workspaceId, session_id: turn.sessionId, client_request_id: turn.clientRequestId, stream_seq: 0 });
    return true;
  }

  /**
   * 首帧鉴权失败，服务端随即关闭连接。没被受理过的新消息确定没有执行：如实告诉界面「未发送」，
   * 不自动重发；已受理的回合等重连后续传。
   */
  private authRejected(code: string) {
    for (const t of [...this.turns.values()]) {
      if (t.terminal || t.acked || !t.sentMessage) continue;
      t.terminal = true;
      this.turns.delete(t.clientRequestId);
      t.handlers.onError({ type: "error", message: code, error_code: "not_accepted", client_request_id: t.clientRequestId, not_accepted: true });
    }
    void this.opts.onAuthRejected?.();
  }

  private holdTurn(turn: LiveTurn, code: string) {
    turn.held = true;
    turn.handlers.onTransport("interrupted");
    this.startReadback();
    // 服务端已受理但还没产生首帧：有界地重试续传；其余情况只靠回读等终态。
    if (code !== "resume_pending") return;
    const n = (turn.resumeRetries ?? 0) + 1;
    turn.resumeRetries = n;
    if (n > RESUME_MAX_RETRIES) return;
    this.setTimer(() => {
      if (turn.terminal || !turn.held || this.turns.get(turn.clientRequestId) !== turn || !this.connected()) return;
      this.raw({ type: "resume", workspace_id: turn.workspaceId, session_id: turn.sessionId, client_request_id: turn.clientRequestId, stream_seq: turn.cursor });
    }, RESUME_RETRY_MS);
  }

  private startReadback() {
    if (this.readbackHandle) return;
    const tick = async () => {
      this.readbackHandle = null;
      const open = [...this.turns.values()].filter((t) => !t.terminal && (t.held || !this.connected()));
      if (!open.length) return;
      for (const t of open) {
        try {
          if (await this.opts.readback(t.sessionId, t.clientRequestId)) {
            t.terminal = true;
            this.turns.delete(t.clientRequestId);
            t.handlers.onTransport("readback_terminal");
          }
        } catch { /* 下次再读 */ }
      }
      if ([...this.turns.values()].some((t) => !t.terminal && (t.held || !this.connected()))) this.readbackHandle = this.setTimer(() => void tick(), READBACK_INTERVAL_MS);
    };
    this.readbackHandle = this.setTimer(() => void tick(), READBACK_INTERVAL_MS);
  }

  private stopReadback() { this.clearTimer(this.readbackHandle); this.readbackHandle = null; }

  /** 发送一条新消息（新回合）。返回 client_request_id。 */
  sendMessage(args: { workspaceId: string; sessionId: string; text: string; clientRequestId: string; metadata?: Record<string, unknown>; handlers: TurnHandlers }): string {
    this.closedByUser = false;
    const turn: LiveTurn = { clientRequestId: args.clientRequestId, sessionId: args.sessionId, workspaceId: args.workspaceId, cursor: 0, terminal: false, sentMessage: true, handlers: args.handlers };
    this.turns.set(turn.clientRequestId, turn);
    const frame: Frame = {
      type: "message", user_input: args.text, session_id: args.sessionId, workspace_id: args.workspaceId,
      metadata: { ...(args.metadata ?? {}), client_request_id: args.clientRequestId },
    };
    const ws = this.ensureSocket();
    if (ws.readyState === OPEN) this.raw(frame);
    else {
      const prevOpen = ws.onopen;
      // 首次连接：在 open 时发送 message（这是首发，不是重放）。
      ws.onopen = (ev) => {
        ws.onopen = prevOpen;
        this.registerBroadcasts();
        this.raw(frame);
        this.retryDelay = 250;
        for (const t of this.turns.values()) if (!t.terminal && t.clientRequestId !== turn.clientRequestId) {
          this.raw({ type: "resume", workspace_id: t.workspaceId, session_id: t.sessionId, client_request_id: t.clientRequestId, stream_seq: t.cursor });
        }
        void ev;
      };
    }
    return turn.clientRequestId;
  }

  private registerBroadcasts() {
    if (this.broadcastWorkspace) this.raw({ type: "ping", workspace_id: this.broadcastWorkspace });
  }

  /** 接收该工作区的广播（交给 onBroadcast）。会立即建立连接，断线后自动重连并重新注册。 */
  subscribeBroadcasts(workspaceId: string): void {
    this.broadcastWorkspace = workspaceId;
    this.closedByUser = false;
    const ws = this.ensureSocket();
    if (ws.readyState === OPEN) this.registerBroadcasts();
  }

  /**
   * 接上一个已在服务端执行的回合（例如页面重新挂载后）：只发 resume 从头续传，绝不重发 message。
   */
  resumeTurn(args: { workspaceId: string; sessionId: string; clientRequestId: string; handlers: TurnHandlers }): void {
    if (this.turns.has(args.clientRequestId)) return;
    this.closedByUser = false;
    const turn: LiveTurn = { clientRequestId: args.clientRequestId, sessionId: args.sessionId, workspaceId: args.workspaceId, cursor: 0, terminal: false, handlers: args.handlers };
    this.turns.set(turn.clientRequestId, turn);
    const ws = this.ensureSocket();
    // 未连上时由 onopen 统一对未终结回合发 resume。
    if (ws.readyState === OPEN) this.raw({ type: "resume", workspace_id: turn.workspaceId, session_id: turn.sessionId, client_request_id: turn.clientRequestId, stream_seq: 0 });
  }

  hasOpenTurn(sessionId: string): boolean {
    return [...this.turns.values()].some((t) => t.sessionId === sessionId && !t.terminal);
  }

  close() {
    this.closedByUser = true;
    this.clearTimer(this.reconnectHandle);
    this.stopReadback();
    this.socket?.close();
    this.socket = null;
    this.turns.clear();
  }
}

/** 回合报错的界面文案：鉴权被拒且消息未被受理时说清楚「没有执行，需要重发」。 */
export function turnErrorText(f: Frame): string {
  if (f.not_accepted) return "本地凭据已失效，这条消息没有被服务端受理（没有执行）。凭据已刷新，请重新发送。";
  return `本轮报错：${String(f.message ?? f.error ?? "未知错误")}`;
}

export function wsUrl(path = "/ws/agent"): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
