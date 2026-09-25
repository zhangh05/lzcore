@echo off
setlocal EnableExtensions
title 联智中枢 Windows 桌面程序编译构建脚本 (Build LZCore Desktop EXE)

echo ======================================================================
echo          联智中枢 - Windows 原生桌面程序 (.exe) 打包构建工具
echo ======================================================================
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

:: 1. 检查 Python 环境
where python.exe >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 未找到 Python，请确保已安装 Python 3.12+ 并已添加到系统环境变量 PATH 中。
    goto :FAIL
)

:: 2. 检查 Node.js 环境 (构建前端)
where npm.cmd >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARN] 未找到 npm 命令。将尝试使用已存在的 frontend/dist 编译产物。
    if not exist "%ROOT%frontend\dist\index.html" (
        echo [ERROR] 未检测到前端构建产物 frontend\dist\index.html，且未安装 Node.js。无法继续构建。
        goto :FAIL
    )
) else (
    echo [*] 正在编译前端单页应用 (npm run build)...
    call npm --prefix frontend run build
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] 前端构建失败。
        goto :FAIL
    )
    echo [*] 前端构建成功完成！
)

:: 3. 检查并安装打包工具依赖
echo.
echo [*] 检查 Python 打包依赖 (pywebview, pyinstaller)...
python -m pip install --quiet --disable-pip-version-check pywebview pyinstaller
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 安装打包依赖失败。
    goto :FAIL
)

:: 4. 执行 PyInstaller 编译
echo.
echo [*] 开始执行 Windows .exe 编译打包...
python -m PyInstaller lzcore.spec --clean -y
if %ERRORLEVEL% neq 0 (
    echo [ERROR] PyInstaller 编译失败，请检查上方日志。
    goto :FAIL
)

echo.
echo ======================================================================
echo [SUCCESS] 联智中枢 Windows 桌面程序构建成功！
echo.
echo 输出目录: %ROOT%dist\lzcore
echo 主程序:   %ROOT%dist\lzcore\lzcore.exe
echo.
echo 说明:
echo   - 这是一个绿色便携版桌面应用，双击 lzcore.exe 即可直接打开原生窗口。
echo   - 数据和图纸自动持久化在 lzcore.exe 旁的 workspaces 目录中。
echo   - 整个 dist\lzcore 文件夹可压缩为 zip 发送给任何 Windows 电脑直接运行。
echo ======================================================================
goto :END

:FAIL
echo.
echo [!] 构建未能完成，请根据提示解决问题后重试。
pause
exit /b 1

:END
if not "%CI%"=="true" pause
exit /b 0
