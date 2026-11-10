/**
 * Page subscription for an application-owned turn transport.
 *
 * The socket, token buffer, timers and terminal commit live in
 * `realtime/turnTransport`. Unmounting a page removes callbacks only.
 * It does not close the socket or clear that session's sending state.
 */

import { useEffect, useRef } from "react";
import {
  sendTurn,
  stopTurn,
  subscribeTurn,
  type ChatStreamAttachment,
  type ChatStreamCallbacks,
  type ChatStreamParams,
} from "../realtime/turnTransport";
import { useWorkbenchStore } from "../stores/workbench";

export type { ChatStreamAttachment, ChatStreamCallbacks, ChatStreamParams };

export type ChatStreamReturn = {
  sending: boolean;
  send: (args: {
    text: string;
    attachments: ChatStreamAttachment[];
    effectiveSessionId: string | null;
    turnMetadata?: Record<string, unknown>;
  }) => Promise<void>;
  stop: () => void;
};

export function useChatStream(
  params: ChatStreamParams,
  callbacks: ChatStreamCallbacks,
): ChatStreamReturn {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const sending = useWorkbenchStore((state) => Boolean(
    params.sessionId && state.activeTurns?.[params.sessionId],
  ));

  useEffect(() => subscribeTurn({
    getParams: () => paramsRef.current,
    getCallbacks: () => callbacksRef.current,
  }), []);

  return {
    sending,
    send: (args) => sendTurn(args, paramsRef.current),
    stop: () => stopTurn(paramsRef.current.sessionId),
  };
}
