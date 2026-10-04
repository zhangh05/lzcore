# 从源码理解运行链路

按问题选择入口，不必把全部文档加载进模型上下文。

| 问题 | 入口 | 深入 |
| --- | --- | --- |
| 请求怎样认证和路由 | backend/main.py | backend/api/、backend/ws/agent_ws.py |
| 本轮任务怎样执行 | agent/runtime/ssot_runtime.py | core/runtime_engine/query_loop.py |
| 模型看见哪些规则 | core/runtime_engine/prompt_contract.py | agent/llm/prompt_assembly.py、prompts/ |
| 工具怎样核验 | core/tools/manifest_registry.py | core/tools/canonical_registry.py、executor.py |
| 领域范围和对象 | extensions/runtime.py | 对应 extensions/<id>/ |
| 数据和记忆 | storage/ | core/context/、agent/runtime/memory_write/ |
| UI 和续流 | frontend/src/app/App.tsx | frontend/src/api/、stores/、pages/ |

设计原则见 [DESIGN](../../DESIGN.md)，循环语义见 [Loop](../LOOP_ENGINEERING.md)，资源和端点见 [API](../API.md)。历史审计不作为现行接口依据。

长任务、工程隔离及团队整合见 [Coding Runtime](CODING_RUNTIME.md)，验证结果见 [2026-10-05 压力记录](../CODING_BENCHMARK_RESULTS_2026-10-05.md)。
