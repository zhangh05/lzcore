#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
跨平台 Windows 桌面构建辅助脚本 (scripts/build_windows_exe.py)

用法:
    python scripts/build_windows_exe.py [--zip] [--clean]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 确保在 Windows 控制台或 CI (cp1252/gbk) 环境下中文日志输出不报错
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def run_cmd(cmd, cwd=ROOT):
    print(f"[*] 执行命令: {' '.join(str(c) for c in cmd)}")
    result = subprocess.run(cmd, cwd=str(cwd))
    if result.returncode != 0:
        print(f"[ERROR] 命令执行失败 (退出码: {result.returncode})")
        sys.exit(result.returncode)


def prefabricate_workspace_and_config(exe_dir: Path):
    """预置纯净默认工作区骨架与基础配置（不含任何业务数据，确保解压即有目录、前端开箱即交互）"""
    print(f"[*] 正在为分发目录预置 workspaces 与 config 骨架: {exe_dir}")
    ws_root = exe_dir / "workspaces"

    # 1. 创建纯净默认工作区基础目录结构
    dirs_to_create = [
        ws_root / "catalog" / "default" / "sys",
        ws_root / "default" / "sys",
        ws_root / "default" / "index",
        ws_root / "default" / "runs",
        ws_root / "default" / "sessions",
        ws_root / "default" / "files" / "data",
        ws_root / "default" / "files" / "tmp",
        ws_root / "default" / "inbox",
        ws_root / "default" / "extensions" / "network_operations" / "topologies",
        ws_root / "default" / "extensions" / "network_operations" / "devices",
        ws_root / "default" / "extensions" / "network_operations" / "connections",
        ws_root / "default" / "extensions" / "network_operations" / "regions",
    ]
    for d in dirs_to_create:
        d.mkdir(parents=True, exist_ok=True)

    # 2. 写入标准系统元数据（纯净空状态，几十字节）
    now_ts = time.time()
    workspace_yaml_content = f"id: default\nname: default\ncreated: {now_ts}\n"
    state_json_content = json.dumps({
        "workspace_id": "default",
        "organization_id": "default",
        "name": "default",
        "last_run_id": "",
        "last_intent": "",
        "last_result_summary": "",
        "last_result_counts": {},
        "last_manual_review_samples": [],
        "last_unsupported_samples": [],
        "last_audit_summary": {},
        "current_files": [],
        "current_artifacts": [],
        "llm_metadata": {},
        "runs_count": 0,
        "memory_count": 0,
        "artifacts_count": 0,
        "updated_at": "",
    }, indent=2, ensure_ascii=False)

    (ws_root / "catalog" / "default" / "sys" / "workspace.yaml").write_text(workspace_yaml_content, encoding="utf-8")
    (ws_root / "catalog" / "default" / "sys" / "state.json").write_text(state_json_content, encoding="utf-8")
    (ws_root / "default" / "sys" / "workspace.yaml").write_text(workspace_yaml_content, encoding="utf-8")
    (ws_root / "default" / "sys" / "state.json").write_text(state_json_content, encoding="utf-8")

    # 3. 写入空索引文件
    for index_name in ["files.jsonl", "references.jsonl", "artifacts.jsonl"]:
        idx_file = ws_root / "default" / "index" / index_name
        if not idx_file.exists():
            idx_file.write_text("", encoding="utf-8")

    # 4. 复制基础配置目录
    dist_config_dir = exe_dir / "config"
    src_config_dir = ROOT / "config"
    if src_config_dir.is_dir():
        if dist_config_dir.is_dir():
            shutil.rmtree(dist_config_dir)
        shutil.copytree(src_config_dir, dist_config_dir)
        for lock in dist_config_dir.glob("*.lock"):
            lock.unlink(missing_ok=True)

    # 5. 校验：确保目录绝对真实存在于 exe_dir 中，若不满足则直接报错中断，绝不打出残缺包！
    expected_yaml = ws_root / "default" / "sys" / "workspace.yaml"
    expected_topos = ws_root / "default" / "extensions" / "network_operations" / "topologies"
    if not expected_yaml.is_file():
        raise RuntimeError(f"预置工作区失败：未找到 {expected_yaml}")
    if not expected_topos.is_dir():
        raise RuntimeError(f"预置工作区失败：未找到 {expected_topos}")
    if not dist_config_dir.is_dir():
        raise RuntimeError(f"预置配置目录失败：未找到 {dist_config_dir}")

    print(f"[SUCCESS] 纯净工作区与配置文件预置成功！已就绪于: {ws_root}")


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
    print(f"\n[SUCCESS] PyInstaller 构建完成！产物目录: {exe_dir}")

    # 4. 预置纯净默认工作区骨架与基础配置（不含任何私有业务数据，确保解压即有目录、前端开箱即交互）
    prefabricate_workspace_and_config(exe_dir)

    # 5. 可选打包 zip
    if args.zip:
        try:
            from agent import __version__ as APP_VERSION
        except Exception:
            APP_VERSION = "3.1.2"
        zip_name = f"lzcore-v{APP_VERSION}-windows-desktop"
        zip_out = ROOT / "dist" / zip_name
        print(f"[*] 正在打包压缩文件: {zip_out}.zip ...")
        shutil.make_archive(str(zip_out), "zip", root_dir=str(ROOT / "dist"), base_dir="lzcore")
        print(f"[SUCCESS] 压缩包已生成: {zip_out}.zip")


if __name__ == "__main__":
    main()
