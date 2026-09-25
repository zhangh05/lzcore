# 联智中枢（LZCore）Windows 运行与交付指南

> **Enterprise Windows Standalone Desktop & Headless Server Operations Guide**
> 本指南系统介绍联智中枢在 Windows 操作系统上的两种企业级部署形态：**独立桌面端原生应用（Standalone Desktop App）** 与 **无头后台守护进程（Headless Server Service）**。

---

## 1. Windows 交付形态与核心优势

在企业网络运维现场，工程师经常面临严苛的保密隔离或无法接入公网的环境，常规安装往往受到主机缺少 Python 或 Node.js 编译工具链的巨大制约。

联智中枢针对 Windows 平台提供了深度的工业级优化：
1. **免安装与便携式运行时**：
   Windows 发行运行不要求用户另行安装开发环境；发行包使用 `runtime\python\python.exe` 和 `runtime\node\node.exe` 提供所需运行时，做到双击即用。
2. **预制纯净工作区骨架**：
   发行压缩包（`lzcore-v3.1.0-windows-desktop.zip`）已内置合规且纯净的 `workspaces/` 与 `config/` 目录结构。用户初次解压即可直接建立拓扑与文件交互，同时确保绝无开发者的私有数据外溢。
3. **回环原生安全屏障**：
   严格默认绑定至本机回环地址（`127.0.0.1`），结合受保护的进程间通信，彻底杜绝未经授权的局域网端口探测风险。

---

## 2. 形态 A：独立桌面端原生应用 (Desktop App)

针对运维人员的单兵作战或日常拓扑绘制，系统提供了基于 PySide6 / Webview2 原生壳体的桌面应用。

### 2.1 启动与执行架构
```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │ 桌面主进程: desktop.py / lzcore.exe                                    │
 │ ├─ 1. 初始化环境变量 (LZCORE_EMBEDDED_WORKER=true, 绑定 127.0.0.1)     │
 │ ├─ 2. 嵌入式启动工作进程与异步作业调度器 (Embedded Worker Thread)     │
 │ ├─ 3. 探活后端健康检查接口: http://127.0.0.1:8011/api/health            │
 │ ├─ 4. 加载前端静态资产工作台 (http://127.0.0.1:5273)                   │
 │ └─ 5. 渲染原生 GUI 视窗并接管崩溃安全弹窗 (HTML Escaped Crash Dialog) │
 └────────────────────────────────────────────────────────────────────────┘
```

### 2.2 运行与操作
- **双击启动**：解压发行包后，双击运行根目录下的 `lzcore.exe` 即可直接拉起全功能运维工作台。
- **白板与拓扑持久化**：桌面端拓扑画布内建本地白板演示层，笔迹与便签按拓扑 ID 自动持久化于本地轻量存储中，刷新页面或切换视图绝不丢失标注。
- **崩溃防护与安全转义**：若底层端口冲突或初始化失败，主进程将捕获的物理异常文本进行严格的 HTML 安全转义，在原生对话框中清晰指引排查日志（`lzcore_desktop.log`），杜绝界面静默卡死。

---

## 3. 形态 B：无头服务器与守护脚本 (Headless Server)

若需在 Windows Server 服务器上作为无人值守后台服务运行，仓库根目录提供了功能完备的自动化脚本：
- **PowerShell 入口**：`start.ps1` 与 `stop.ps1`
- **传统批处理入口**：`start.bat` 与 `stop.bat`

它们与 Linux / macOS 上的 `start.sh` 和 `stop.sh` 遵循完全一致的端口、认证和进程生命周期约定。

### 3.1 启动与停止操作

**使用 PowerShell 启动**：
```powershell
# 切换至解压或克隆的根目录
.\start.ps1

# 若仅执行自检探针而不自动打开默认浏览器：
.\start.ps1 -NoBrowser -ValidateOnly
```

**停止运行**：
```powershell
.\stop.ps1
```

**默认端点**：
- 前端工作台交互入口：`http://127.0.0.1:5273`
- 后端服务健康检查探针：`http://127.0.0.1:8011/api/health`
- WebSocket 实时流通道：`ws://127.0.0.1:8011/ws/agent`

---

## 4. 安全配置与网络准入边界

1. **拒绝无认证公网暴露**：
   启动脚本与后端服务默认仅监听 `127.0.0.1` 回环接口。若在 `config/` 中显式指定监听外部局域网地址（如 `0.0.0.0` 或物理网卡 IP），系统强制要求在配置中启用 API Token、密码认证或接入企业 OIDC 身份源。未经认证的外部网络监听将被平台安全门禁强行拒绝。
2. **原子文件持久化策略**：
   在 Windows 文件系统（NTFS）下，多进程直接覆写可能触发 `Access Denied` 锁冲突。LZCore 在底层 `storage/` 存储层采用了经 Windows 契约测试验证的原子临时写入与安全替换策略，杜绝使用可能导致文件句柄锁死的非安全操作。

---

## 5. 源码构建与发行包制作 (Packaging)

若需要从源代码重新编译打包 Windows 原生 EXE 与离线绿色包：

```powershell
# 1. 运行 Windows 契约自动化测试套件
.venv/Scripts/pytest harness/test_windows_runtime_contract.py

# 2. 执行桌面端自动化编译打包脚本
python scripts/build_windows_exe.py
```

构建脚本将自动聚合前端静态编译产物、后端微服务、离线依赖缓存与原生桌面壳体，生成自包含的部署制品。
