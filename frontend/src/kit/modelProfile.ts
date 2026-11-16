/** 模型能力（后端 agent/llm/model_profile.py）：内置 models.dev 目录 + 用户手动设置。 */
export type CapabilitySource = "user" | "catalog" | "heuristic" | "unknown";
export interface ModelProfile {
  model: string; vision: boolean; pdf: boolean; tools: boolean; reasoning: boolean; temperature: boolean;
  context_window: number; max_output: number; thinking_options: string[]; thinking_required: boolean; thinking_style?: string;
  cost_per_million: [number, number] | null; catalog_ref: string; display_name: string;
  sources: Partial<Record<"vision" | "tools" | "reasoning" | "temperature" | "context_window" | "max_output" | "_base", CapabilitySource>>;
}
/** 可手动设置的能力；缺省 = 自动。 */
export interface CapabilityOverrides { vision?: boolean | null; tools?: boolean | null; reasoning?: boolean | null; temperature?: boolean | null; context_window?: number | null; max_output?: number | null }

export const SOURCE_LABEL: Record<CapabilitySource, string> = { user: "手动设置", catalog: "内置模型目录", heuristic: "按模型名推测", unknown: "未知，按默认" };

const THINKING_LABEL: Record<string, string> = {
  provider_default: "默认", adaptive: "自适应", enabled: "开启", disabled: "关闭", none: "不思考", minimal: "最少",
  low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高",
};
export const thinkingLabel = (v: string) => THINKING_LABEL[v] ?? v;

/** 上下文长度：1048576 / 1000000 → 1M，1050000 → 1.05M，262144 → 256K，128000 → 128K。 */
export function formatTokens(n: number): string {
  if (!n) return "—";
  const trim = (x: number) => String(Math.round(x * 100) / 100);
  // 整十进制优先（128000 → 128K），再看二进制整数（131072 → 128K）。
  const unit = (dec: number, bin: number) => (n % dec === 0 ? n / dec : n % bin === 0 ? n / bin : n / dec);
  if (n >= 1_000_000) return `${trim(unit(1_000_000, 1_048_576))}M`;
  if (n >= 1_000) return `${trim(unit(1000, 1024))}K`;
  return String(n);
}
