# Windows 桌面发行与数据

便携版和安装版使用同一 lzcore.exe、本地 Flask 与 pywebview/WebView2。最低 Windows 10 2004 x64、.NET Framework 4.8，支持 Windows 11 x64。窗口使用原生标题栏、缩放、最大化、任务栏和 Snap；位置/大小/最大化按显示器和 DPI 保存，移除显示器后限制在可见工作区。

## 两种原生包

| 附件 | 启动 | 默认数据 | 集成 |
| --- | --- | --- | --- |
| lzcore-v3.3.15-windows-portable.zip | 解压后 lzcore/lzcore.exe | 程序旁 data/ | 默认无快捷方式/注册表/自启动 |
| lzcore-v3.3.15-windows-setup.exe | 每用户安装向导 | %LOCALAPPDATA%/LZCore | 开始菜单、可选桌面快捷方式、卸载项 |

固定版本 WebView2 随包附带，不需另装 Python/Node 或在线下载运行时。版本与 Microsoft URL 在 packaging/webview2.json，构建验证 Microsoft 签名；固定运行时随应用更新，不采用 Evergreen 自动更新。Windows 10 启动会为运行时授予 App Container 读取/执行权限，不从 UNC 目录运行。平台限制见 [Microsoft 部署文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

安装器拒绝带 portable.json 的目录，迁移时选独立安装目录。另一个 windows-x64.zip 是 start.bat 源码/浏览器包，带 `runtime\python\python.exe` 和 `runtime\node\node.exe`，不要求用户另行安装开发环境；不是原生桌面包。

## 数据和单实例

--data-dir 可指定目录，例如 lzcore.exe --data-dir "D:\联智数据"。workspaces/ 放业务和按用户数据，config/ 放配置，.runtime/ 放窗口偏好、WebView 缓存、恢复/更新，logs/ 放脱敏桌面日志。数据格式一致，程序与数据分开；相同数据目录第二次启动唤醒原窗口。

旧程序旁 workspaces/config 在新数据目录为空时复制校验并保留源，中断可续；已有目标不自动覆盖。桌面设置也可选旧目录迁移，先退出旧程序。DPAPI 凭据绑定 Windows 用户和机器，跨机迁移用原用户创建的加密备份。

## 关闭、后台与导出

最小化进任务栏；空闲且无未保存编辑时一次关闭退出。有任务/编辑时提供返回、后台、停止任务并退出。可设置关闭进托盘；隐藏不取消任务，托盘提供窗口、设置、数据目录和退出。任务通知定位到原工作区/会话，授权仍照常检查。

LocalLifecycle 在退出/备份/恢复/更新前停止新操作，取消通过已有机制并等收尾；无法确认时显示等待、返回或显式中断，不能把终态历史当活跃任务。停止操作立即反馈，异常提供恢复路径。重启将中断记录为中断，不重跑未知写入。

工作台会话、图纸 SVG/PNG/PDF 和批注用原生保存对话框；取消不触发浏览器下载，失败在页面显示。可打开最近导出目录。诊断 ZIP 仅程序身份和脱敏桌面日志，不复制会话正文或 Provider 配置。

主题浅色/深色/跟随 Windows 保存在用户数据。批注走独立资源版本，不改变拓扑版本；窄窗口仍可打开任务进度。

## 备份和恢复

认证启用时，数据目录/诊断/备份/恢复/迁移/更新要求真实 HttpOnly 会话核验的默认组织管理员，不能信任前端声明用户名。备份要求空闲且编辑已保存。

普通 ZIP 保存工作区及脱敏配置，不含密钥。加密备份使用至少 12 字符口令、Scrypt 和 Fernet，可显式带凭据；口令不保存，凭据在内存加密，恢复重新用当前用户 DPAPI 保存，不写明文暂存。

恢复检查格式、大小、路径和每文件 SHA-256，暂存后确认并在重启切换；旧数据留 .runtime/before-restore，恢复日志可续。普通备份不覆盖已有本地密钥库，图纸/会话/批注随工作区保存。

## 更新、回退与同版本重建

更新来源固定 GitHub zhangh05/lzcore。windows-update.json 声明包名、数据格式、大小、SHA-256 与 source_commit；下载验证后才应用，签名包另验 Windows 签名。任务结束、编辑保存后，PowerShell 助手等主程序退出再替换重启；失败尽量恢复前版程序并保留数据。重启显示安全失败摘要，不转发原异常。

回退只接受同数据格式且有清单的已发布版本，只换程序、不撤销数据。3.2.x 没有该清单；旧数据仍可迁移。SHA256SUMS.txt 可用于手工核验。

已有版本修复可从 main 手动运行 Release，release_tag 填 v3.3.15：流程核对版本、验证后替换附件，**不移动 tag**。以 windows-update.json.source_commit 判断实际构建来源。应用内按版本号检测，同版本重建不会自动提示升级，需要重新下载安装器或便携包，保留数据目录。

GitHub Secrets LZCORE_SIGNING_PFX（Base64 PFX）和 LZCORE_SIGNING_PASSWORD 可签主程序/安装器/卸载器；未配置时标明未签名，不能宣称 SmartScreen 信誉。

## 构建和验收

```powershell
python -m pip install -r requirements-desktop.lock
npm --prefix frontend ci
npm --prefix frontend run build
./scripts/download_webview2.ps1
python scripts/build_windows_exe.py --webview2-runtime $env:LZCORE_WEBVIEW2_DIR
```

Release workflow 使用锁定 Windows/Python 依赖、Inno Setup，每用户安装、升级前退出，卸载保留数据。windows_desktop_smoke.py 启动真实 EXE，经 CDP 验证页面、bridge、主题、缩放、托盘、第二次启动、原生导出、WebSocket 和带终态历史的关闭；安装/升级/卸载数据保留也单独验证。报告/截图在 windows-desktop-validation 产物。

runner 自动化不证明所有实体机/DPI/多显示器或大图帧率。原生关闭检查发现 Python.NET 卸载时，WinForms/WebView2 对象的终结可能再次调用已移除的类型。退出先完成任务收尾、等待原生关闭调用和状态线程返回，托盘由所属 UI 线程释放；随后停止本地服务、关闭设备会话、释放单实例锁，并按需启动恢复后的新进程。仅已加载 Python.NET 的 Windows 桌面入口，在上述清理和日志刷新完成后结束宿主进程，不再调用显式卸载或解释器退出钩子。Web-only、第二实例和其他平台保留正常 Python 退出。退出报告记录 exit_code/exit_hex，失败时保留 Windows 原生事件堆栈；原生 smoke 检查实际进程正常退出以及同一数据目录的重复启动和关闭。
