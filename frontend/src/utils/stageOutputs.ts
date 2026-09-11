import type { StageOutput } from "../types";
import { sanitizeAssistantText } from "./displayText";

/** Validate and sanitize both durable metadata and the browser's live cache. */
export function normalizeStageOutputs(value: unknown): StageOutput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || typeof item.text !== "string") return [];
    const text = sanitizeAssistantText(item.text);
    return text.trim() ? [{
      id: typeof item.id === "string" ? item.id : `model-${index + 1}`,
      label: typeof item.label === "string" ? item.label : `模型输出 ${index + 1}`,
      text,
    }] : [];
  });
}

/** The last model output is already shown as the final answer. Earlier stages
 * remain intact even when their wording happens to match a later answer. */
export function precedingStageOutputs(value: unknown, finalText: string): StageOutput[] {
  const stages = normalizeStageOutputs(value);
  return stages.at(-1)?.text.trim() === sanitizeAssistantText(finalText).trim()
    ? stages.slice(0, -1) : stages;
}
