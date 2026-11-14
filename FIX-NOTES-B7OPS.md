# B7OPS 修复说明

工作区：`lzcore-fix-batch7-multiuser`，分支 `fix/batch7-multiuser`。
范围：11 P0-01、P0-02、P0-04；09 GTM-P0-08；04 P0-01。
只留下工作区改动，未提交、推送或部署。审查报告仅作只读参考。

## 1. 11 P0-01：发布槽完整性

- 修改 `deployment/slots.py`。
- 激活（包括重复激活）和显式回退在改链接前读取 manifest，检查版本及摘要格式，重新计算完整文件树摘要；文件增加、删除、重命名、内容修改或摘要不一致均失败，不改变 current/previous。
- 中断日志恢复、健康检查失败后的链接恢复也先校验全部恢复目标，避免通过恢复路径重新激活损坏槽；失败时保留恢复日志供排查。
- 摘要包含文件名长度、文件名、内容长度、内容；仅排除槽根的 `release.json`，子目录同名文件仍计入；拒绝符号链接和特殊文件。
- **行为变化**：新槽 manifest 使用 `hash_format=2`。旧版无分隔摘要不能提供同等文件边界合同，拒绝直接激活或恢复，需从可信源码重新 stage。不会自动改写旧 manifest 来“认可”其当前内容。
- 回归：`harness/platform/test_b7ops_release_backup.py` 的损坏槽矩阵（激活/回退/重复激活）、拼接歧义测试、中断恢复损坏槽测试。已有正常发布/回退及健康失败恢复用例仍通过。
- 遗留：同目录 hash 不是发行者签名；有权限同时改程序和 manifest 的攻击者仍可重签摘要。未新增文件系统只读策略或外部署名服务，不能保证摘要检查后与外部写进程并发修改时无竞态。

## 2. 11 P0-02：CLI tar 备份跨平台路径

- 修改 `core/runtime/backup.py`。
- 同时按 POSIX/Windows 语义拒绝绝对路径、盘符、UNC、反斜杠、空或点路径分量、`..`、冒号/ADS、设备保留名、控制字符、Windows 非法字符及尾部点/空格。
- 备份创建时也检查路径，避免产生自己无法安全恢复的归档；拒绝大小写归一后的文件名冲突。归档只允许普通文件和目录。
- 恢复每个成员落盘前再次校验路径，并检查 resolve 后严格位于本次暂存数据目录内。manifest 的 backup_id 也限制为安全标识，防止恢复回退目录被拼入路径。
- **行为变化**：POSIX 本机合法但不能安全跨平台恢复的文件名现在明确报错；不会重命名或静默略过。
- 回归：同一 platform 测试文件中的跨平台恶意归档矩阵、Windows 大小写冲突、恶意 backup_id、中文路径正常创建/验证/恢复。恶意成员在创建恢复暂存目录之前被拒绝。
- 验证边界：跨平台路径由当前 Python 的 PureWindowsPath/PurePosixPath 验证，未执行 Windows 原生恢复。

## 3. 11 P0-04：远端数据面空备份

- 修改 `core/runtime/backup.py`。
- 采用最小安全方案：使用现有存储模式解析，PostgreSQL（含 postgresql 别名）或 S3（含 object/旧存储模式别名）下 create/verify/restore 均抛出明确 BackupError，说明文件系统备份无法覆盖 PostgreSQL/S3，应使用数据面备份工具。
- 检查在遍历工作区或生成备份文件之前执行；本地目录为空或只有部分文件均不能绕过。
- 新 manifest 声明 `data_sources={records: filesystem, objects: local}`；不接受声明为其他数据面的归档。旧格式 1 本地归档仍可在本地模式校验，但不能据此证明历史远端数据完整；远端模式一律拒绝。
- 回归：同一 platform 测试文件中的模式别名/空目录/有本地文件矩阵，对 create/verify/restore 三条路径检查拒绝且无新增备份；远端来源 manifest 拒绝；本地往返正常。
- **未实现** PostgreSQL 一致性导出和 S3 对象导出，因涉及新的数据源一致性及恢复设计，本批不以本地快照冒充完整备份。

