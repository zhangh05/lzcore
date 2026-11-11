/** 单条核对用到的服务端记录形态：审阅项与写操作账本（A18-审阅）。 */
export interface ReviewItem {
  item_id: string;
  workspace_id?: string;
  artifact_id: string;
  title?: string;
  severity?: "info" | "warning" | "error" | string;
  category?: string;
  reason?: string;
  status?: "pending" | "accepted" | "ignored" | "modified" | string;
  updated_at?: string;
}

export interface LedgerOperation {
  operation_id: string;
  status: string;
  canonical_tool?: string;
  tool_id?: string;
  task_id?: string;
  turn_id?: string;
  session_id?: string;
  result_summary?: string;
  updated_at?: string;
}
