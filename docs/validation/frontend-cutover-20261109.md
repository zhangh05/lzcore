# 新前端切换（2026-11-09）

用户已明确授权将当前新版切入正式工程。产品仍使用 frontend/，旧版完整保留在 frontend-legacy/。启动脚本、Docker、桌面与 Windows 打包继续使用 canonical frontend/dist；没有调整版本号、tag、Release、Windows 附件或外部部署。

新版来源为 Mango 交接与 Codex 复核修复；原始接收包留在仓库外。布局、工作区/Skill/资源、附件 file.file_id、内存 local-token、安全 Markdown 和绘图绑定合同已接回。桌面关闭/后台/设置/更新桥接与 Windows 字体也接回；原生验证需单独执行，不能用源码桥接测试代替。

正式本机 5273 已切入新版并连接原8011后端，后端进程与业务数据未重启或迁移。旧版仅作为回退与兼容基线；旧版测试和浏览器 CI 保留，新产品浏览器检查独立执行，使用隔离真实后端，不调用真实模型或设备。本机核验结果见下表，完整远端 CI 随 main 提交运行。

迁移边界：新版尚缺旧版完整子任务聚合、领域证据、画布内 Agent 协作及图片/PDF/音视频预览。不能把本次切换说成这些业务能力已完成。原始框架和旧版完整源码仍可回退；根 extensions/network_operations/frontend 仅服务旧版回退桥接，当前产品 UI 维护源为 frontend/src/extension-modules/network-operations。

## 本机验证

| 项目 | 结果 |
| --- | --- |
| 新版类型、隔离与单测 | 39 文件、263 用例通过，含迁入的 5 项桌面生命周期回归。 |
| 新版生产构建 | 通过，保留既有 ELK 大 chunk 提示。 |
| 新版真实后端浏览器 | 开发5项、生产5项通过；独立临时数据和已安装 Chrome。首次因缺少 Playwright Chromium 未启动，用系统 Chrome 完成同一检查，CI 安装标准 Chromium。 |
| 旧版回退单测 | 93 文件、501 用例通过；原有 localhost:3000 连接警告仍存在，未算作新版验证。 |
| 旧版回退构建 | 通过，75 个样式文件的语法/层级检查通过。 |
| 后端关键回归 | goal_loop、文档、prompt SSOT 共65项通过；文件/旧 probe/Windows入口/生产合同相关27项通过。 |
| 命名、文档与tokens | 通过；tokens保留4项已有fallback提示。 |
| 依赖审计 | happy-dom 升级至21.0.4修复已知高危项；新版及回退版复核均为0项漏洞。回退锁文件中的 Vite、Vitest/@vitest/mocker、follow-redirects 同步升级，501项单测与构建复测通过。 |
| 正式本机读取 | 5273 读取现有工作区和后端状态；原后端 PID 32061 保持运行。没有对现有会话发送模型任务或操作设备。 |

浏览器用例验证实际认证、工作区与会话创建/回读、原件字节和名称的上传/列出/下载；未知写入与Markdown用合成消息投影，不伪装成真实写入。辅助栏在1366/390px检查可达与无整页溢出。后续对齐实际 LLM 状态的 connected/enabled 字段，避免已连接被误写成未上报。

本次源码切换保留版本3.3.19，没有发布Windows包。旧发布附件继续是旧源码构建，不能将它们称为本次新版前端包。回退可通过main对应提交的可逆恢复或在隔离端口手动运行frontend-legacy；默认入口始终只有frontend。
