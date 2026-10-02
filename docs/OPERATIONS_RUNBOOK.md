# 故障排查与恢复

先定位环境、提交、工作区和请求 ID，再区分接入、模型、工具、任务与外部写入。保留脱敏证据；HTTP 错误、工具失败或超时不能单独决定是否可重试。

## 服务不可达

1. 读取 git rev-parse HEAD 和 git status --short。
2. 查看 docker compose -f deployment/compose.server.yml ps。
3. 检查 http://127.0.0.1:8011/api/health 与 /api/ready。
4. 从实际前端入口检查 http://127.0.0.1:5273/ 与 /api/health。
5. 已授权部署时执行 bash scripts/deploy_server_compose.sh，统一更新 backend/worker/frontend，检查同一镜像与就绪状态。

容器 liveness 不能替代前端代理或关键业务读路径。

## 回合卡住或重复调用

按 workspace/session/client_request_id 核对 session job、会话消息和 turn_logs 的同一回合。日志查询只证明已落盘；resume 不重跑工具。先确认终态消息，再续未终态日志；控制错误不当作模型失败。

检查 model_completed 的 finish_reason/output_truncated、原生函数名、JSON 参数和实际工具收据。重复 changed=false、同参数失败和未知写入需要不同处理，不能靠隐藏阶段输出解决。容量错误不通过反复提交同一请求恢复。

## 设备与画布

设备错误看最新 command_results、dispatch 和 model_recovery_guidance，厂商文档只修正语法。未知写入先只读对账；不让模型/worker/人工原样重放。

图纸看 topology_id/version、changes/feedback 和本地 dirty 状态。服务器已保存但页面有冲突时处理差量，不重复 patch 刷新。局部 snapshot 不替换整图，估算几何不证明视觉正确。

## Worker、备份与桌面

作业检查 /api/jobs/<job_id>、事件和 worker status；排队/运行先取消并等终态，永久删除要显式确认。队列 at-least-once，外部写入需要幂等。

恢复先 python3 scripts/backup_cli.py verify <archive>，再明确 restore；检查回退根、ready、worker 和业务路径。Windows 导出/退出/更新检查原生 bridge、实际任务及未保存编辑，不仅检查按钮文案；见 [WINDOWS](WINDOWS.md)。
