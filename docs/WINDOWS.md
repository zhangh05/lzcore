# Windows 桌面版

联智中枢提供两种桌面发行包，使用同一套 `lzcore.exe`、本地 Flask 后端和 pywebview / WebView2 窗口。最低环境为 Windows 10 2004 x64、.NET Framework 4.8；支持 Windows 11 x64。界面沿用网页版本，Windows 拥有标题栏、拖动、缩放、最大化、任务栏和 Snap。首次窗口按当前显示器工作区定位；窗口位置、大小和最大化状态按显示器和 DPI 保存，移除显示器后会重新限制到可见区域。

## 选择发行包

| 包 | 使用方法 | 用户数据 | 系统集成 |
| --- | --- | --- | --- |
| `lzcore-v3.3.0-windows-portable.zip` | 解压到可写的本地目录，双击 `lzcore/lzcore.exe` | 程序旁 `data/` | 默认不创建快捷方式、注册表项或自启动 |
| `lzcore-v3.3.0-windows-setup.exe` | 运行安装向导，默认无需管理员权限 | `%LOCALAPPDATA%\LZCore` | 开始菜单、可选桌面快捷方式、卸载项；自启动在应用内单独开启 |

两个包都附带固定版本 WebView2，离线启动无需下载 Python、Node 或浏览器运行时。运行时版本和官方 Microsoft 下载地址锁在 `packaging/webview2.json`；构建时验证 Microsoft 数字签名。固定运行时随应用发行更新，不采用 Evergreen 的自动更新。Windows 10 首次启动会为这一运行时目录授予 App Container 读取和执行权限；它不能从 UNC 网络目录运行。[Microsoft 部署说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

安装器拒绝安装到带有 `portable.json` 标记的便携版目录，避免混用发行方式导致数据位置变化。转换为安装版时请选择独立目录，再通过桌面设置迁移便携版的 `data/`。

另外保留 `windows-x64.zip` 作为带源码的浏览器运行包，启动入口为 `start.bat`。它不属于上述两种原生桌面发行方式。该包自带 `runtime\python\python.exe` 和 `runtime\node\node.exe`，不要求用户另行安装开发环境。

可用 `lzcore.exe --data-dir "D:\联智数据"` 显式选数据目录。两种发行方式的数据布局和格式相同：`workspaces/` 保存业务数据和按用户隔离的数据，`config/` 保存用户配置，`.runtime/` 保存窗口偏好、WebView 缓存、恢复暂存和更新文件，`logs/` 保存脱敏桌面日志。程序文件和用户数据分开。启动时持有数据目录锁；同一数据目录第二次启动唤醒已有窗口。

## 关闭和后台运行

普通最小化进入任务栏。点击关闭，空闲且没有未保存编辑时退出；任务仍在运行或有未保存编辑时提供返回应用、后台运行、停止任务并退出。桌面设置可开启「关闭窗口时进入托盘」。托盘提供打开窗口、设置、数据目录和退出；隐藏窗口不停止后端任务。后台任务完成显示简短通知，点击通知返回对应工作区和会话，正常认证与授权仍有效。

退出、备份、恢复或更新前，应用通过 `LocalLifecycle` 停止接受新操作。退出请求通过已有取消机制停止任务并等待收尾；无法确认结束时提示继续等待、返回或明确中断。中断后的任务由已有启动恢复机制记录为中断，不补造成功，不重跑结果未知的网络写入。

窗口和主题偏好保存在数据目录，内嵌浏览器关闭私密模式并使用明确的用户数据目录。主题支持浅色、深色和跟随 Windows。工作台在窄窗口仍可打开任务进度抽屉；网络图纸批注通过扩展后端保存，独立版本控制，不改变拓扑布局或拓扑版本。

## 数据迁移、备份和恢复

旧桌面目录旁的 `workspaces/`、`config/` 在新数据目录为空时自动复制校验，保留源目录，并用日志使中断迁移可继续。已存在的目标数据不会自动合并覆盖。也可在桌面设置选择旧程序或数据目录进行迁移；先退出旧程序。DPAPI 凭据依赖原 Windows 用户和机器；跨用户或跨机器迁移请在原用户下生成带凭据的加密备份。

启用应用认证后，数据目录、备份、恢复、迁移、诊断导出和应用更新要求已登录默认组织的管理员；原生桥接使用真实 HttpOnly 会话核验身份，不把前端报告的用户名当权限。备份只允许空闲且编辑已保存时创建。普通 ZIP 包含工作区和脱敏后的配置，不包含密钥存储。可选加密备份使用用户口令、Scrypt 和 Fernet；至少 12 个字符的口令，可显式包含凭据。带凭据备份在内存中解密后加密打包，恢复时重新用当前 Windows 用户的 DPAPI 保存，不把明文凭据写入暂存目录。请保存口令，应用不保存口令。

恢复先检查格式版本、大小、文件路径和每个文件的 SHA-256，然后暂存；确认后在重启时切换数据目录。原工作区与配置保留在 `.runtime/before-restore/`，恢复动作有可重试日志。普通备份缺少凭据时保留已有本地密钥存储。图纸、会话、批注随工作区备份。

导出使用原生文件选择对话框；桌面设置可打开最近导出目录。诊断 ZIP 只包含程序身份和脱敏桌面日志，不复制工作区正文、环境变量和供应商配置。

## 更新和回退

桌面设置从固定的 `zhangh05/lzcore` GitHub Releases 检查更新。`windows-update.json` 提供两种包的名称、数据格式、大小和 SHA-256；下载包经过校验后才可应用。带签名的发行包还校验 Windows 签名。用户保存编辑并结束任务后确认更新，外部 PowerShell 助手等待主程序自行退出后替换程序并重启。更新不修改工作区和配置；程序替换失败时保留数据，并尝试恢复已备份的程序文件。

更新后记录上一程序版本；「检查可回退版本」只接受同一数据格式且有更新清单的已发布版本。回退只替换程序，不能用来撤销用户数据。3.2.x 没有桌面更新清单，不能通过这一入口回退；旧版数据仍可迁移。发布提供 `SHA256SUMS.txt`，便于手动核对。

代码签名是可配置能力：GitHub Secrets `LZCORE_SIGNING_PFX`（PFX 的 Base64）与 `LZCORE_SIGNING_PASSWORD` 用于签主程序、安装器和卸载器；未配置时明确标记未签名，不宣称签名或 SmartScreen 信誉。

## 构建和验证

```powershell
python -m pip install -r requirements-desktop.lock
npm --prefix frontend ci
npm --prefix frontend run build
./scripts/download_webview2.ps1
python scripts/build_windows_exe.py --webview2-runtime $env:LZCORE_WEBVIEW2_DIR
```

发行工作流使用锁定的 Windows/Python 3.12 依赖。Inno Setup 生成每用户安装器，卸载保留用户数据，升级要求先退出程序。`scripts/windows_desktop_smoke.py` 启动真实 EXE，通过 WebView2 CDP 验证页面、桥接、主题、窗口缩放、托盘、第二次启动、原生导出对话框和 WebSocket；工作流同时验证安装、升级和卸载后数据保留。截图与启动报告在 `windows-desktop-validation` 构建产物中。

自动化 Windows runner 的结果不等同于 Windows 10/11 实体机、多个显示器及所有 DPI 的人工验收；这些场景仍需要目标机器复核。
