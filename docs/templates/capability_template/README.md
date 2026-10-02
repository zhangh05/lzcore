# 能力目录条目模板

能力目录面向用户解释结果和推荐工具，不注册 handler，也不授予权限。实现位于 agent/capabilities/catalog.py。

```python
{
    "capability_id": "my_feature",
    "display_name": "My Feature",
    "description": "用户可获得的具体结果及其范围。",
    "module_ids": ("my_feature",),
    "recommended_tool_ids": ("workspace.file", "text.analyze"),
    "prompt_hints": ("依据实际来源核对结论。",),
    "safety_notes": ("文档记录不等于实时观测。",),
    "status": "enabled",
}
```

先完成受治理的执行和证据路径，再展示条目。recommended_tool_ids 使用实际 canonical ID；prompt_hints 只补能力特有的决策信息，不复制全局提示或暗示执行成功。避免第二套工具注册、固定设备状态、假制品和授权声明。
