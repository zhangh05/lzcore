import {
  IconBook, IconBrain, IconChat, IconChecklist, IconDocument, IconFlow, IconFolder,
  IconGauge, IconProbe, IconPuzzle, IconSettings,
} from "./Icon";

const MAP = {
  chat: IconChat, checklist: IconChecklist, folder: IconFolder, document: IconDocument,
  book: IconBook, brain: IconBrain, flow: IconFlow, settings: IconSettings, gauge: IconGauge,
  probe: IconProbe, puzzle: IconPuzzle,
} as const;

/** 名称 → Phosphor 图标。扩展 manifest 的 icon 不认识时回落到拼图。 */
export function NavIcon({ name, size = 18 }: { name: string; size?: number }) {
  const Icon = (MAP as Record<string, typeof IconPuzzle>)[name] ?? IconPuzzle;
  return <Icon size={size} aria-hidden="true" />;
}
