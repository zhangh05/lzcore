# 网络配置的可选审批

extensions/approval/ 仅在当前发布 Skill 的 approval_enabled=true 时拦截 configure。默认关闭；审批不代替设备账号权限，也不定义另一套危险命令分类。

## 冻结、决定、恢复

```text
configure 提案 -> 拦截并保存精确调用 -> pending（未接触设备）
  -> approve/reject/cancel
  -> 重新核验 digest、Skill、设备、连接及范围
  -> 仅批准时经 ToolRuntimeClient 执行
  -> executed/unknown/invalidated/rejected/cancelled
  -> 同一决策集终态 -> 原 checkpoint 恢复
```

拦截读取当前 Skill 开关，不用工作台旧快照。连接短 ID 先解析 canonical ID，再核对 Skill 和已选连接。拦截失败返回 EXECUTION_INTERCEPTOR_FAILED、executed=false，不继续发送写入。

digest 覆盖设备、连接公开元数据/revision、Skill updated_at/范围、命令顺序与 UTF-8 文本、超时和执行模型。内容或资源版本变化使批准失效，不能打开连接执行旧调用。

暂停保留完整模型消息、原 call_id、调用及结果边界到 approval_continuation；不摘要、不截断，不占住 LLM 或设备连接。checkpoint 无 TTL；决策集全部终态后，服务端原子认领并将实际结果按 call_id 回注同一循环。前端不发送伪造“继续”请求。

## 批量与未知结果

命令意图以 extensions/network_operations/command_semantics.py 为准：满足只读语法条件的 display/show/ping 归只读，其余归配置。含配置的批次进入审批，不是事务。明确 CLI 失败仍记录每条 command_results 并按驱动合同继续；传输断开后无法发送的标 not_sent。未知写入不重放，先 read-back/reconcile。

## 接口

- GET /api/extensions/approval/operations
- GET /api/extensions/approval/operations/{operation_id}
- POST /api/extensions/approval/operations/{operation_id}/decision

均要求 workspace_id；decided_by 来自服务端主体，本地无主体记 user，不接受正文伪造身份。记录不含明文设备凭据。验收覆盖开关变化、短 ID、版本失效、拒绝、取消、未知写入和恢复完整性。
