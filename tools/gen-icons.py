#!/usr/bin/env python3
"""生成 IF TERMINAL 的 PWA 图标。

与 public/index.html 内联 favicon 使用同一套品牌图形(三根信号柱), 保证视觉一致。
图形在 32x32 坐标系中定义, 与 SVG 逐像素对应。

依赖: Pillow   →  pip install Pillow
用法:           python tools/gen-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"

BG = (6, 9, 15)  # #06090f 与终端底色一致
BARS = [  # (x, y, w, h, color) —— 与 index.html 的 favicon SVG 完全一致
    (6, 14, 4, 12, (255, 87, 87)),    # #ff5757
    (14, 8, 4, 18, (255, 176, 46)),   # #ffb02e
    (22, 12, 4, 14, (31, 201, 142)),  # #1fc98e
]


def render(size: int, *, rounded: bool, logo_scale: float) -> Image.Image:
    """圆角(或满幅)底色 + 三根柱子; 4x 超采样后缩放, 边缘更干净。"""
    ss = 4
    px = size * ss
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw.rounded_rectangle([0, 0, px - 1, px - 1], radius=int(px * 0.19), fill=BG)
    else:
        draw.rectangle([0, 0, px - 1, px - 1], fill=BG)

    unit = px / 32.0 * logo_scale          # 32 坐标系 → 像素
    ox, oy = px / 2 - 16 * unit, px / 2 - 17 * unit   # 图形中心位于 (16, 17)
    radius = max(2, int(unit * 1.1))
    for x, y, w, h, color in BARS:
        draw.rounded_rectangle(
            [ox + x * unit, oy + y * unit, ox + (x + w) * unit, oy + (y + h) * unit],
            radius=radius,
            fill=color,
        )
    return img.resize((size, size), Image.LANCZOS)


JOBS = [
    # 文件名, 尺寸, 是否圆角, 图形缩放
    ("icon-192.png", 192, True, 0.95),
    ("icon-512.png", 512, True, 0.95),
    ("icon-maskable-512.png", 512, False, 0.78),  # 满幅底色 + 图形收进 maskable 安全区
    ("icon-180.png", 180, False, 0.95),           # apple-touch-icon (iOS 自行裁圆角)
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, rounded, scale in JOBS:
        img = render(size, rounded=rounded, logo_scale=scale)
        img.save(OUT / name, "PNG", optimize=True)
        print(f"{name}: {size}x{size} {img.mode} {(OUT / name).stat().st_size} B")


if __name__ == "__main__":
    main()
