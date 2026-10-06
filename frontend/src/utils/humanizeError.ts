/**
 * Human-readable error classifier for agent / provider failures.
 *
 * Shared by AgentWorkbench so the same message + retry hint appears wherever
 * a run / message ends in an error. Describe the observed boundary without
 * inferring a model defect, expired credentials or a network root cause.
 */

export interface HumanFailure {
  msg: string;
  retryable: boolean;
}

export function humanFailure(errorType: string | undefined, errorText: string): HumanFailure {
  const et = (errorType ?? "").toLowerCase();
  const text = (errorText ?? "").toLowerCase();
  // Auth/permission
  if (text.includes("disabled") || text.includes("llm is disabled"))
    return { msg: "LLM 未启用，请前往系统设置开启并配置 API Key。", retryable: false };
  if (et.includes("auth_failed") || text.includes("api_key") || text.includes("authentication"))
    return { msg: "模型服务认证失败，请检查设置中的凭据和访问权限。", retryable: false };
  if (et.includes("provider_timeout") || et === "llm_call_timeout")
    return { msg: "模型请求超时，具体原因尚未确认。", retryable: true };
  if (text.includes("timed out") || text.includes("超时"))
    return { msg: "请求超时，具体原因尚未确认。", retryable: true };
  if (et.includes("provider_error") || text.includes("provider"))
    return { msg: "模型服务返回异常，请核对运行记录。", retryable: true };
  // Tool sandbox
  if (text.includes("forbidden function") || text.includes("forbidden_import"))
    return { msg: "请求的操作被执行策略拒绝，请核对任务范围。", retryable: true };
  if (text.includes("syntax error") || text.includes("unterminated"))
    return { msg: "执行过程报告语法错误，需要核对源码、命令和执行环境。", retryable: true };
  // Caller identity
  if (text.includes("caller_identity") || text.includes("requested_by"))
    return { msg: "系统调用链身份缺失，请刷新页面后重试。", retryable: false };
  // Default
  return { msg: errorText, retryable: true };
}