## 4. 09 GTM-P0-08：浏览器非 HTTP 边界

- 修改 `agent/modules/browser/core.py`。
- 创建任何页面之前安装 context 级 `route_web_socket`；每个 ws/wss 目标映射到对应 http/https，复用 HTTP 的主机、DNS、IPv4/IPv6、私网/回环及精确预览授权检查，失败时关闭连接，不调用 connect_to_server。
- 页面/子资源 HTTP route 和 WS route 都捕获创建 context 时的 scope，预览授权保持主体/工作区/端口边界；公网 WS 可继续使用。
- context 显式 `service_workers="block"`，防止 Service Worker 绕开 HTTP route；浏览器禁用 QUIC，并设置 WebRTC 禁止非代理 UDP 的策略，收紧常见的非 HTTP 传输路径。
- 初始化任一路由失败（包括旧 Playwright 无 WS API）立即关闭新浏览器，不留下可复用的未保护 context。
- 回归：新增 `harness/tools/test_b7ops_browser_network.py`，覆盖私网/回环/映射 IPv6/CGNAT、混合 DNS、DNS 失败、正常公网、精确预览 scope、畸形 URL，以及路由安装顺序和初始化失败清理；修改 `harness/tools/test_browser_runtime_contract.py` 的浏览器替身以支持 WS 路由接口。
- **遗留/不能声明完成的边界**：Playwright 的 HTTP continue_ 和 WS connect_to_server 接口不能指定已预检的实际目的 IP；本批未引入受控出口代理，因此 HTTP/WS 的 DNS 重绑定仍没有连接层保证。未以改写 URL 为 IP 的方式破坏 Host/TLS/SNI。Chromium 的传输开关也不能替代覆盖所有协议的出口防火墙；WebRTC TCP/TURN 等非 route 传输未完成逐目标校验。完整隔离需受控出口代理/网络命名空间的设计，不能仅靠页面脚本或启动参数声称已解决所有 SSRF。
- **验证边界**：新增测试全用 fake route/context/DNS，无网络。当前沙箱禁止 Chromium 的 MachPortRendezvous 启动，真实 WS/Service Worker/其他协议的原生浏览器验收未完成。

## 5. 04 P0-01：认证/服务器执行隔离

- 修改 `core/tools/general_tools/command_tools.py`、`core/tools/python_runner.py`。
- shell 和 PowerShell 入口在执行及工作区文件变更管理之前检查隔离要求。认证/身份/OIDC/登录启用，或部署设置 `LZCORE_PYTHON_REQUIRE_STRONG_ISOLATION` 时，shell 必须绑定已启动、有 image_id、未关闭的 DockerProjectEnvironment；无绑定、错误类型、未启动或已关闭都明确拒绝，不能回退宿主。
- Python 与 shell 共用同一模式判定；Python 原有独立强隔离 Docker runner 保留。已绑定 Python 项目同样校验其类型和生命周期。
- 判定不再使用 `LZCORE_RUNTIME_BIND_HOST`；未认证个人模式的本机 shell 保持可用。生产/server compose 已设置强隔离开关，生产 compose 也启用认证/身份，无需增加新 profile 环境变量。
- 支持登录密码文件的“已配置”状态检测，不为选隔离边界读取密码文件或系统凭据；trusted-local Python opt-in 不能覆盖强隔离要求。
- Docker 项目执行失败保持失败，不切回宿主；PowerShell 已绑定 Linux 项目时仍按现有合同提示改用 shell/python。
- 回归：扩展 `harness/tools/test_shell_isolation.py`，覆盖认证模式/不同监听地址/两种 shell、真实类型的 Docker 环境替身生命周期、容器失败无宿主回退和个人 Python 模式；更新 `harness/tools/test_python_runner_policy.py`，将原“非 loopback 必须隔离”用例改为“认证模式必须隔离”。所有容器调用使用替身，不调用真实 Docker/Provider/设备。

