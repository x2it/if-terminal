#!/usr/bin/env python3
"""打包 IF TERMINAL 发布产物: 便携 zip + npm tarball。

为什么不用 PowerShell 的 Compress-Archive?
  .NET Framework 版 Compress-Archive 会把 zip 条目分隔符写成反斜杠, 而 ZIP 规范
  要求的是 '/'; Linux/macOS 用 unzip 解压会得到形如 "if-terminal-1.0.0\\server.js"
  的怪名字(甚至整包失败)。这里用标准库 zipfile 保证 '/' 分隔符, 并固定条目顺序,
  使同样的源码产出可复现的包。

用法:
    python tools/package.py                 # 输出到 <repo>/dist/
    python tools/package.py --out D:\\w3b     # 指定输出目录
    python tools/package.py --no-npm        # 只出 zip, 跳过 npm pack
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "dist", "__pycache__", ".idea", ".vscode"}
SKIP_SUFFIXES = {".zip", ".tgz", ".log"}


def collect_files() -> list[Path]:
    """按稳定顺序收集待打包文件, 排除版本控制/依赖/产物/编辑器目录。"""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if p.suffix.lower() in SKIP_SUFFIXES:
                continue
            out.append(p)
    return out


def build_zip(out_dir: Path, version: str) -> Path:
    top = f"if-terminal-{version}"
    zip_path = out_dir / f"{top}.zip"
    files = collect_files()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            # 必须显式指定 arcname 且以 '/' 分隔 —— 这是本脚本存在的理由
            z.write(p, f"{top}/{p.relative_to(ROOT).as_posix()}")
    # 自检: 不允许任何反斜杠条目
    with zipfile.ZipFile(zip_path) as z:
        bad = [n for n in z.namelist() if "\\" in n]
        if bad:
            raise SystemExit(f"打包失败: 出现反斜杠条目 {bad[:3]}")
        print(f"  {zip_path.name}  {zip_path.stat().st_size / 1024:.1f} KB  {len(z.namelist())} 条目")
    return zip_path


def build_npm_tarball(out_dir: Path, version: str) -> Path | None:
    npm = shutil.which("npm")
    if not npm:
        print("  跳过 npm pack (未找到 npm)")
        return None
    r = subprocess.run([npm, "pack", "--pack-destination", str(out_dir)],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  跳过 npm pack ({r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'unknown error'})")
        return None
    tgz = out_dir / f"if-terminal-{version}.tgz"
    if not tgz.exists():
        print("  跳过 npm pack (未生成 tgz)")
        return None
    print(f"  {tgz.name}  {tgz.stat().st_size / 1024:.1f} KB")
    return tgz


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="打包 IF TERMINAL 发布产物")
    ap.add_argument("--out", default=str(ROOT / "dist"), help="输出目录 (默认 <repo>/dist)")
    ap.add_argument("--no-npm", action="store_true", help="跳过 npm pack")
    args = ap.parse_args()

    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"IF TERMINAL v{version} → {out_dir}")
    artifacts = [build_zip(out_dir, version)]
    if not args.no_npm:
        tgz = build_npm_tarball(out_dir, version)
        if tgz:
            artifacts.append(tgz)

    print("sha256:")
    for a in artifacts:
        print(f"  {a.name}  {sha256(a)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
