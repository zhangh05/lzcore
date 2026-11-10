/** 测试用假 WebSocket：记录发送的帧，测试手动推送服务端帧。不发生任何网络连接。 */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) throw new Error(`bad url ${url}`);
    FakeSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  push(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}

export function installFakeWebSocket() {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return FakeSocket;
}
