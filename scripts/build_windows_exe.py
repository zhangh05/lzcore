#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
跨平台 Windows 桌面构建辅助脚本 (scripts/build_windows_exe.py)

用法:
    python scripts/build_windows_exe.py [--zip] [--clean]
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

# 确保在 Windows 控制台或 CI (cp1252/gbk) 环境下中文日志输出不报错
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent


def run_cmd(cmd, cwd=ROOT):
    print(f"[*] 执行命令: {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, cwd=str(cwd))
    if result.returncode != 0:
        print(f"[ERROR] 命令执行失败 (退出码: {result.returncode})")
        sys.exit(result.returncode)


def main():
    parser = argparse.ArgumentParser(description="编译联智中枢桌面程序")
    parser.add_argument("--zip", action="store_true", help="构建完成后自动打包为 zip 压缩包")
    parser.add_argument("--clean", action="store_true", help="构建前清理旧产物")
    args = parser.parse_args()

    os.chdir(ROOT)

    if args.clean:
        print("[*] 清理旧构建产物...")
        for p in [ROOT / "build", ROOT / "dist"]:
            if p.exists():
                shutil.rmtree(p)

    # 1. 检查/构建前端
    dist_index = ROOT / "frontend" / "dist" / "index.html"
    if not dist_index.is_file():
        print("[*] 前端产物不存在，执行构建...")
        run_cmd(["npm", "--prefix", "frontend", "run", "build"])
    else:
        print("[*] 前端构建产物已就绪。")

    # 2. 检查图标
    ico_path = ROOT / "lzcore.ico"
    if not ico_path.is_file():
        print("[*] 生成应用图标 lzcore.ico...")
        from PIL import Image, ImageDraw
        img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle([16, 16, 240, 240], radius=48, fill=(14, 116, 144, 255))
        draw.ellipse([88, 88, 168, 168], outline=(255, 255, 255, 255), width=12)
        draw.ellipse([112, 112, 144, 144], fill=(255, 255, 255, 255))
        img.save(ico_path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])

    # 3. 执行 PyInstaller
    spec_path = ROOT / "lzcore.spec"
    if not spec_path.is_file():
        print(f"[ERROR] 未找到 {spec_path}")
        sys.exit(1)

    print("[*] 开始执行 PyInstaller 打包...")
    run_cmd([sys.executable, "-m", "PyInstaller", str(spec_path), "--clean", "-y"])

    exe_dir = ROOT / "dist" / "lzcore"
    print(f"\n[SUCCESS] 构建完成！产物目录: {exe_dir}")

    # 4. 可选打包 zip
    if args.zip:
        try:
            from agent import __version__ as APP_VERSION
        except Exception:
            APP_VERSION = "3.1.0"
        zip_name = f"lzcore-v{APP_VERSION}-windows-desktop"
        zip_out = ROOT / "dist" / zip_name
        print(f"[*] 正在打包压缩文件: {zip_out}.zip ...")
        shutil.make_archive(str(zip_out), "zip", root_dir=str(ROOT / "dist"), base_dir="lzcore")
        print(f"[SUCCESS] 压缩包已生成: {zip_out}.zip")


if __name__ == "__main__":
    main()