## 已合入修复核对

本组五条在开始核对时均仍有上述缺口，没有整条可直接跳过的项目。相关但不重复修改的已实现行为：

- 发布槽已有配置/凭据路径排除、源码符号链接拒绝、重复激活保持 previous、跨进程 switch 锁和恢复日志；保留这些行为。
- CLI 已有离线桌面实例锁及部分多进程部署拒绝；保留在 `scripts/backup_cli.py`，通过公共 backup 核心统一补数据面拒绝。
- 浏览器已有主体/工作区/session 隔离、精确本机预览授权和 HTTP 私网检查；复用现有合同。
- Docker 项目已有生命周期拒绝和关闭后保留 binding 防迟到调用回退；保留现有项目执行器，不修改其实现。

## 本组文件清单

源码：

- `deployment/slots.py`
- `core/runtime/backup.py`
- `agent/modules/browser/core.py`
- `core/tools/general_tools/command_tools.py`
- `core/tools/python_runner.py`

测试：

- 新增 `harness/platform/test_b7ops_release_backup.py`
- 新增 `harness/tools/test_b7ops_browser_network.py`
- 修改 `harness/tools/test_shell_isolation.py`
- 修改 `harness/tools/test_python_runner_policy.py`
- 修改 `harness/tools/test_browser_runtime_contract.py`（仅两处替身补接口）

说明：`FIX-NOTES-B7OPS.md`（本文件）。未修改禁止目录；worktree 中同时出现的 backend/storage/extensions/其他 runtime 文件改动属于并行任务，未覆盖或回退。

## 验证

定向测试（不执行两项需要真实 Chromium 的既有用例）：

```bash
/Users/zhangh01/Desktop/lzcore/.venv/bin/python -m pytest harness/platform/test_b7ops_release_backup.py harness/platform/test_production_runtime.py harness/platform/test_p1desk_regressions.py harness/tools/test_shell_isolation.py harness/tools/test_python_runner_policy.py harness/tools/test_b7ops_browser_network.py harness/tools/test_browser_runtime_contract.py -q -k 'not test_navigate_snapshot_and_ref_click_share_one_browser_session and not test_public_switch_tab_action_is_implemented_by_browser_runtime' 2>&1 | tail -15
```

结果：191 passed，2 deselected。`git diff --check` 通过。

指定目录测试：

```bash
/Users/zhangh01/Desktop/lzcore/.venv/bin/python -m pytest harness/platform harness/tools harness/storage -q 2>&1 | tail -15
```

末次结果：1421 passed，8 skipped，6 failed（23.13s，退出码 1）。首次为 1388 passed，8 skipped，6 failed；随后补充了本组的中断恢复用例，同时工作区还有其他组并行增加测试，所以总数发生变化。

- 3 项环境限制：`test_browser_preview_access.py::test_governed_browser_preview_and_sessions_are_isolated` 本地 socket bind 被沙箱拒绝；`test_browser_runtime_contract.py` 的两个真实浏览器用例因 Chromium MachPortRendezvous Permission denied 无法启动。
- 3 项其他组合同变化：`test_platform_foundation.py::test_identity_uses_hashed_password_and_role` 仍按旧字典字段断言，运行返回已带 user_id/auth_version；`test_identity_viewer_is_workspace_scoped` 仍期待改密码后旧 session 可继续访问，运行返回 401；`test_admin_exclusively_manages_ordinary_user_access` 仍期待凭 api-token 用户名得到 WS 特权，运行已拒绝。对应实现属于禁止修改范围，未为迁就旧断言改回认证边界，也未修改其他组测试。

测试的工作区/config 均使用 harness 临时目录和内存凭据后端；未读取真实工作区、`.env.local`、本机真实凭据或 `config/providers/`。未进行真实 PostgreSQL/S3/Docker、Windows 或生产部署验收。
