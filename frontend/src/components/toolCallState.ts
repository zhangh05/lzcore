/**
 * 工具调用状态的共享语义 —— 状态判定与「写入结果未知」文案的唯一来源。
 *
 * 为什么必须收敛到一处
 * -------------------
 * 改造前，同一件「写入结果未知」的事在界面上有三套说法：
 *   1. `ResultInline` 已经正确处理（回合级告警），判定依据是
 *      `metadata.execution_outcome === "unknown"`
 *   2. 内联工具卡只有 `pending / ok / fail` 三态，而「写入结果未知」在数据上
 *      同样是 `ok === false`，于是被渲染成红色「工具失败」
 *   3. `RuntimeEventTimeline` 的落库卡片另有一套 `tc.ok ? "完成" : "失败"`
 *
 * 第 2、3 条的后果不是「不好看」，而是**会让用户重复下发配置**：用户看到「工具失败」
 * 会以为没写进去，于是重发；而实际可能是「写进去了但回显丢失」。
 *
 * 判定顺序（不可调换）
 * -------------------
 *   pending → unknown → ok → fail
 *
 * - `pending` 排最前：它描述「本轮还没结束」，其余三个都是终态，
 *   未结束的记录不该被终态覆盖。
 * - `unknown` 必须先于 `ok` / `fail`：写入是否生效无法确认时，底层 `ok`
 *   通常是 false，直接按失败渲染就会触发上面说的重复下发。
 */
import type { AgentResult, InlineToolCall, ToolCallResult } from "../types";

/** `AgentResult.metadata.unknown_outcome` —— 「写入结果未知」的触发事实。 */
export type UnknownOutcomeFact = AgentResult["metadata"]["unknown_outcome"];

/** 回合级事实的最小输入。内联卡与落库卡都只需要 metadata。 */
type TurnFacts = Pick<AgentResult, "metadata">;

/** 任意一种工具调用记录共有的身份字段。 */
type ToolCallRef = { call_id?: string; tool_id: string };

/**
 * 「写入结果未知」的全部文案。
 *
 * 措辞逐字取自既有 `ResultInline`（由 `src/test/unknownOutcome.test.tsx` 固化），
 * 未做任何改写 —— 包括「由模型自行决定」这一归属表述。
 *
 * 特别注意最后一句：未知结果时**完整工具结果已经返回模型**，由模型自行判断
 * read-back、继续配置还是重试。这不是「系统强制回读」，也不是「系统冻结重试」。
 * 把它写成强制流程，就等于替模型做了一个它并没有被要求做的决定。
 */
export const UNKNOWN_OUTCOME_COPY = {
  /** 结论句：结果未确定 + 完整结果已交回模型 */
  headline: "执行结果尚未确定，完整结果已返回模型",
  /** 事实分句：外部操作可能仍在执行 */
  mayContinue: "外部操作可能仍在执行。",
  /** 归属分句：后续动作由模型自行决定 */
  modelDecides:
    "模型会基于完整工具结果自行决定 read-back、继续配置、重试或向你说明当前状态。",
  /** 胶囊短标签 */
  pill: "结果未知",
  /** 摘要区的一句话版本 */
  summary: "完整结果已返回模型，等待其决策",
} as const;

/** 事实分句 + 归属分句，拼成 `ResultInline` 现有的那一段话。 */
export function unknownOutcomeParagraph(): string {
  return `${UNKNOWN_OUTCOME_COPY.mayContinue}${UNKNOWN_OUTCOME_COPY.modelDecides}`;
}

/** 工具卡的呈现状态；比终态多一个 `pending`。 */
export type InlineCardState = "pending" | "ok" | "fail" | "unknown";

