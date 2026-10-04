# 存储：数据归属与生命周期

storage/ 提供工作区、会话、记录、文件、密钥、记忆和运行记录接口。默认工作区根是 workspaces/，应用状态在 workspaces/_runtime/，Provider 配置在 config/providers/；它们是环境数据，不进入 Git。Windows 数据根见 [WINDOWS](../WINDOWS.md)。

## 使用规则

- 通过对应 store 读写，不在业务层自行拼用户路径或散落写 JSON。
- workspace_id 与 storage principal 一起确定可见性；不能仅凭可猜测 ID 访问资源。
- 文件写入使用相应 store 的原子写/锁；生产记录和对象适配器按各自合同持久化。
- 密钥由 storage/secret_store.py 接管；系统凭据库优先，Fernet 回退，不放在普通记录、日志或 trace。
- FileStore、artifact、knowledge、report 保留来源关系；删除、归档、恢复和 retention 使用对应生命周期，不通过清目录伪造删除完成。

## 不同记录的权威

| 记录 | 证明什么 | 不证明什么 |
| --- | --- | --- |
| TaskState/runtime_state_store | 任务控制和结果状态 | 当前外部设备状态 |
| session job | 阶段和生命周期快照 | 每个正文 token |
| turn_logs | 已持久化有序帧 | 客户端已接收/整轮已成功 |
| 会话消息/run | 保存的答复、工具与证据 | 实时续流缺口 |
| artifact/knowledge/memory | 记录内容、来源和范围 | 自动获得当前事实权威 |

终态收尾幂等补齐任务、消息和日志；中断不补造成功。终态日志保留及幂等窗口见 [API](../API.md)，未知外部写入见 [Loop](../LOOP_ENGINEERING.md)。

备份用 scripts/backup_cli.py，先验证完整性与路径，再明确恢复；桌面备份使用原生数据生命周期。恢复保留回退根，不能直接覆盖现用文件。

## 工程源文件与附件

`workspace.file action=create` 使用 `filepath` 和文本 `content`，在当前已验证主体/工作区的 `files/data`、`files/tmp` 或 `inbox` 下创建源文件，保留目录和文件名。空文本合法；缺失内容不合法。拒绝绝对路径、目录穿越和符号链接路径；目标已存在时失败，更新必须先读再 `edit/patch`。底层临时文件完整写入后以硬链接原子创建目标，竞争创建不会覆盖已有文件。

`write/write_artifact` 继续生成 FileStore 附件，有记录、来源和附件标识，不能当作保持工程目录结构的写入方式。源文件不会自动成为资料中心附件；需要交付时再显式发布产物。主 Agent 与子 Agent 使用同一工具合同和治理网关。
