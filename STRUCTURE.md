# 源码导航与归属

```text
agent/          应用、LLM 协议、会话与运行时适配
artifacts/      制品生命周期和来源
backend/        Flask API、认证、WebSocket 与其他传输
config/         配置样例；本机 providers 子目录不提交
core/           通用循环、上下文、工具治理与维护
extensions/     领域对象、驱动、工具、路由和 UI
frontend/       React/Vite 工作台与扩展路由装配
storage/        记录、工作区、会话、文件、记忆和凭据
jobs/           队列、worker、作业生命周期
workflows/      DAG 定义、校验与执行
prompts/        辅助模板、注册与受限渲染
observability/  trace 和运行事件
harness/        后端契约、集成和架构测试
deployment/     镜像、Compose、代理、观测和发布槽
packaging/      Windows 发行资源和安装器
scripts/        开发、验证、备份、部署和发布
```

backend 不拥有任务语义，frontend 不拥有授权；行业行为不写进通用内核。平台执行入口是 core/tools，业务数据访问通过对应 store。新增模块先确定该层归属，不另造工具执行或状态同步协议。

生产提示词在 core/runtime_engine/prompt_contract.py；领域提示词在对应扩展；prompts/templates 是辅助任务，不是生产 QueryLoop 的替代入口。

workspaces/、logs/、config/providers/、本地环境文件、虚拟环境、依赖、构建和测试产物属于环境状态。同步源码保留数据根，不把本机默认路径当用户工作区。旧别名、shim 和移除的数据根不在当前架构中。

下一步见 [源码调用链](docs/architecture/README.md)、[工程约束](AGENTS.md)。
