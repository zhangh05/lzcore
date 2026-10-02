# 工作流：确定性 DAG

工作流属于工作区，节点引用 canonical 或已安装扩展工具，经 ToolRuntimeClient 的 schema、policy、范围、脱敏和审计执行。工作流不拥有另一套 LLM 循环。

## 定义

```json
{
  "workflow_id": "readonly_inspection",
  "name": "批量只读巡检",
  "failure_policy": "continue",
  "nodes": [{
    "node_id": "inspect",
    "tool_id": "network.operations.inspection",
    "arguments": {"connection_ids": "${input.connection_ids}"}
  }]
}
```

node_id 唯一，依赖存在且无环；输出引用只能来自传递依赖。节点数量不作为任务终止上限，解析后单节点输入上限 1 MiB。定义中不得持久化凭据或授权秘密。

## 执行与失败

独立只读节点按并发上限执行；有副作用节点形成顺序屏障。失败记录在对应节点，不阻断无依赖节点；依赖失败输出的节点标记依赖不可用。结果按稳定节点顺序保存，failure_policy 固定采用 continue 语义。

POST /api/workflows/<workflow_id>/runs 默认同步；enqueue=true 创建 durable workflow_run 作业。worker 是 at-least-once，外部写入 handler 需要以作业和节点 ID 建幂等键，不能自动重放未知写入。

QueryLoop 的恢复目标只在对话循环消费相应工具结果时生效；普通工作流保存节点事实，由所有者决定后续。端点见 [API](API.md)，任务语义见 [Loop](LOOP_ENGINEERING.md)。
