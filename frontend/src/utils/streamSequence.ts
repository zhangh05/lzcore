export type StreamEnvelope = {
  type?: unknown;
  seq?: unknown;
  stream_seq?: unknown;
};

export type StreamSequenceDecision = {
  accept: boolean;
  nextSequence: number;
};

function readSequence(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/**
 * Every replayable frame, including done and error, has its own increasing
 * sequence. The cursor is the last sequence already applied to the buffer.
 * Equality is a duplicate, not a terminal alias. Unsequenced frames remain
 * backward-compatible.
 */
export function decideStreamFrame(
  frame: StreamEnvelope,
  lastSequence: number,
  terminalReceived: boolean,
): StreamSequenceDecision {
  if (terminalReceived) return { accept: false, nextSequence: lastSequence };

  const sequence = readSequence(frame.seq ?? frame.stream_seq);
  if (sequence === undefined) return { accept: true, nextSequence: lastSequence };

  return {
    accept: sequence === lastSequence + 1,
    nextSequence: sequence === lastSequence + 1 ? sequence : lastSequence,
  };
}
