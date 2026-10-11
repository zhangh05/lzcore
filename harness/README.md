# 后端验证

共享隔离 fixture 位于 conftest.py；所有测试数据使用临时工作区、配置和凭据存储。常规 harness 不发送真实模型请求，不连接真实设备。

| 目录 | 责任 |
| --- | --- |
| context | 历史、窗口归档、上下文容量、记忆、知识检索 |
| prompts | 生产提示词装配、可信来源、模板和数据边界 |
| llm | Provider 配置、流式原生协议、重试与取消 |
| runtime | QueryLoop、目标、恢复、持久状态、回合生命周期 |
| tools | 工具 schema、权限、执行合同、重试和结果 |
| coding | Candidate/Review、项目执行与隔离 |
| extensions | 网络、绘图、拓扑、Skill 和扩展注册 |
| storage | 文件、产物、主体和工作区隔离 |
| api | 认证、HTTP/WebSocket、会话接入 |
| jobs | 队列、租约、启动回查和取消 |
| platform | 文档、启动、桌面、Windows、交付脚本 |
| acceptance | 业务验收机制的合同，不代表真实业务压测通过 |
| integration | 依赖外部 Redis/Docker 等环境的集成验证 |

在仓库根目录运行完整回归：

```bash
.venv/bin/pytest -q harness
```

针对后端模型循环变更先运行相关领域：

```bash
.venv/bin/pytest -q harness/context harness/prompts harness/llm harness/runtime harness/tools
```

新增测试必须对应已复现问题或没有覆盖的关键合同。先找已有用例，优先扩展它；不为每次实现选择、固定文案、源码导入字符串新增测试，不复制等价场景或接受永远为真的断言。保留权限、数据隔离、原生协议、取消恢复、未知写入不重放及持久化失败边界。

故障重试测试模拟等待并验证次数和延迟，避免为退避时间实际休眠。窗口用例使用 40 轮验证多次归档、完整证据回查和 Provider 协议；更长的性能与真实模型验证按任务需要独立执行、记录结果，不重复塞进常规 CI。代码变更由正常全量 CI 验证；失败修复后按失败范围重跑。
