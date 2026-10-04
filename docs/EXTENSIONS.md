# 扩展：业务实现与接入

bundled 扩展由 extensions/*/extension.json 发现，本地安装包由 plugins/*/extension.json 发现。行业对象、厂商驱动、工具、路由和 UI 留在扩展；内核只接收通用执行/证据/恢复合同。

```bash
python3 scripts/extension_cli.py create acme.insights --name "洞察工具"
python3 scripts/extension_cli.py validate plugins/acme_insights
```

工具前缀 <extension_id>.，后端 /api/extensions/<extension_id>，扩展前端 /extensions/<extension_id>。清单发布兼容版本、工具和贡献；不兼容清单不注册。模型经 ToolRuntime，外部接入经 ToolRuntimeClient，不能直接调 handler。

工具执行语义由 schema 与 `action_execution_contracts` 共同决定，目录、策略和运行时使用同一解析器。没有 `action` 字段的独立工具可以声明唯一执行合同；组合工具缺少 `action` 时不推断为只读。声明了等待时长的工具可设置 `execution_time_budget`，指定数值参数 `duration_argument` 与 0.1–10 秒的 `guard_seconds`，为返回预留时间；实际执行仍受调用方的节点时限限制。纯读取/等待超时不安装未知写入屏障，真正未知写入仍只允许回查和对账。

## 网络设备与独立绘图

network.operations 拥有区域、设备、连接、发布 Skill、Observation、Reference 和命令反馈。选择仅传资源意向；调用前重新读取发布 Skill 范围，不预连。配置是否被接受最终取决于设备账号，不能靠模型 action 冒充只读。独立目标失败不阻断其他设备。

drawing:<topology_id> 只暴露当前图 read/patch。图纸节点不是真实资产；用户绑定设备属于外部关联，只读最近测试/观测，不进入绘图 Skill。LLM 保留节点属性、坐标、连线、图元、标签和布局控制，不以默认模板限制规模。

增量编辑基于当前版本并保留未点名对象；已有基线足够可复用，否则 read 补齐。显式旧版本冲突，省略版本按锁内当前状态提交；直接保存仍校验版本。发布 schema 递归核验所有嵌套对象，自然别名不免检。action 补全和 title/summary/comment 映射不改变 canonical 字段优先权。

成功 patch 返回实际 changes、版本、数量和估算 feedback；需要全图 read 或 response_detail=full。局部 snapshot_complete=false 不是整图；合法增删、移动和联动规则见 [API](API.md)。

## 恢复和审批

扩展不自建模型循环。runtime_recoveries 经过通用合同核验；网络 CLI 拒绝返回 model_recovery_guidance，模型可调整命令或检索文档，平台不盲选替代命令。Observation 是时点事实，Reference 有候选/确认/替代/失效生命周期。

可选 configure 审批默认关闭，当前 Skill 开关决定；详见 [审批](APPROVAL_EXTENSION.md)。未知写入只对账，不能自动重放。

## 分发与验证

.apx 对文件计算 SHA-256 并用 Ed25519 签名。安装拒绝未签名/篡改/超限/重复路径/穿越/链接，失败回退前版；卸载不删工作区。

```bash
python3 scripts/extension_cli.py pack plugins/acme_insights --output dist/acme-insights-0.1.0.apx
python3 scripts/extension_cli.py verify dist/acme-insights-0.1.0.apx
python3 scripts/extension_cli.py publish dist/acme-insights-0.1.0.apx
python3 scripts/extension_cli.py install dist/acme-insights-0.1.0.apx
```

按对象生命周期、范围、caller、脱敏、失败、未知写入和 UI 核验，不把清单验证通过当业务成功。工具/Skill 写作模板在 docs/templates/。
