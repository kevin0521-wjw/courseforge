#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成安卓启动图标与启动屏（纯 PIL，不依赖 sharp / @capacitor-assets）。

真源是 web/icon-512.png（其上游是 web/icon.svg，与 make-icons.py 同一原则：
位图是派生产物）。产物直接覆盖 android/app/src/main/res 下的模板默认图。

生成内容：
- mipmap-*/ic_launcher.png / ic_launcher_round.png —— 传统启动器图标（round 加圆形蒙版）
- mipmap-*/ic_launcher_foreground.png —— 自适应图标前景（内容缩到中央 62%，留出安全区）
- drawable-{port,land}-*/splash.png —— 启动屏（纯色背景 + 居中图标）
- values/ic_launcher_background.xml —— 自适应图标背景色（与 PWA theme 保持一致）

用法：python tools/make-android-icons.py（需要 Pillow，与 make-icons.py 同解释器）
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "icon-512.png"
RES = ROOT / "android" / "app" / "src" / "main" / "res"

BG = (245, 247, 251, 255)  # #f5f7fb，与 manifest background_color 一致

# 密度 → (启动器图标边长, 自适应前景画布边长)
DENSITIES = {
    "mipmap-mdpi": (48, 108),
    "mipmap-hdpi": (72, 162),
    "mipmap-xhdpi": (96, 216),
    "mipmap-xxhdpi": (144, 324),
    "mipmap-xxxhdpi": (192, 432),
}
# 启动屏（宽, 高）：与 Capacitor 模板同尺寸，保证布局不出戏
SPLASH = {
    "drawable-port-mdpi": (320, 480), "drawable-land-mdpi": (480, 320),
    "drawable-port-hdpi": (480, 800), "drawable-land-hdpi": (800, 480),
    "drawable-port-xhdpi": (720, 960), "drawable-land-xhdpi": (960, 720),
    "drawable-port-xxhdpi": (960, 1600), "drawable-land-xxhdpi": (1280, 960),
    "drawable-port-xxxhdpi": (1280, 1920), "drawable-land-xxxhdpi": (1920, 1280),
}

icon = Image.open(SRC).convert("RGBA")


def composite_on_bg(size, inner_ratio, round_mask=False):
    """纯色底 + 居中缩放的图标；round_mask=True 时整体裁成圆形。"""
    canvas = Image.new("RGBA", (size, size), BG)
    inner = int(size * inner_ratio)
    scaled = icon.resize((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((size - inner) // 2, (size - inner) // 2))
    if round_mask:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        canvas.putalpha(mask)
    return canvas


for folder, (launcher, foreground) in DENSITIES.items():
    out = RES / folder
    out.mkdir(exist_ok=True)
    # 传统图标：图标本身已含圆角边距，放到 92% 即可
    composite_on_bg(launcher, 0.92).save(out / "ic_launcher.png")
    composite_on_bg(launcher, 0.92, round_mask=True).save(out / "ic_launcher_round.png")
    # 自适应前景：系统会自行裁切，内容必须缩进中央安全区（约 66/108）
    composite_on_bg(foreground, 0.62).save(out / "ic_launcher_foreground.png")
    print("mipmap:", folder)

for folder, (w, h) in SPLASH.items():
    out = RES / folder
    out.mkdir(exist_ok=True)
    canvas = Image.new("RGBA", (w, h), BG)
    side = int(min(w, h) * 0.28)  # 启动屏图标占短边约 28%
    scaled = icon.resize((side, side), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((w - side) // 2, (h - side) // 2))
    canvas.convert("RGB").save(out / "splash.png")
    print("splash:", folder)

# 自适应图标背景色
(RES / "values" / "ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    "<resources>\n"
    '    <color name="ic_launcher_background">#F5F7FB</color>\n'
    "</resources>\n",
    encoding="utf-8",
)
print("bg color -> #F5F7FB")
