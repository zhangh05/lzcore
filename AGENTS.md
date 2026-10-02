# LZCore 工程协作

本页约束仓库修改；具体接口以当前代码和测试为准。用户授权决定提交/推送/发布/部署范围，不因工具可用而扩大范围。

## 不变量

1. 产品「联智中枢」、框架 LZCore、配置与指标 lzcore；不恢复废弃名称或工具别名。
2. 内核领域中立；行业对象、厂商 CLI、提示词与 UI 放在 extensions/。
3. 模型编排经 ToolRuntime.execute_node，外部/审批经 ToolRuntimeClient.invoke。禁止直接调 handler 绕过 schema、manifest、caller、policy、范围、脱敏和审计。
4. 数据使用已验证的 workspace_id 和认证主体；前端不得伪造默认工作区或权限。
5. 区分工具尝试、用户目标和外部写入未知。未知写入只 read-back/reconcile，不自动重放；只读失败可按证据目标恢复。
6. 网络范围按当前发布 Skill 重核，设备账号决定最终命令权限。action 不能将配置文本变成只读。
7. 密钥、密码、令牌、私钥和未脱敏敏感输出不得进入 Git、日志、trace、样例或浏览器持久化存储。
8. 文档描述已实现事实，提示词不承担权限控制。不要为旧文档修改正确运行时，不把历史审计当现行要求。

## 所有权

backend 负责传输与认证；agent/app 和 agent/runtime 负责会话接入与状态适配；core/runtime_engine 负责 QueryLoop、目标、证据、plan_goal_ids、goal_loop、runtime_recoveries；core/tools 负责注册与治理。extensions 提供领域实现，storage/artifacts/jobs 提供持久化和作业，frontend 用 React/Vite/Zustand 投影状态。

能力目录仅展示/推荐，不能注册工具或授权。默认 worker 使用文件锁队列，生产可切 Redis，不是 Celery。密钥优先进系统凭据库，Fernet 回退；运行数据、Provider 配置和日志不提交。

## 修改顺序

- 先读适用约束、git status、调用链、schema 与相关测试，保留无关用户改动。
- 工具同步 registry/manifest/policy/schema/调用方和证据测试；API 同步路由、调用端、API 文档和代理。
- 状态覆盖创建、读取、更新、取消、终态、删除及恢复；写入检查未知结果和幂等。
- Prompt 先查真实注入点，通用/领域/证据分层；保留能力与完整性，避免重复规则、假隔离保证和模板数据二次解释。
- 文档路径、端点、命令与环境变量必须能在源码找到。历史记录保留原验证事实并标明边界。

## 验证和交付

```bash
.venv/bin/python scripts/verify_docs_runtime_consistency.py
.venv/bin/pytest -q harness/test_goal_loop.py harness/test_docs_consistency_script.py harness/test_runtime_prompt_ssot.py
npm --prefix frontend test -- --run
npm --prefix frontend run build
```

对变更增补相关测试；UI 使用真实浏览器，Windows 打包使用原生 smoke，实际 LLM/设备效果需相应环境证据。报告改动、验证和未验证项，不用“测试通过”代替外部验收。只执行用户已授权的交付阶段。
