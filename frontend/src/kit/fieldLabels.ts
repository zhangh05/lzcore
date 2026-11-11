/** 后端字段 / 取值的中文显示名（只翻译显示，未登记的键原样保留）。 */
export const FIELD_ZH: Record<string, string> = {
  allowed_tasks: "允许的模型任务", blocked_tasks: "禁止的模型任务", connected: "已连接", enabled_by_ui: "界面启用", health: "连接探测",
  base_url_reachable: "地址可达", chat_completion_endpoint_reachable: "对话接口可达", chat_completion_ok: "对话调用正常", configured: "已配置",
  http_status: "HTTP 状态", key_loaded: "密钥已加载", key_configured: "密钥已配置", key_preview: "密钥预览", key_source: "密钥来源",
  last_error: "最近错误", last_error_type: "最近错误类型", models_endpoint_ok: "模型列表接口正常", last_success: "最近成功", recent_failure: "最近失败",
  prompt_cache_enabled: "提示缓存", provider_type: "提供方类型", red_lines: "红线", safe_mode: "安全模式", settings_file_exists: "配置文件存在",
  vision_supported: "支持图像", call_count: "调用次数", cache_hit_ratio: "缓存命中率", estimated_cost: "估算费用", last_updated: "最近更新",
  cache_read_input_tokens: "缓存读取 Token", cache_creation_input_tokens: "缓存写入 Token", latest_prompt_profile: "最近一次提示构成",
  ok: "结果", status: "状态", state: "状态", enabled: "已启用", error: "错误", message: "说明", reason: "原因",
  created_at: "创建时间", updated_at: "更新时间", started_at: "开始时间", finished_at: "结束时间", checked_at: "检测时间", at: "时间",
  workspace_id: "工作区", run_id: "运行 ID", job_id: "作业 ID", task_id: "任务 ID", session_id: "会话 ID", trace_id: "追踪 ID",
  file_count: "文件数", reference_count: "引用数", elapsed_ms: "耗时（毫秒）", issues: "问题", unresolved: "未解决",
  applied: "已执行", automatic_replay: "自动重放", payload_writes: "写入次数", results: "结果条目", checked: "检查项",
  total: "合计", count: "条数", requests: "请求数", tokens: "Token", input_tokens: "输入 Token", output_tokens: "输出 Token", total_tokens: "合计 Token",
  cost: "费用", calls: "调用次数", provider: "模型提供方", model: "模型", models: "模型", period: "统计周期", window: "统计窗口", days: "天数",
  execution_outcome: "执行结果", final_response_summary: "回复摘要", intent: "意图", capability: "能力", memory_written: "写入记忆",
  event_count: "事件数", node_count: "节点数", total_duration_ms: "总耗时（毫秒）", persisted_at: "持久化时间", missing_event_count: "缺失事件",
  real_event_count: "真实事件", synthetic_event_count: "合成事件", name: "名称", title: "标题", kind: "类型", type: "类型", version: "版本",
  mode: "模式", language: "语言", theme: "主题", timezone: "时区", host: "主机", port: "端口", path: "路径", size_bytes: "大小（字节）",
  mime_type: "MIME 类型", logical_type: "逻辑类型", hash: "哈希", sha256: "SHA-256", source: "来源", source_id: "来源 ID", artifact_id: "产物 ID",
  config_source: "配置来源", fallback_reason: "降级原因", used: "已使用", auth_type: "认证方式", local_mode: "本地模式", default_model: "默认模型",
  dry_run: "仅预览", warnings: "注意事项", blocked_items: "受保护条目", candidate_counts: "候选数量", candidates: "候选条目", deleted_counts: "已删除数量", policy: "保留规则", audits: "审计记录",
  artifact_count: "产出文件数", exists: "是否存在", summary: "摘要", tool_id: "工具",
};
export const VALUE_ZH: Record<string, string> = {
  true: "是", false: "否", complete: "完成", partial: "部分完成", failed: "失败", unknown: "未知", ok: "正常", error: "错误",
  active: "在用", pending: "待处理", running: "运行中", queued: "排队中", cancelled: "已取消", canceled: "已取消", succeeded: "成功",
  success: "成功", completed: "已完成", disabled: "已停用", enabled: "已启用", healthy: "健康", degraded: "降级", offline: "离线", online: "在线",
};

