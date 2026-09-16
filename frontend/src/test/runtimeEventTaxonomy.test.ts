/**
 * The timeline used to colour a row by matching substrings of the event name:
 * `tool` came out as a warning, `semantic_invalid` fell through to no colour at
 * all, and any new stage inherited whatever tone its spelling happened to match.
 * These tests hold the taxonomy to being explicit and complete.
 */

import { describe, expect, it } from "vitest";
import {
  RUNTIME_EVENT_KIND_LABELS,
  STREAM_STAGE_KINDS,
  STREAM_STAGE_LABELS,
  TRACE_EVENT_LABELS,
  runtimeEventKind,
  runtimeEventLabel,
  runtimeEventTone,
} from "../utils/streamStage";

describe("runtime event taxonomy", () => {
  it("classifies every known event name, in both vocabularies", () => {
    // The live stream and the persisted run trace use different names for the
    // same steps; a taxonomy built from only one of them left the timeline's
    // actual rows unclassified.
    const known = [...Object.keys(STREAM_STAGE_LABELS), ...Object.keys(TRACE_EVENT_LABELS)];
    const unclassified = known.filter(name => !(name in STREAM_STAGE_KINDS));
    expect(unclassified).toEqual([]);
    const phantom = Object.keys(STREAM_STAGE_KINDS).filter(name => !known.includes(name));
    expect(phantom).toEqual([]);
  });

  it("labels a run-trace event the same way it labels its stream twin", () => {
    expect(runtimeEventLabel("turn_start")).toBe("开始处理");
    expect(runtimeEventLabel("model")).toBe("模型调用");
    expect(runtimeEventLabel("tool_call")).toBe("工具调用");
    expect(runtimeEventKind("tool_call")).toBe("tool");
    expect(runtimeEventKind("final")).toBe("response");
  });

  it("gives every kind a label, so a row can be read without colour", () => {
    const kinds = new Set(Object.values(STREAM_STAGE_KINDS));
    const unlabelled = [...kinds].filter(kind => !RUNTIME_EVENT_KIND_LABELS[kind]);
    expect(unlabelled).toEqual([]);
  });

  it("reports an unknown stage as unknown instead of guessing", () => {
    expect(runtimeEventKind("execution_started")).toBe("tool");
    expect(runtimeEventKind("semantic_validated")).toBe("validation");
    expect(runtimeEventKind("some_future_stage")).toBe("unknown");
  });

  it("does not treat a tool call as a warning", () => {
    // The substring rule mapped "tool" to the warning tone, so every ordinary
    // tool step looked like something to worry about.
    expect(runtimeEventTone({ event_type: "execution_started" })).toBe("neutral");
    expect(runtimeEventTone({ event_type: "execution_completed" })).toBe("ok");
  });

  it("marks a validation finding as worth attention, not as a failure", () => {
    expect(runtimeEventTone({ event_type: "semantic_invalid" })).toBe("warn");
    expect(runtimeEventTone({ event_type: "cognitive_gap_detected" })).toBe("warn");
  });

  it("lets a recorded error outrank the stage's own tone", () => {
    expect(runtimeEventTone({ event_type: "execution_completed", error: "connection reset" })).toBe("danger");
    expect(runtimeEventTone({ event_type: "execution_started", level: "error" })).toBe("danger");
    expect(runtimeEventTone({ event_type: "execution_started", level: "warn" })).toBe("warn");
  });

  it("keeps an unrecognised stage neutral rather than coloured", () => {
    expect(runtimeEventTone({ event_type: "some_future_stage" })).toBe("neutral");
  });
});
