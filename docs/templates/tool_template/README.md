# 工具接入模板

优先扩展已有 canonical 工具动作。新业务工具使用扩展命名空间；确需新平台工具时更新 core/tools/tool_namespace_data.py、canonical registry 与 manifest。

## 合同先行

- 发布完整输入 JSON schema，明确动作的必需参数、结果字段和安全绑定。
- manifest 声明调用方、权限动作、风险、副作用、dry_run 和输出敏感性。
- handler 返回可序列化的事实、状态、引用和安全错误；未知写入保留 unknown，不能标成可重试失败。
- 模型经 ToolRuntime.execute_node，外部/审批经 ToolRuntimeClient.invoke；测试使用治理执行器，不能直接调用 handler 来证明授权正确。

## 验收

核对 namespace/manifest/schema/caller/policy/脱敏，以及资源创建、读取、写入、删除和恢复。存在外部副作用时核对幂等与未知结果。API/前端接入时同步调用与文档；模型提示只解释选择，不实现权限。

工具身份以注册表和 /api/tools/catalog 为准，不增加别名或旁路注册表。扩展打包见 [EXTENSIONS](../../EXTENSIONS.md)。