/**
 * 取回「写入结果未知」的触发事实 —— 只在它**确实还没被解决**时返回。
 *
 * 两道门都必须过，缺一不可。
 *
 * 门一：回合级 `execution_outcome === "unknown"`。
 *   这是后端耐久运行时的权威终态投影（`query_loop.py` 里它与 `unknown_outcome`
 *   由同一个事实推导：`_mark_unknown_write_outcome` 的触发条件与
 *   `derive_execution_outcome` 判定 unknown 的条件一致）。
 *
 *   但两者**可以分叉**，而且分叉方向有两个：
 *
 *   a) 回读确认之后，QueryLoop 把触发事实的 `status` 改成 `"reconciled"`，
 *      同时把 `execution_outcome` 改成 `"complete"`。此时若只看
 *      `unknown_outcome` 对象在不在，就会把一个**已经被回读确认成功**的写入
 *      重新渲染成「结果未知」—— 用户同样会重发，方向与漏报相反、后果一样。
 *
 *   b) `execution_outcome === "unknown"` 而触发事实缺失也是存在的
 *      （`harness/test_ssot_runtime_main_entry_contract.py` 固化了这条契约）。
 *      此时定位不到具体是哪一次调用，本函数返回 undefined，由回合级告警承载
 *      不确定性 —— 不猜，也不把整轮失败的调用统统标成未知。
 *
 * 门二：`status !== "reconciled"`。
 *   事实本身已被后续 read-back 关闭时，它描述的是历史而不是当前状态。
 */
export function unresolvedUnknownOutcome(
  result?: TurnFacts | null,
): UnknownOutcomeFact | undefined {
  if (result?.metadata?.execution_outcome !== "unknown") return undefined;
  const fact = result.metadata.unknown_outcome;
  if (!fact || fact.status === "reconciled") return undefined;
  return fact;
}

/**
 * 触发事实指向的是不是这一条调用。
 *
 * **只做指针匹配**，不判断不确定性是否仍然成立 —— 调用方必须先过
 * `unresolvedUnknownOutcome`。因此本函数刻意不对外导出，避免被单独误用。
 *
 * 优先按 `call_id` 精确命中：同一轮内 `tool_id` 可能重复出现
 * （例如连续两次 `workspace.file` 写入），只按 `tool_id` 会误标成功的那一次。
 * 仅当触发事实没有 `call_id` 时才回落到 `tool_id`。
 */
function pointsAtCall(ref: ToolCallRef, fact?: UnknownOutcomeFact): boolean {
  if (!fact) return false;
  const byCall = !!fact.call_id && fact.call_id === ref.call_id;
  const byTool = !fact.call_id && !!fact.tool_id && fact.tool_id === ref.tool_id;
  return byCall || byTool;
}

/**
 * 把一条**内联**工具调用映射为呈现状态。判定顺序见文件头。
 *
 * 第二个参数是**整个回合的 result**，不是 `unknown_outcome` 本身 ——
 * 因为「不确定性是否仍然成立」只有回合级投影能回答。
 */
export function deriveInlineCardState(
  toolCall: Pick<InlineToolCall, "status" | "ok" | "call_id" | "tool_id">,
  result?: TurnFacts | null,
): InlineCardState {
  if (toolCall.status === "pending" || toolCall.status === "running") return "pending";
  if (pointsAtCall(toolCall, unresolvedUnknownOutcome(result))) return "unknown";
  return toolCall.ok ? "ok" : "fail";
}

/**
 * 把一条**已落库**的工具调用映射为呈现状态。
 *
 * 落库记录没有 `pending`：能读到的调用都已经结束，所以只剩三种终态。
 * 判定顺序与内联卡一致（unknown 先于 ok / fail）。
 */
export function deriveSettledCardState(
  toolCall: Pick<ToolCallResult, "ok" | "call_id" | "tool_id">,
  result?: TurnFacts | null,
): Exclude<InlineCardState, "pending"> {
  if (pointsAtCall(toolCall, unresolvedUnknownOutcome(result))) return "unknown";
  return toolCall.ok ? "ok" : "fail";
}
